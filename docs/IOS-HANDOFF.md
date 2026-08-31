# iOS handoff

Last audited 2026-08-23 on macOS with Xcode 26.6, the iOS 26.5 simulator SDK,
a generic physical-iPhone Release target, and Capacitor 8.4.2. Version .801 was
synced with both released starter states and compiled in Release configuration
for the simulator and generic iOS device with no Swift warnings; the unsigned
products were 365 MiB and 361 MiB. Earlier store validation also passed. The
shared `.807` shell was synced on 2026-08-24 and its unsigned Release simulator
build succeeded against the iOS 26.5 SDK; the product is 366 MiB and contains
the stamped Washington and Oregon regional geography archives. The
shared web tests and simulator checks are real coverage; locked-screen GPS,
audio mixing, battery, and thermals still require a physical iPhone and a real
ride.

On 2026-08-30 at `.954` the Live Activity Swift compiled for the first time,
clean, and the App target built Release with no Swift warnings. The
`RandoRouteActivity` extension target still does not exist, so no lock-screen
card has yet rendered anywhere. §3c carries that audit.

---

## 1. What the native app actually is

Capacitor 8 wrapping the same web app, with one custom plugin.

- `scripts/build_mobile_shell.mjs` copies the web app into `mobile-shell/`,
  flips `data-app-runtime="web"` to `"native"`, and bundles at most two released
  starter states by readiness. `JRA_BUNDLED_STATE_IDS=state-a,state-b` makes
  that bounded set explicit. Other indexed states remain discoverable and use
  the same confirmed store download as the slim shell; importing more states
  therefore cannot silently create an unbounded national app bundle.
- Because of that flag, `index.html` **does not register the service worker**.
  None of the offline/service-worker machinery runs on iOS — it exists for the
  web PWA. Do not debug the worker on a device; it is not there.
- Everything else — the map, the router, the safety model — is the shared web
  code. `npm test` covers it, and covers it on the same bytes iOS ships.

So the native-only surface is exactly one file:
`ios/App/App/BridgeViewController.swift`, which provides location,
background tracking and spoken navigation.

Rebuild the shell with `npm run ios:sync` after any web change. `mobile-shell/`
is generated — never edit it.

### First-install startup profile

The 2026-08-24 generated full shell occupies **374 MiB** on disk with the two
current starter states. Their manifests declare 374,382,880 unique bytes after
the shared partition catalogue is counted once; the remaining shell size is
application/vendor content and filesystem allocation. Oregon accounts for
160,095,198 manifest bytes and Washington for 217,917,369. A future third state
does not join the bundle automatically: it remains a confirmed store download
unless the bounded two-state product choice changes.

Historical install measurements predate the partition artifacts: a clean,
disposable iOS 17.5 simulator install took **8.89 s before process launch**. A
cold iOS 26.5 simulator took **25.92 s**; the same build installed in **0.94 s**
after its caches were warm. Re-measure these in milestone 14 because the current
shell is larger. A physical-device deployment can be slower, especially over
Wi-Fi. That copy is Xcode deployment work, not a main-thread hang in the app.

There is a second, independent first-run delay on a physical device. If Xcode
shows **“Launching ‘App’ is taking longer than expected”** and specifically
says **“LLDB is likely reading from device memory to resolve symbols,”** the
app has not hung: Xcode's debugger is resolving/caching symbols for that
device/OS. Choose **Continue**. To distinguish debugger overhead from app
startup, stop the Xcode run and open the already-installed app from the home
screen; or temporarily uncheck **Edit Scheme → Run → Info → Debug executable**.
Do not leave that unchecked for development, because breakpoints and crash
inspection will not attach.

With permission controlled, the first map was historically visible and usable
in roughly 1–2 s. Washington's ordinary graph expands to 145,828,781 bytes and
is inflated/indexed in a worker for the single-state compatibility path. A
cross-state route instead admits detailed partitions under that same raw-input
ceiling and reports composition/derived-array estimates. On an empty planner,
routing work starts only after the first map load and idle opportunity (with a
1.5 s bound); a saved trip or immediate planner tap still starts it at once.

The optimized Release build also survived ten consecutive terminate/relaunch
cycles on an iPhone SE-sized iOS 17.5 simulator. Process launch requests took
0.30–1.71 s and every run reached the rendered map; the deferred routing status
then cleared normally. Simulator framework warnings remained, but there were no
app crashes or faults.

