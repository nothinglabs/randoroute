import AVFoundation
import Capacitor
import CoreLocation
import UIKit

@objc(BridgeViewController)
final class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeNavigationPlugin())
    }
}

@objc(NativeNavigationPlugin)
final class NativeNavigationPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    private struct RoutePoint {
        let latitude: Double
        let longitude: Double
        let distanceM: Double
        let roadName: String
    }

    private struct RouteInstruction {
        let distanceM: Double
        let text: String
        var approachHandled = false
        var immediateHandled = false
    }

    let identifier = "NativeNavigationPlugin"
    let jsName = "NativeNavigation"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeaking", returnType: CAPPluginReturnPromise)
    ]

    private let locationManager = CLLocationManager()
    private let speechSynthesizer = AVSpeechSynthesizer()
    private var tracking = false
    private var pendingStartCall: CAPPluginCall?
    private var pendingPositionCalls: [CAPPluginCall] = []
    private var route: [RoutePoint] = []
    private var instructions: [RouteInstruction] = []
    private var nearestRouteSegment: Int?
    private var lastFullRouteSearchAt = Date.distantPast
    private var offRouteFixes = 0
    private var offRouteCandidateStartedAt: Date?
    private var offRoute = false
    private var offRouteApproachSpoken = false
    private var lastOffRoutePromptAt = Date.distantPast
    private var previousLocation: CLLocation?
    private var speakHeadings = true
    private var arrived = false
    private var latestLocationPayload: [String: Any]?
    private let offRouteEnterM = 65.0
    private let offRouteRejoinM = 40.0
    private let offRouteGoodAccuracyM = 60.0
    private let offRouteMaxAccuracyM = 120.0
    private let offRouteCandidateWindowS = 40.0

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

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve([
                "servicesEnabled": CLLocationManager.locationServicesEnabled(),
                "authorization": self.authorizationName(self.locationManager.authorizationStatus),
                "accuracy": self.accuracyName(self.locationManager.accuracyAuthorization),
                "tracking": self.tracking
            ])
        }
    }

    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard CLLocationManager.locationServicesEnabled() else {
                call.reject("Location Services are disabled on this iPhone.")
                return
            }
            switch self.locationManager.authorizationStatus {
            case .denied, .restricted:
                call.reject("Location permission is blocked. Enable it in Settings.")
            case .notDetermined:
                self.pendingPositionCalls.append(call)
                self.locationManager.requestWhenInUseAuthorization()
            case .authorizedAlways, .authorizedWhenInUse:
                self.pendingPositionCalls.append(call)
                self.locationManager.requestLocation()
            @unknown default:
                call.reject("Location authorization is unavailable.")
            }
        }
    }

    @objc func startTracking(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard CLLocationManager.locationServicesEnabled() else {
                call.reject("Location Services are disabled on this iPhone.")
                return
            }
            self.configureRoute(from: call)
            switch self.locationManager.authorizationStatus {
            case .denied, .restricted:
                call.reject("Location permission is blocked. Enable it in Settings.")
            case .notDetermined:
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
            self.tracking = false
            self.pendingStartCall?.resolve(self.statusPayload())
            self.pendingStartCall = nil
            self.locationManager.stopUpdatingLocation()
            self.locationManager.allowsBackgroundLocationUpdates = false
            self.locationManager.showsBackgroundLocationIndicator = false
            self.clearRouteGuidance()
            call.resolve()
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.isEmpty else {
            call.reject("Speech text is required.")
            return
        }
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(
                    .playback,
                    mode: .spokenAudio,
                    options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
                )
                try session.setActive(true)
            } catch {
                // Speech can still succeed with the system's existing session.
            }
            if self.speechSynthesizer.isSpeaking {
                self.speechSynthesizer.stopSpeaking(at: .immediate)
            }
            let utterance = self.navigationUtterance(
                text,
                language: call.getString("language") ?? "en-US"
            )
            self.speechSynthesizer.speak(utterance)
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
                    manager.requestLocation()
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
                self.pendingPositionCalls.forEach { $0.reject(message) }
                self.pendingPositionCalls.removeAll()
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
        let payload = locationPayload(location)
        latestLocationPayload = payload
        if !pendingPositionCalls.isEmpty {
            pendingPositionCalls.forEach { $0.resolve(payload) }
            pendingPositionCalls.removeAll()
        }
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
        if !pendingPositionCalls.isEmpty {
            pendingPositionCalls.forEach { $0.reject(error.localizedDescription) }
            pendingPositionCalls.removeAll()
        }
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
        if locationManager.authorizationStatus == .authorizedWhenInUse {
            locationManager.requestAlwaysAuthorization()
        }
    }

    @objc private func appDidBecomeActive() {
        notifyListeners("appActive", data: [:])
        guard tracking, let payload = latestLocationPayload else { return }
        notifyListeners("location", data: payload)
    }

    private func configureRoute(from call: CAPPluginCall) {
        speakHeadings = call.getBool("speakHeadings") ?? true
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
            return RouteInstruction(distanceM: distanceM, text: text)
        }
        nearestRouteSegment = nil
        lastFullRouteSearchAt = .distantPast
        offRouteFixes = 0
        offRouteCandidateStartedAt = nil
        offRoute = false
        offRouteApproachSpoken = false
        lastOffRoutePromptAt = .distantPast
        previousLocation = nil
        arrived = false
    }

    private func clearRouteGuidance() {
        route.removeAll(keepingCapacity: false)
        instructions.removeAll(keepingCapacity: false)
        nearestRouteSegment = nil
        latestLocationPayload = nil
        offRouteFixes = 0
        offRouteCandidateStartedAt = nil
        offRoute = false
        offRouteApproachSpoken = false
        previousLocation = nil
        arrived = false
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

        while !instructions.isEmpty, instructions[0].distanceM - nearest.routeM < -60 {
            instructions.removeFirst()
        }
        guard !instructions.isEmpty else {
            if background, !arrived,
               let destination = route.last,
               nearest.routeM >= destination.distanceM - 45 {
                arrived = true
                speakText("You have arrived at your destination.")
            }
            return
        }

        let remainingM = instructions[0].distanceM - nearest.routeM
        if remainingM <= 90, !instructions[0].immediateHandled {
            instructions[0].immediateHandled = true
            instructions[0].approachHandled = true
            if background {
                speakText("\(instructions[0].text).")
            }
        } else if remainingM <= 350, !instructions[0].approachHandled {
            instructions[0].approachHandled = true
            if background {
                speakText("In \(spokenDistance(remainingM)), \(instructions[0].text.lowercased()).")
            }
        }
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

    private func speakText(_ text: String) {
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
        if speechSynthesizer.isSpeaking {
            speechSynthesizer.stopSpeaking(at: .immediate)
        }
        let utterance = navigationUtterance(text, language: "en-US")
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
            "servicesEnabled": CLLocationManager.locationServicesEnabled(),
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
