// The only native-only code in this app. Everything else is the shared web app,
// which `npm test` covers on the same bytes iOS ships.
//
// See docs/IOS-HANDOFF.md before changing anything here. It records the device-
// only checks and the reasons behind the location, audio, and screen-awake
// lifecycle decisions below.
import AVFoundation
import Capacitor
import CoreLocation
import UIKit
#if canImport(ActivityKit)
import ActivityKit
#endif

@objc(BridgeViewController)
final class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        lockWebPageScale()
        bridge?.registerPluginInstance(NativeNavigationPlugin())
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Reset a scale left behind by an interrupted system gesture or an
        // older build, then keep WKWebView's own page pinch disabled. MapLibre
        // handles its map pinch in JavaScript, so map zoom remains available.
        lockWebPageScale()
    }

    private func lockWebPageScale() {
        guard let webView else { return }
        let scrollView = webView.scrollView
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 1
        scrollView.setZoomScale(1, animated: false)
        scrollView.pinchGestureRecognizer?.isEnabled = false
    }
}

@objc(NativeNavigationPlugin)
final class NativeNavigationPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate,
                                   AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private struct RoutePoint {
        let latitude: Double
        let longitude: Double
        let distanceM: Double
        let roadName: String
    }

    private struct RouteInstruction {
        let distanceM: Double
        let text: String
        // The lock-screen Live Activity's glance line and arrow, resolved by
        // the web layer with the same thresholds as the in-app banner so the
        // two can never disagree. Empty on payloads from an older web build.
        let headline: String
        let arrow: String
        var approachHandled = false
        var aheadHandled = false
        var immediateHandled = false
    }

    let identifier = "NativeNavigationPlugin"
    let jsName = "NativeNavigation"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateVoiceSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setScreenAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeaking", returnType: CAPPluginReturnPromise)
    ]

    private let locationManager = CLLocationManager()
    // Creating AVSpeechSynthesizer immediately queries installed voice assets
    // and sandbox extensions. That is needless work on every map-only launch
    // and is especially visible while a fresh simulator/device is still
    // warming its caches, so do it at the first real spoken prompt instead.
    private lazy var speechSynthesizer: AVSpeechSynthesizer = {
        let synthesizer = AVSpeechSynthesizer()
        synthesizer.delegate = self
        return synthesizer
    }()
    private var webSpeechIDs: [ObjectIdentifier: Int] = [:]
    private var tracking = false
    // A requestLocation() one-shot is pending on the shared manager. Apple's
    // requestLocation() STOPS continuous updates on that manager when it
    // completes, so a one-shot that overlaps a ride must be followed by
    // re-asserting the watch -- see requestOneShotFix() and the delegate.
    private var oneShotRequestInFlight = false
    private var pendingStartCall: CAPPluginCall?
    private var pendingPositionCalls: [String: CAPPluginCall] = [:]
    private var pendingPositionTimeouts: [String: DispatchWorkItem] = [:]
    private var pendingPositionRetry: DispatchWorkItem?
    private var route: [RoutePoint] = []
    private var instructions: [RouteInstruction] = []
    private var destinationName = "your destination"
    // Held as Any so the plugin class stays valid below iOS 16.2; only the
    // @available helpers below ever touch it.
    private var navigationActivity: Any?
    private var lastActivityHeadline = ""
    private var nearestRouteSegment: Int?
    private var lastFullRouteSearchAt = Date.distantPast
    private var offRouteFixes = 0
    private var offRouteCandidateStartedAt: Date?
    private var offRoute = false
    private var offRouteApproachSpoken = false
    private var lastOffRoutePromptAt = Date.distantPast
    private var previousLocation: CLLocation?
    private var speakHeadings = true
    private var statusUpdateIntervalS: TimeInterval = 0
    private var statusRoute = true
    private var statusSpeed = true
    private var statusMiles = true
    private var statusEta = true
    private var routeTotalTimeS: TimeInterval = 0
    private var lastVoiceAt = Date()
    private var statusUpdateTimer: Timer?
    private var latestLocation: CLLocation?
    private var arrived = false
    private var latestLocationPayload: [String: Any]?
    private let offRouteEnterM = 65.0
    private let offRouteRejoinM = 40.0
    private let offRouteGoodAccuracyM = 60.0
    private let offRouteMaxAccuracyM = 120.0
    private let offRouteCandidateWindowS = 40.0
    // Keep a completed maneuver briefly for GPS projection jitter, but never
    // for the old fixed 60 m. That delay hid the following turn for most of a
    // city block, in both the foreground banner and locked-screen guidance.
    private let maneuverPassedHoldMinM = 8.0
    private let maneuverPassedHoldMaxM = 15.0

    override func load() {
        locationManager.delegate = self
        locationManager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locationManager.distanceFilter = 3
        locationManager.activityType = .fitness
        locationManager.pausesLocationUpdatesAutomatically = false
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        statusUpdateTimer?.invalidate()
        pendingPositionRetry?.cancel()
        pendingPositionTimeouts.values.forEach { $0.cancel() }
    }

    // CLLocationManager.locationServicesEnabled() can block, and Apple documents
    // that calling it on the main thread may hang the app. Every entry point
    // here did, inside a DispatchQueue.main.async -- so the hang landed on the
    // two moments that matter most: opening the app and starting navigation.
    private func requireLocationServices(_ call: CAPPluginCall, then body: @escaping () -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let enabled = CLLocationManager.locationServicesEnabled()
            DispatchQueue.main.async {
                guard enabled else {
                    call.reject("Location Services are disabled on this iPhone.")
                    return
                }
                body()
            }
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            let enabled = CLLocationManager.locationServicesEnabled()
            DispatchQueue.main.async {
                call.resolve([
                    "servicesEnabled": enabled,
                    "authorization": self.authorizationName(self.locationManager.authorizationStatus),
                    "accuracy": self.accuracyName(self.locationManager.accuracyAuthorization),
                    "tracking": self.tracking
                ])
            }
        }
    }

    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        requireLocationServices(call) {
            switch self.locationManager.authorizationStatus {
            case .denied, .restricted:
                call.reject("Location permission is blocked. Enable it in Settings.")
            case .notDetermined:
                self.queuePositionCall(call)
                self.locationManager.requestWhenInUseAuthorization()
            case .authorizedAlways, .authorizedWhenInUse:
                self.queuePositionCall(call)
                self.requestOneShotFix()
            @unknown default:
                call.reject("Location authorization is unavailable.")
            }
        }
    }

    /// A one-shot fix that never disturbs an active ride.
    ///
    /// requestLocation() stops continuous updates on the SAME manager when it
    /// completes. The planning layer polls getCurrentPosition for a while
    /// after a trip is planned (refining a coarse first fix), so a poll that
    /// overlapped Navigate silently killed background tracking: the app
    /// "paused" in the background and voice guidance stopped (field report).
    /// While tracking, the continuous stream itself resolves queued position
    /// calls on the next fix, so no one-shot is needed at all.
    private func requestOneShotFix() {
        guard !tracking else { return }
        oneShotRequestInFlight = true
        locationManager.requestLocation()
    }

    @objc func startTracking(_ call: CAPPluginCall) {
        requireLocationServices(call) {
            self.configureRoute(from: call)
            guard self.route.count >= 2 else {
                call.reject("A route with at least two points is required for navigation.")
                return
            }
            switch self.locationManager.authorizationStatus {
            case .denied, .restricted:
                call.reject("Location permission is blocked. Enable it in Settings.")
            case .notDetermined:
                self.pendingStartCall?.reject("Navigation start was replaced by a newer request.")
                self.pendingStartCall = call
                self.locationManager.requestWhenInUseAuthorization()
            case .authorizedWhenInUse, .authorizedAlways:
                self.beginTracking()
                call.resolve(self.statusPayload())
            @unknown default:
                call.reject("Location authorization is unavailable.")
            }
        }
    }

    @objc func stopTracking(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pendingStartCall?.reject("Navigation start was cancelled.")
            self.pendingStartCall = nil
            self.endTracking()
            call.resolve()
        }
    }

    /// Everything that ends a ride, in one place.
    ///
    /// There are two ways a ride finishes and they used to do different
    /// things: stopTracking() -- the web layer asking -- tore the session
    /// down, while arrival, which this guide decides for itself, set a flag,
    /// spoke one sentence and stopped nothing at all. With the screen locked
    /// the web layer is suspended and never sees the arrival, so nobody ever
    /// called stopTracking, and the guide carried on giving directions to a
    /// rider who had already finished.
    private func endTracking() {
        tracking = false
        stopStatusUpdateTimer()
        locationManager.stopUpdatingLocation()
        locationManager.allowsBackgroundLocationUpdates = false
        locationManager.showsBackgroundLocationIndicator = false
        UIApplication.shared.isIdleTimerDisabled = false
        clearRouteGuidance()
    }

    @objc func updateVoiceSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.configureVoiceSettings(from: call)
            self.refreshStatusUpdateTimer()
            call.resolve()
        }
    }

    @objc func setScreenAwake(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = call.getBool("enabled") ?? false
            call.resolve()
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else {
            call.reject("Speech text is required.")
            return
        }
        DispatchQueue.main.async {
            self.speakText(
                text,
                language: call.getString("language") ?? "en-US",
                webSpeechID: call.getInt("speechId")
            )
            call.resolve()
        }
    }

    @objc func stopSpeaking(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.speechSynthesizer.stopSpeaking(at: .immediate)
            try? AVAudioSession.sharedInstance().setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
            call.resolve()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        DispatchQueue.main.async {
            switch manager.authorizationStatus {
            case .authorizedAlways, .authorizedWhenInUse:
                if !self.pendingPositionCalls.isEmpty {
                    self.requestOneShotFix()
                }
                if let call = self.pendingStartCall {
                    self.pendingStartCall = nil
                    self.beginTracking()
                    call.resolve(self.statusPayload())
                }
            case .denied, .restricted:
                let message = "Location permission is blocked. Enable it in Settings."
                self.pendingStartCall?.reject(message)
                self.pendingStartCall = nil
                self.rejectPendingPositionCalls(message)
                self.notifyListeners("locationError", data: [
                    "code": 1,
                    "message": message
                ], retainUntilConsumed: true)
            case .notDetermined:
                break
            @unknown default:
                break
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        // A completing one-shot stops continuous updates. If a ride is on --
        // a request that was already pending when Navigate was tapped -- put
        // the watch back before it is missed.
        if oneShotRequestInFlight {
            oneShotRequestInFlight = false
            if tracking {
                locationManager.startUpdatingLocation()
            }
        }
        latestLocation = location
        let payload = locationPayload(location)
        latestLocationPayload = payload
        resolvePendingPositionCalls(payload)
        if tracking {
            updateNativeGuidance(location)
            // WKWebView JavaScript is suspended while the phone is locked.
            // Avoid queueing bridge work that cannot run; the native guide
            // handles prompts and the latest fix is delivered on foreground.
            if UIApplication.shared.applicationState == .active {
                notifyListeners("location", data: payload)
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // A one-shot can end in failure too, with the same implicit stop of
        // continuous updates; a ride that is on gets its watch back first.
        if oneShotRequestInFlight {
            oneShotRequestInFlight = false
            if tracking {
                locationManager.startUpdatingLocation()
            }
        }
        // Core Location commonly emits locationUnknown while the radio is
        // warming up, then delivers a valid fix a moment later. It is explicitly
        // transient; rejecting here made a second tap two seconds later work
        // even though the first request should simply have kept waiting.
        if (error as? CLError)?.code == .locationUnknown,
           !pendingPositionCalls.isEmpty {
            schedulePendingPositionRetry()
            return
        }
        rejectPendingPositionCalls(error.localizedDescription)
        if tracking {
            notifyListeners("locationError", data: [
                "code": (error as? CLError)?.code.rawValue ?? 2,
                "message": error.localizedDescription
            ], retainUntilConsumed: true)
        }
    }

    private func beginTracking() {
        tracking = true
        locationManager.allowsBackgroundLocationUpdates = true
        locationManager.showsBackgroundLocationIndicator = true
        locationManager.startUpdatingLocation()
        refreshStatusUpdateTimer()
        startNavigationActivity()
        if locationManager.authorizationStatus == .authorizedWhenInUse {
            locationManager.requestAlwaysAuthorization()
        }
    }

    private func queuePositionCall(_ call: CAPPluginCall) {
        guard let callbackID = call.callbackId else {
            call.reject("Location request could not be tracked.")
            return
        }
        pendingPositionTimeouts[callbackID]?.cancel()
        pendingPositionCalls[callbackID] = call
        let requestedTimeout = call.getInt("timeoutMs") ?? 15_000
        let timeoutMs = max(1_000, min(60_000, requestedTimeout))
        let timeout = DispatchWorkItem { [weak self] in
            guard let self,
                  let pending = self.pendingPositionCalls.removeValue(forKey: callbackID) else {
                return
            }
            self.pendingPositionTimeouts.removeValue(forKey: callbackID)
            if self.pendingPositionCalls.isEmpty {
                self.pendingPositionRetry?.cancel()
                self.pendingPositionRetry = nil
            }
            pending.reject("Timed out waiting for a usable location.")
        }
        pendingPositionTimeouts[callbackID] = timeout
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(timeoutMs),
            execute: timeout
        )
    }

    private func schedulePendingPositionRetry() {
        pendingPositionRetry?.cancel()
        let retry = DispatchWorkItem { [weak self] in
            guard let self, !self.pendingPositionCalls.isEmpty else { return }
            self.pendingPositionRetry = nil
            self.requestOneShotFix()
        }
        pendingPositionRetry = retry
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(750), execute: retry)
    }

    private func resolvePendingPositionCalls(_ payload: [String: Any]) {
        pendingPositionRetry?.cancel()
        pendingPositionRetry = nil
        let calls = Array(pendingPositionCalls.values)
        pendingPositionCalls.removeAll()
        pendingPositionTimeouts.values.forEach { $0.cancel() }
        pendingPositionTimeouts.removeAll()
        calls.forEach { $0.resolve(payload) }
    }

    private func rejectPendingPositionCalls(_ message: String) {
        pendingPositionRetry?.cancel()
        pendingPositionRetry = nil
        let calls = Array(pendingPositionCalls.values)
        pendingPositionCalls.removeAll()
        pendingPositionTimeouts.values.forEach { $0.cancel() }
        pendingPositionTimeouts.removeAll()
        calls.forEach { $0.reject(message) }
    }

    @objc private func appDidBecomeActive() {
        guard tracking, let payload = latestLocationPayload else { return }
        notifyListeners("location", data: payload)
    }

    private func configureRoute(from call: CAPPluginCall) {
        configureVoiceSettings(from: call)
        routeTotalTimeS = max(0, call.getDouble("routeTotalTimeS") ?? 0)
        route = (call.getArray("route", JSObject.self) ?? []).compactMap { point in
            guard let latitude = point["latitude"] as? Double,
                  let longitude = point["longitude"] as? Double,
                  let distanceM = point["distanceM"] as? Double else { return nil }
            return RoutePoint(
                latitude: latitude,
                longitude: longitude,
                distanceM: distanceM,
                roadName: point["roadName"] as? String ?? ""
            )
        }
        instructions = (call.getArray("instructions", JSObject.self) ?? []).compactMap { item in
            guard let distanceM = item["distanceM"] as? Double,
                  let text = item["text"] as? String,
                  !text.isEmpty else { return nil }
            return RouteInstruction(
                distanceM: distanceM,
                text: text,
                headline: item["headline"] as? String ?? "",
                arrow: item["arrow"] as? String ?? ""
            )
        }
        destinationName = call.getString("destinationName") ?? "your destination"
        nearestRouteSegment = nil
        lastFullRouteSearchAt = .distantPast
        offRouteFixes = 0
        offRouteCandidateStartedAt = nil
        offRoute = false
        offRouteApproachSpoken = false
        lastOffRoutePromptAt = .distantPast
        previousLocation = nil
        lastVoiceAt = Date()
        arrived = false
    }

    private func configureVoiceSettings(from call: CAPPluginCall) {
        speakHeadings = call.getBool("speakHeadings") ?? speakHeadings
        let updateMinutes = max(0, min(30, call.getDouble("statusUpdateMin") ?? 0))
        statusUpdateIntervalS = updateMinutes * 60
        statusRoute = call.getBool("statusRoute") ?? statusRoute
        statusSpeed = call.getBool("statusSpeed") ?? statusSpeed
        statusMiles = call.getBool("statusMiles") ?? statusMiles
        statusEta = call.getBool("statusEta") ?? statusEta
    }

    private func clearRouteGuidance() {
        endNavigationActivity(arrived: arrived)
        route.removeAll(keepingCapacity: false)
        instructions.removeAll(keepingCapacity: false)
        nearestRouteSegment = nil
        latestLocationPayload = nil
        offRouteFixes = 0
        offRouteCandidateStartedAt = nil
        offRoute = false
        offRouteApproachSpoken = false
        previousLocation = nil
        latestLocation = nil
        routeTotalTimeS = 0
        arrived = false
    }

    // ------------------------------------------------ lock-screen activity
    // The Live Activity mirrors the in-app banner while the phone is locked:
    // maneuver arrow, "Left turn in 0.2 miles", the full sentence, and the
    // remaining trip distance. It is driven from the same background
    // location stream as spoken guidance — no push tokens — and an update is
    // sent only when the headline text actually changes, so the 25-foot
    // rounding built into the distance text is also the update throttle.
    // Requires the RandoRouteActivity widget extension target; see
    // docs/IOS-HANDOFF.md §Live Activity for the one-time Xcode setup.
    private func startNavigationActivity() {
        guard #available(iOS 16.2, *) else { return }
        endNavigationActivity(arrived: false)
        guard tracking, route.count >= 2,
              ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = NavigationActivityAttributes.ContentState(
            headline: "Starting navigation",
            detail: "To \(destinationName)",
            arrowSymbol: "location.fill",
            meta: "",
            arrived: false
        )
        navigationActivity = try? Activity.request(
            attributes: NavigationActivityAttributes(destinationName: destinationName),
            content: ActivityContent(state: state, staleDate: nil)
        )
        lastActivityHeadline = state.headline
    }

    private func syncNavigationActivity(nearestRouteM: Double) {
        guard #available(iOS 16.2, *),
              let activity = navigationActivity as? Activity<NavigationActivityAttributes>
        else { return }
        let remainingTripM = max(0, (route.last?.distanceM ?? 0) - nearestRouteM)
        let meta = "\(activityDistanceText(remainingTripM)) to \(destinationName)"
        let state: NavigationActivityAttributes.ContentState
        if offRoute {
            state = .init(headline: "Off route",
                          detail: "Guidance resumes when you rejoin the route",
                          arrowSymbol: "exclamationmark.triangle.fill",
                          meta: meta, arrived: false)
        } else if let next = instructions.first {
            let remainingToTurnM = max(0, next.distanceM - nearestRouteM)
            let word = next.headline.isEmpty ? "Continue" : next.headline
            let headline = remainingToTurnM <= 5
                ? "Now: \(word)"
                : "\(word) in \(activityDistanceText(remainingToTurnM))"
            state = .init(headline: headline, detail: next.text,
                          arrowSymbol: activityArrowSymbol(next.arrow),
                          meta: meta, arrived: false)
        } else {
            state = .init(headline: "Continue to your destination",
                          detail: "To \(destinationName)",
                          arrowSymbol: "arrow.up", meta: meta, arrived: false)
        }
        guard state.headline != lastActivityHeadline else { return }
        lastActivityHeadline = state.headline
        Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
    }

    private func endNavigationActivity(arrived: Bool) {
        guard #available(iOS 16.2, *),
              let activity = navigationActivity as? Activity<NavigationActivityAttributes>
        else {
            navigationActivity = nil
            return
        }
        navigationActivity = nil
        lastActivityHeadline = ""
        let finalState = NavigationActivityAttributes.ContentState(
            headline: arrived ? "You have arrived" : "Navigation ended",
            detail: arrived ? destinationName : "",
            arrowSymbol: arrived ? "flag.checkered" : "location.slash",
            meta: "", arrived: arrived)
        Task {
            await activity.end(ActivityContent(state: finalState, staleDate: nil),
                               dismissalPolicy: arrived ? .after(.now + 120) : .immediate)
        }
    }

    private func activityArrowSymbol(_ arrow: String) -> String {
        switch arrow {
        case "left": return "arrow.turn.up.left"
        case "right": return "arrow.turn.up.right"
        case "slight-left": return "arrow.up.left"
        case "slight-right": return "arrow.up.right"
        case "hairpin-left": return "arrow.uturn.left"
        case "hairpin-right": return "arrow.uturn.right"
        case "caution": return "exclamationmark.triangle.fill"
        case "arrive": return "flag.checkered"
        default: return "arrow.up"
        }
    }

    /// navDistanceText's port: feet under a tenth of a mile (rounded to 25),
    /// miles at one decimal above.
    private func activityDistanceText(_ meters: Double) -> String {
        if meters < 160.934 {
            let feet = max(25, Int((meters * 3.28084 / 25).rounded()) * 25)
            return "\(feet) feet"
        }
        return String(format: "%.1f miles", meters / 1609.34)
    }

    // A distance-filtered CLLocationManager may deliver few fixes while a
    // rider is stopped. Periodic voice status therefore needs its own cadence
    // rather than being checked only as a side effect of a new GPS fix.
    private func refreshStatusUpdateTimer() {
        stopStatusUpdateTimer()
        guard tracking, statusUpdateIntervalS > 0 else { return }
        let pollInterval = min(15, statusUpdateIntervalS)
        let timer = Timer(timeInterval: pollInterval, repeats: true) {
            [weak self] _ in self?.handleScheduledStatusUpdate()
        }
        timer.tolerance = min(2, pollInterval / 5)
        RunLoop.main.add(timer, forMode: .common)
        statusUpdateTimer = timer
    }

    private func stopStatusUpdateTimer() {
        statusUpdateTimer?.invalidate()
        statusUpdateTimer = nil
    }

    private func handleScheduledStatusUpdate() {
        guard tracking,
              let location = latestLocation,
              let nearest = nearestRoutePosition(to: location) else { return }
        discardPassedInstructions(at: nearest.routeM)
        syncNavigationActivity(nearestRouteM: nearest.routeM)
        let background = UIApplication.shared.applicationState != .active
        let remainingToTurnM = instructions.first.map {
            $0.distanceM - nearest.routeM
        } ?? .infinity
        // A phone that has stopped moving may not receive another GPS callback
        // to trigger the ordinary approach prompt while locked. Let the cadence
        // check deliver that prompt in the background only; foreground maneuver
        // prompts remain owned by the web UI.
        if background,
           !instructions.isEmpty,
           remainingToTurnM <= 30,
           !instructions[0].immediateHandled {
            instructions[0].immediateHandled = true
            instructions[0].aheadHandled = true
            instructions[0].approachHandled = true
            speakText("\(instructions[0].text).")
            return
        }
        if background,
           !instructions.isEmpty,
           remainingToTurnM <= 90,
           !instructions[0].aheadHandled {
            instructions[0].aheadHandled = true
            instructions[0].approachHandled = true
            speakText(aheadPrompt(instructions[0].text))
            return
        }
        if background,
           !instructions.isEmpty,
           remainingToTurnM <= 350,
           !instructions[0].approachHandled {
            instructions[0].approachHandled = true
            speakText(distancePrompt(instructions[0].text, distanceM: remainingToTurnM))
            return
        }
        maybeSpeakPeriodicStatus(
            location: location,
            priorLocation: previousLocation,
            nearestRouteM: nearest.routeM,
            nextInstruction: instructions.first,
            remainingToTurnM: remainingToTurnM
        )
    }

    private func updateNativeGuidance(_ location: CLLocation) {
        guard route.count >= 2,
              let nearest = nearestRoutePosition(to: location) else { return }
        nearestRouteSegment = nearest.segment

        let background = UIApplication.shared.applicationState != .active
        let priorLocation = previousLocation
        previousLocation = location
        if !offRoute, nearest.offRouteM > offRouteEnterM {
            let now = Date()
            let accuracy = location.horizontalAccuracy
            if accuracy > offRouteMaxAccuracyM {
                return
            }
            if offRouteCandidateStartedAt == nil
                || now.timeIntervalSince(offRouteCandidateStartedAt!) > offRouteCandidateWindowS {
                offRouteCandidateStartedAt = now
                offRouteFixes = 1
            } else {
                offRouteFixes += 1
            }
            let requiredFixes = accuracy > offRouteGoodAccuracyM ? 3 : 2
            if offRouteFixes >= requiredFixes {
                offRoute = true
                offRouteFixes = 0
                offRouteCandidateStartedAt = nil
                offRouteApproachSpoken = false
                if background {
                    speakText(rejoinRoutePrompt(nearest, location: location))
                    lastOffRoutePromptAt = now
                }
            }
            return
        }
        if offRoute {
            if nearest.offRouteM > offRouteRejoinM {
                if nearest.offRouteM > 250 {
                    offRouteApproachSpoken = false
                }
                if background, nearest.offRouteM <= 130, !offRouteApproachSpoken {
                    offRouteApproachSpoken = true
                    speakText(routeApproachPrompt(nearest, location: location, priorLocation: priorLocation))
                    lastOffRoutePromptAt = Date()
                } else if background,
                          Date().timeIntervalSince(lastOffRoutePromptAt) >= 30 {
                    speakText(rejoinRoutePrompt(nearest, location: location))
                    lastOffRoutePromptAt = Date()
                }
                return
            }
            offRoute = false
            offRouteFixes = 0
            offRouteCandidateStartedAt = nil
            offRouteApproachSpoken = false
            if background {
                let road = routeRoadName(at: nearest.segment)
                speakText(road.isEmpty
                    ? "Back on route."
                    : "Back on route. Continue on \(road).")
                lastOffRoutePromptAt = Date()
            }
        }
        offRouteFixes = 0
        offRouteCandidateStartedAt = nil

        discardPassedInstructions(at: nearest.routeM)
        syncNavigationActivity(nearestRouteM: nearest.routeM)
        guard !instructions.isEmpty else {
            if background, !arrived,
               let destination = route.last,
               nearest.routeM >= destination.distanceM - 45 {
                arrived = true
                speakText("You have arrived at your destination.")
                // Arriving ends the ride here too, not just in the web layer,
                // and the web layer is told so both agree the ride is over.
                // finishTurnNavigation() on that side is idempotent.
                notifyListeners("arrived", data: [:])
                endTracking()
            } else if background {
                maybeSpeakPeriodicStatus(
                    location: location,
                    priorLocation: priorLocation,
                    nearestRouteM: nearest.routeM,
                    nextInstruction: nil,
                    remainingToTurnM: .infinity
                )
            }
            return
        }

        let remainingM = instructions[0].distanceM - nearest.routeM
        if background, remainingM <= 30, !instructions[0].immediateHandled {
            instructions[0].immediateHandled = true
            instructions[0].aheadHandled = true
            instructions[0].approachHandled = true
            speakText("\(instructions[0].text).")
        } else if background, remainingM <= 90, !instructions[0].aheadHandled {
            instructions[0].aheadHandled = true
            instructions[0].approachHandled = true
            speakText(aheadPrompt(instructions[0].text))
        } else if background, remainingM <= 350, !instructions[0].approachHandled {
            instructions[0].approachHandled = true
            speakText(distancePrompt(instructions[0].text, distanceM: remainingM))
        }
        if background {
            maybeSpeakPeriodicStatus(
                location: location,
                priorLocation: priorLocation,
                nearestRouteM: nearest.routeM,
                nextInstruction: instructions[0],
                remainingToTurnM: remainingM
            )
        }
    }

    private func discardPassedInstructions(at routeM: Double) {
        while let current = instructions.first {
            let holdM: Double
            if instructions.count > 1 {
                let gapM = max(0, instructions[1].distanceM - current.distanceM)
                holdM = min(maneuverPassedHoldMaxM,
                            max(maneuverPassedHoldMinM, gapM * 0.2))
            } else {
                holdM = maneuverPassedHoldMaxM
            }
            guard routeM - current.distanceM > holdM else { return }
            // A coarse or delayed fix may skip a junction entirely. Dropping a
            // completed instruction is safer than speaking it behind the rider.
            instructions.removeFirst()
        }
    }

    private func maybeSpeakPeriodicStatus(
        location: CLLocation,
        priorLocation: CLLocation?,
        nearestRouteM: Double,
        nextInstruction: RouteInstruction?,
        remainingToTurnM: Double
    ) {
        guard statusUpdateIntervalS > 0,
              !arrived,
              !speechSynthesizer.isSpeaking,
              Date().timeIntervalSince(lastVoiceAt) >= statusUpdateIntervalS else { return }

        var parts: [String] = []
        if statusRoute {
            if let nextInstruction {
                parts.append(
                    "In \(spokenDistance(remainingToTurnM)), "
                        + midSentence(nextInstruction.text)
                )
            } else {
                parts.append("Continue to your destination")
            }
        }
        if statusSpeed, let speed = currentSpeedMph(location, priorLocation: priorLocation) {
            parts.append("Speed \(Int(speed.rounded())) miles per hour")
        }
        let totalRouteM = route.last?.distanceM ?? 0
        let remainingRouteM = max(0, totalRouteM - nearestRouteM)
        if statusMiles {
            parts.append("\(spokenDistance(remainingRouteM)) remaining")
        }
        if statusEta, routeTotalTimeS > 0, totalRouteM > 0 {
            let remainingS = routeTotalTimeS * remainingRouteM / totalRouteM
            if remainingS >= 45 {
                parts.append("about \(spokenDuration(remainingS)) left")
            }
        }
        if !parts.isEmpty {
            speakText(parts.joined(separator: ". ") + ".")
        }
    }

    private func midSentence(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.lowercased() + String(text.dropFirst())
    }

    private func aheadPrompt(_ instruction: String) -> String {
        "Ahead, \(midSentence(instruction))."
    }

    private func distancePrompt(_ instruction: String, distanceM: Double) -> String {
        "In \(spokenDistance(distanceM)), \(midSentence(instruction))."
    }

    private func currentSpeedMph(
        _ location: CLLocation,
        priorLocation: CLLocation?
    ) -> Double? {
        if location.speed >= 0 {
            return location.speed * 2.23694
        }
        guard let priorLocation else { return nil }
        let elapsed = location.timestamp.timeIntervalSince(priorLocation.timestamp)
        guard elapsed > 0, elapsed < 30 else { return nil }
        return location.distance(from: priorLocation) / elapsed * 2.23694
    }

    private func spokenDuration(_ seconds: TimeInterval) -> String {
        let minutes = max(1, Int((seconds / 60).rounded()))
        if minutes < 60 {
            return "\(minutes) minute\(minutes == 1 ? "" : "s")"
        }
        let hours = minutes / 60
        let remainder = minutes % 60
        return "\(hours) hour\(hours == 1 ? "" : "s")"
            + (remainder > 0 ? " \(remainder) minutes" : "")
    }

    private func nearestRoutePosition(to location: CLLocation)
        -> (segment: Int, routeM: Double, offRouteM: Double,
            latitude: Double, longitude: Double)? {
        let segmentCount = route.count - 1
        guard segmentCount > 0 else { return nil }
        let now = Date()
        var range: Range<Int>
        if let nearestRouteSegment {
            let start = max(0, nearestRouteSegment - 120)
            let end = min(segmentCount, nearestRouteSegment + 121)
            range = start..<end
        } else {
            range = 0..<segmentCount
            lastFullRouteSearchAt = now
        }
        var best = nearestRoutePosition(to: location, in: range)
        if let current = best, current.offRouteM > 250,
           now.timeIntervalSince(lastFullRouteSearchAt) >= 30 {
            best = nearestRoutePosition(to: location, in: 0..<segmentCount)
            lastFullRouteSearchAt = now
        }
        return best
    }

    private func nearestRoutePosition(to location: CLLocation, in range: Range<Int>)
        -> (segment: Int, routeM: Double, offRouteM: Double,
            latitude: Double, longitude: Double)? {
        let latitudeScale = 110_540.0
        let longitudeScale = 111_320.0 * cos(location.coordinate.latitude * .pi / 180)
        var best: (segment: Int, routeM: Double, offRouteM: Double,
            latitude: Double, longitude: Double)?
        for index in range {
            let from = route[index]
            let to = route[index + 1]
            let ax = (from.longitude - location.coordinate.longitude) * longitudeScale
            let ay = (from.latitude - location.coordinate.latitude) * latitudeScale
            let bx = (to.longitude - location.coordinate.longitude) * longitudeScale
            let by = (to.latitude - location.coordinate.latitude) * latitudeScale
            let dx = bx - ax
            let dy = by - ay
            let lengthSquared = dx * dx + dy * dy
            let fraction = lengthSquared > 0
                ? max(0, min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0
            let px = ax + fraction * dx
            let py = ay + fraction * dy
            let offRouteM = hypot(px, py)
            if best == nil || offRouteM < best!.offRouteM {
                best = (
                    index,
                    from.distanceM + fraction * (to.distanceM - from.distanceM),
                    offRouteM,
                    from.latitude + fraction * (to.latitude - from.latitude),
                    from.longitude + fraction * (to.longitude - from.longitude)
                )
            }
        }
        return best
    }

    private func rejoinRoutePrompt(
        _ nearest: (segment: Int, routeM: Double, offRouteM: Double,
            latitude: Double, longitude: Double),
        location: CLLocation
    ) -> String {
        let point = CLLocationCoordinate2D(
            latitude: nearest.latitude,
            longitude: nearest.longitude
        )
        let direction = compassWord(bearing(from: location.coordinate, to: point))
        let road = routeRoadName(at: nearest.segment)
        return "Rejoin route \(spokenDistance(nearest.offRouteM)) \(direction)"
            + (road.isEmpty ? "." : " on \(road).")
    }

    private func routeApproachPrompt(
        _ nearest: (segment: Int, routeM: Double, offRouteM: Double,
            latitude: Double, longitude: Double),
        location: CLLocation,
        priorLocation: CLLocation?
    ) -> String {
        let road = routeRoadName(at: nearest.segment)
        let target = road.isEmpty ? "the route" : road
        let routeBearing = bearing(
            from: route[nearest.segment],
            to: route[min(route.count - 1, nearest.segment + 1)]
        )
        let heading = compassWord(routeBearing)
        let headingPhrase = speakHeadings ? ", heading \(heading)" : ""
        guard let priorLocation,
              location.distance(from: priorLocation) >= 8 else {
            return "Ahead: rejoin \(target)\(headingPhrase)."
        }
        let riderBearing = bearing(
            from: priorLocation.coordinate,
            to: location.coordinate
        )
        let delta = normalizedTurn(routeBearing - riderBearing)
        let maneuver: String
        if delta > 28 {
            maneuver = delta > 115 ? "Turn sharply right" : "Turn right"
        } else if delta < -28 {
            maneuver = delta < -115 ? "Turn sharply left" : "Turn left"
        } else {
            maneuver = "Continue"
        }
        return "\(maneuver) onto \(target)\(headingPhrase)."
    }

    private func routeRoadName(at segment: Int) -> String {
        guard !route.isEmpty else { return "" }
        for offset in 0...3 {
            let index = min(route.count - 1, max(0, segment + offset))
            if !route[index].roadName.isEmpty {
                return route[index].roadName
            }
        }
        return ""
    }

    private func bearing(from: RoutePoint, to: RoutePoint) -> Double {
        bearing(
            from: CLLocationCoordinate2D(latitude: from.latitude, longitude: from.longitude),
            to: CLLocationCoordinate2D(latitude: to.latitude, longitude: to.longitude)
        )
    }

    private func bearing(
        from: CLLocationCoordinate2D,
        to: CLLocationCoordinate2D
    ) -> Double {
        let latitude1 = from.latitude * .pi / 180
        let latitude2 = to.latitude * .pi / 180
        let longitudeDelta = (to.longitude - from.longitude) * .pi / 180
        let y = sin(longitudeDelta) * cos(latitude2)
        let x = cos(latitude1) * sin(latitude2)
            - sin(latitude1) * cos(latitude2) * cos(longitudeDelta)
        return (atan2(y, x) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
    }

    private func normalizedTurn(_ degrees: Double) -> Double {
        var value = (degrees + 540).truncatingRemainder(dividingBy: 360) - 180
        if value < -180 { value += 360 }
        return value
    }

    private func compassWord(_ bearing: Double) -> String {
        let names = ["north", "northeast", "east", "southeast",
                     "south", "southwest", "west", "northwest"]
        return names[Int((bearing + 22.5) / 45) % names.count]
    }

    private func spokenDistance(_ meters: Double) -> String {
        let feet = max(0, meters) * 3.28084
        if feet < 1_000 {
            let rounded = max(25, Int((feet / 25).rounded()) * 25)
            return "\(rounded) feet"
        }
        let miles = max(0, meters) / 1_609.344
        return miles < 10
            ? String(format: "%.1f miles", miles)
            : "\(Int(miles.rounded())) miles"
    }

    private func navigationVoiceScore(
        _ voice: AVSpeechSynthesisVoice,
        language: String,
        defaultVoice: AVSpeechSynthesisVoice?
    ) -> Int {
        let requested = language.lowercased()
        var score = voice.language.lowercased() == requested ? 40 : 20
        if voice.identifier == defaultVoice?.identifier { score += 10 }
        if voice.quality == .enhanced { score += 200 }
        if #available(iOS 16.0, *), voice.quality == .premium { score += 300 }
        return score
    }

    private func bestNavigationVoice(language: String) -> AVSpeechSynthesisVoice? {
        let requestedBase = language
            .split(separator: "-")
            .first
            .map(String.init)?
            .lowercased() ?? "en"
        let defaultVoice = AVSpeechSynthesisVoice(language: language)
        let noveltyNames: Set<String> = [
            "bad news", "bahh", "bells", "boing", "bubbles", "cellos",
            "jester", "organ", "superstar", "trinoids", "whisper", "wobble", "zarvox"
        ]
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language.lowercased().hasPrefix(requestedBase)
                && !noveltyNames.contains($0.name.lowercased())
        }
        return candidates.max {
            navigationVoiceScore($0, language: language, defaultVoice: defaultVoice)
                < navigationVoiceScore($1, language: language, defaultVoice: defaultVoice)
        } ?? defaultVoice
    }

    private func navigationUtterance(_ text: String, language: String) -> AVSpeechUtterance {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = bestNavigationVoice(language: language)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.96
        return utterance
    }

    // AVSpeechSynthesizerDelegate. Both endings matter: a cancelled prompt --
    // which happens on every instruction that interrupts the last one -- would
    // otherwise leave the session active exactly like a finished one.
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        reportWebSpeechEnd(utterance, cancelled: false)
        releaseAudioSessionWhenIdle()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        reportWebSpeechEnd(utterance, cancelled: true)
        releaseAudioSessionWhenIdle()
    }

    private func reportWebSpeechEnd(_ utterance: AVSpeechUtterance, cancelled: Bool) {
        guard let speechID = webSpeechIDs.removeValue(forKey: ObjectIdentifier(utterance)) else {
            return
        }
        notifyListeners("speechFinished", data: [
            "speechId": speechID,
            "cancelled": cancelled
        ])
    }

    private func releaseAudioSessionWhenIdle() {
        // A new prompt may already be speaking; ducking must persist through it.
        guard !speechSynthesizer.isSpeaking else { return }
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }

    private func speakText(
        _ text: String,
        language: String = "en-US",
        webSpeechID: Int? = nil
    ) {
        // AVSpeechSynthesizer queues utterances in order. Do not stop the active
        // sentence to start a newer one: that was the source of clipped prompts
        // and, on devices where cancellation settles asynchronously, audible
        // overlap between the old and replacement sentences.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playback,
                mode: .spokenAudio,
                options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
            )
            try session.setActive(true)
        } catch {
            // AVSpeechSynthesizer can still use the current audio session.
        }
        lastVoiceAt = Date()
        let utterance = navigationUtterance(text, language: language)
        if let webSpeechID {
            webSpeechIDs[ObjectIdentifier(utterance)] = webSpeechID
        }
        speechSynthesizer.speak(utterance)
    }

    private func locationPayload(_ location: CLLocation) -> [String: Any] {
        [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy,
            "altitude": location.altitude,
            "altitudeAccuracy": location.verticalAccuracy,
            "heading": location.course >= 0 ? location.course : NSNull(),
            "speed": location.speed >= 0 ? location.speed : NSNull(),
            "timestamp": location.timestamp.timeIntervalSince1970 * 1000
        ]
    }

    private func statusPayload() -> [String: Any] {
        [
            // Every caller reaches this only after requireLocationServices has
            // checked on a background queue. Repeating Apple's potentially
            // blocking class method here would put it back on the main thread.
            "servicesEnabled": true,
            "authorization": authorizationName(locationManager.authorizationStatus),
            "accuracy": accuracyName(locationManager.accuracyAuthorization),
            "tracking": tracking
        ]
    }

    private func authorizationName(_ status: CLAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "prompt"
        case .restricted: return "restricted"
        case .denied: return "denied"
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whileUsing"
        @unknown default: return "unknown"
        }
    }

    private func accuracyName(_ authorization: CLAccuracyAuthorization) -> String {
        authorization == .fullAccuracy ? "full" : "reduced"
    }
}