Native startup calls `getStatus()` and recenters only when location permission
already exists. It also uses a native-only location button instead of
constructing MapLibre's browser-geolocation control, whose WebKit permission
probe can itself raise the sheet. A new install no longer places the location
sheet over the first map; it asks when the rider taps location or chooses “my
location.” This was verified on a newly created iOS 17.5 simulator whose status
remained `prompt` while the fully rendered map was visible.

---

## 2. Native hardening now in place

### Arrival ended the announcement, not the ride (user-visible)

Reported from a real ride: "arrived" was announced, and the guide carried on
giving directions once the rider had biked past.

The two ways a ride finishes did different things. `stopTracking()` -- the web
layer asking -- tore the session down. Arrival, which this guide decides for
itself, did this and nothing else:

```swift
arrived = true
speakText("You have arrived at your destination.")
```

No `stopUpdatingLocation`, no `clearRouteGuidance`, and no word to the web
layer. That matters most exactly where it was reported: with the screen locked
the web layer is suspended and never sees the fixes that would let it notice
arrival, so nothing ever called `stopTracking`, and `maybeSpeakPeriodicStatus`
kept running.

Now both paths go through one `endTracking()`, and arrival also fires
`notifyListeners("arrived")`. `app.js` subscribes and calls
`finishTurnNavigation()`, which is idempotent, so the two notices cannot fight
if an unlocked ride sees both.

**Verify:** lock the screen, ride to the destination, then keep riding past
it. You should hear the arrival sentence and then nothing further -- no turn
prompts, no periodic status. Check the blue background-location bar clears.
Then do the same unlocked, where both halves notice, and confirm arrival is
announced once rather than twice.

The web half is covered by `scripts/test_navigation_arrival.mjs`, which fires
the plugin event at a stubbed plugin. The Swift half compiles; the locked-screen
ride remains a device check.

### The audio session was never released (user-visible)

`speakText()` activated the session with `.duckOthers` on every prompt, but
nothing deactivated it. There was no `AVSpeechSynthesizerDelegate` at all, so
nothing knew when speech ended. A rider's music would duck at the first turn
instruction and stay quiet for the rest of the ride — only an explicit
`stopSpeaking` bridge call ever restored it.

Now: the plugin conforms to `AVSpeechSynthesizerDelegate` and releases the
session on `didFinish` **and** `didCancel`, guarded by `isSpeaking` so a prompt
that interrupts another does not drop ducking mid-sentence.

**Verify:** play music, start navigation, take a turn. Music should duck for the
prompt and return to full volume within a second after. Then check it also
returns when one instruction interrupts another (two turns close together).

### `locationServicesEnabled()` on the main thread

Apple documents this call as able to block. All three entry points made it
inside `DispatchQueue.main.async` — so the risk landed on opening the app and
starting navigation. Moved to a global queue with the result hopped back to
main, via `requireLocationServices(_:then:)`. `statusPayload()` no longer
repeats the potentially blocking call on main after that check.

**Verify:** it still rejects correctly with Location Services switched off
system-wide (Settings → Privacy → Location Services → off). That is the path
whose control flow changed most.

### `Info.plist` required `armv7`

A 32-bit capability on a 64-bit-only app. Now `arm64`. **Verify:** it still
installs on a device, and the App Store validator is happy.

---

## 3. Location, screen, and speech lifecycle

### Cancelled and timed-out location work is settled honestly

- `stopTracking()` rejects a `startTracking()` call still waiting on permission
  instead of resolving it as though navigation started.
- Every native `getCurrentPosition()` call has its own bounded timeout, passed
  from the same JS option used by browser geolocation. Success, failure, denial,
  and timeout all cancel and remove the matching pending work.
- A newer pending navigation start rejects the older one rather than orphaning
  its promise.

### Keeping the screen awake uses native iOS control

The **Settings → Voice → Keep the screen awake while navigating** setting now
drives `UIApplication.shared.isIdleTimerDisabled` through `setScreenAwake`.
The Web Screen Wake Lock API remains a fallback for browsers and mismatched old
shells. Stopping or arriving always restores the idle timer. The native and web
paths are exercised by `scripts/test_keep_screen_awake.mjs`.

### The speech queue advances on real native completion

The web layer owns a queue (`speakNavigation` in `app.js`) and never hands its
next utterance to the plugin while one is playing. The native background guide
can also originate prompts directly, so `speakText` itself no longer calls
`stopSpeaking(at: .immediate)` when the synthesizer is busy. It lets
`AVSpeechSynthesizer` queue the sentence. That second guard matters on a real
ride: the supposedly unreachable stop was clipping prompts and could start the
replacement on top of the cancelled sentence's tail.

Each web-owned utterance carries a `speechId`. The Swift delegate emits
`speechFinished` from both `didFinish` and `didCancel`; the JS queue advances
only for the matching ID. A deliberately long watchdog remains for a dead
bridge/process, but the old spoken-duration estimate no longer clips normal
sentences. A maneuver removes obsolete status/safety lines that are still
waiting, but it does not cut off a sentence already being spoken. Explicitly
stopping navigation still stops speech. `scripts/test_voice_queue.mjs`
exercises the handshake.

The JS speech engine also assigns every queue session a generation. A late
`onend` from a cancelled utterance is ignored once a replacement session has
started, so it cannot clear the new prompt's timer or active state. In browsers,
the watchdog never advances the queue while `speechSynthesis.speaking` is still
true. The voice-queue regression test passed five consecutive runs after this
race was fixed.

`AVSpeechSynthesizer` is now created lazily on the first spoken prompt. The
native shell also skips the browser-only `speechSynthesis.getVoices()` startup
scan. Before this, a map-only launch initialized two unused voice clients and
immediately queried iOS voice assets; after the change, the TTS asset errors and
work disappeared from the clean startup log.

An older, independent reassurance path said “Still on …” after 105 seconds of
silence even when **Status update** was set to **Never**. It existed in both JS
and Swift, outside the cadence setting, and has been removed. Periodic status is
now spoken only when the rider explicitly selects an interval.

---

## 3b. Waiting for you: safety-level announcements in the background

Settings → Voice has a new option, **Announce route safety levels**. On each
change in how the route paints — trail, bike lane, ordinary road, caution, rule
failure — the rider hears what is coming and how far it runs ("Use caution next
3.4 miles"), spoken about 90 m before the change.

It is decided in `maybeSpeakSafetyChange()` in `app.js`, on the **web** GPS
path, alongside the turn prompts. So it behaves exactly as turn prompts do on
iOS — and stops when they stop.

The flag reaches the plugin: `nativeVoiceStatusPayload()` sends
`safetyLevels`, and `startNativeNavigation` sends the same runs the web layer
uses. **Nothing in `BridgeViewController.swift` reads either yet.** If the
native guide is what speaks while the screen is locked, this option needs the
same treatment there; the payload is already carrying what it would need.

---

## 3c. Live Activity: next maneuver on the lock screen

Written 2026-08-26. **The Swift now compiles; the extension target still does
not exist, so nothing renders yet.** See the 2026-08-30 audit below for what
that means. The code shows
the next maneuver on the lock screen and in the Dynamic Island while
navigating: a maneuver arrow, "Left turn in 0.2 miles" as the headline, the
full instruction sentence, and remaining trip distance. It is driven by
`BridgeViewController`'s existing background location stream (the same one
that speaks while locked), updates only when the headline text changes
(the 25-foot distance rounding is the throttle), ends with a two-minute
"You have arrived" card on arrival, and disappears immediately on Stop.
The glance line and arrow arrive pre-resolved from the web layer with the
in-app banner's exact thresholds, so locked and unlocked guidance cannot
disagree.

**One-time Xcode setup (the extension target cannot be created from a text
editor):**

1. File → New → Target… → **Widget Extension**. Name it exactly
   `RandoRouteActivity`, uncheck "Include Configuration App Intent", check
   "Include Live Activity" if offered. Do NOT activate its scheme when
   prompted (Cancel is fine — the App scheme builds it).
2. Delete every Swift file the template generated inside the new
   `RandoRouteActivity` group (Move to Trash), then File → Add Files… and
   add the two committed files in `ios/App/RandoRouteActivity/`
   (`NavigationLiveActivity.swift`, `RandoRouteActivityBundle.swift`) with
   target membership **RandoRouteActivity only**.
3. Select `App/NavigationActivityAttributes.swift` and give it target
   membership in **both** App and RandoRouteActivity (File Inspector →
   Target Membership). Without this the widget renders nothing: ActivityKit
   matches activities by type identity.
4. Set the extension's minimum deployment to **iOS 16.2**.
5. `App/Info.plist` already carries `NSSupportsLiveActivities` (committed).

**Device checks (all physical-iPhone-only):** the card appears when
Navigate starts and the phone locks; the arrow and headline track turns and
match what the unlocked banner showed; the Dynamic Island compact view
shows arrow + distance; off-route flips the card to the warning state;
arrival shows the checkered flag and the card dismisses itself within two
minutes; Stop removes it immediately; and Settings → RandoRoute → Live
Activities off degrades silently (guidance and voice unaffected).
`scripts/test_native_lock_screen_activity.mjs` is only a source-text
tripwire for all of this.

### Audit 2026-08-30 — Swift compiles, target absent, device unverified

macOS, Xcode 26.6 (17F113), iOS 26.5 SDK, Capacitor 8.4.2, at `7b9ffdf`
(`APP_VERSION` .954). `npm run ios:sync` came back clean, confirming
`d9b12a6`'s regeneration; no shell change, so the version trio was not
bumped.

**The Live Activity Swift compiles.** Its first compile since being written
on 2026-08-26 was clean — no errors and no warnings in
`NavigationLiveActivity.swift`, `RandoRouteActivityBundle.swift` or
`NavigationActivityAttributes.swift`, type-checked together at
`-target arm64-apple-ios16.2`:

```
xcrun swiftc -typecheck -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  -target arm64-apple-ios16.2 \
  ios/App/App/NavigationActivityAttributes.swift \
  ios/App/RandoRouteActivity/NavigationLiveActivity.swift \
  ios/App/RandoRouteActivity/RandoRouteActivityBundle.swift
```

Both source files sit behind `#if canImport(ActivityKit)`, so a clean pass
could have meant the guard was false and nothing was checked. It was not:
seeding a bad type inside the guarded region reproduced the expected
`cannot find type` error, and an `ActivityAuthorizationInfo` probe imported
ActivityKit cleanly at the same target. The pass is real. In particular the
`if #available(iOS 16.2, *)` with no `else` inside `WidgetBundle.body`
type-checks — `WidgetBundleBuilder` accepts the limited-availability block.

The App target also builds Release for `generic/platform=iOS` with no Swift
warnings, so `BridgeViewController`'s request/update/end call sites compile.
Unsigned product 357 MiB.

**The blocker is unchanged and now measured in the product.**
`grep -c RandoRouteActivity ios/App/App.xcodeproj/project.pbxproj` is still
`0`. The built `App.app` carries `NSSupportsLiveActivities = true` and has
**no `PlugIns/` directory** — there is no widget extension for ActivityKit
to match, and `Activity.request` is behind `try?`, so the failure mode is a
silent no-card rather than a crash. Steps 1–4 above are still required and
still need the Xcode GUI; they were not done in this audit.

After creating the target, these two commands are the objective check that
the wiring took — both must change from the values recorded here:

```
grep -c RandoRouteActivity ios/App/App.xcodeproj/project.pbxproj   # 0 -> nonzero
ls "$(find ~/Library/Developer/Xcode/DerivedData -name App.app -path '*Release-iphoneos*' | head -1)/PlugIns"
```

**No device check in this audit.** Every item in the device list above —
card on lock, arrow/headline tracking, Dynamic Island compact view,
off-route warning state, arrival card and self-dismissal, Stop, and the
Live-Activities-off degradation — remains unverified. Compiling is not
rendering: nothing here shows that a card has ever appeared on a screen.

## 4. Still device-only

Not because they are fine — because reading them without running them tells you
very little:

- **Background location behaviour.** `allowsBackgroundLocationUpdates` is set
  unconditionally in `beginTracking()`, and `.authorizedWhenInUse` then triggers
  `requestAlwaysAuthorization()`. Whether the blue bar, the prompt sequence and
  the locked-screen prompts behave is a device question.
- **The off-route state machine** (`offRouteEnterM` 65 m, `offRouteRejoinM`
  40 m, a 40 s candidate window, accuracy gates at 60/120 m). These are the kind
  of thresholds only a real ride tunes.
- **Battery and thermals** under `kCLLocationAccuracyBestForNavigation` with a
  3 m distance filter, `pausesLocationUpdatesAutomatically = false`, and a
  15 s-poll `Timer` on the main run loop.
- **Whether `notifyListeners` while the screen is locked** does what the comment
  claims (WKWebView JS suspended, so `didUpdateLocations` skips the bridge
  unless `applicationState == .active`).

---

## 5. What the web suite already covers

`npm test` — about 18 minutes locally, 79 files, and it runs the exact JS the
native shell bundles. Worth running before blaming anything on iOS:

- `test_offline_pwa.mjs` — service worker only, so **not** the native path
- `test_route_potential.mjs` — routing returns the cheapest path
- `test_style_churn.mjs` — the map is not told things it already knows
- `test_region_portable.mjs` — nothing is hardcoded to Washington
- `test_app_update_flow.mjs` — web update flow; the native app updates through
  the App Store instead, so this one does not apply either

If a bug reproduces in a desktop browser, it is not an iOS bug — fix it in the
shared code where there is a test harness for it.
