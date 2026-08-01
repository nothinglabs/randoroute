# iOS notes, for whoever has a Mac

Written 2026-08-01 by an agent working in a Linux container with **no macOS, no
Xcode, no simulator and no Swift toolchain**. Nothing below was compiled. The
Swift changes are reasoned from Apple's documented behaviour and from reading
`ios/App/App/BridgeViewController.swift`, and every one of them needs a build
before it is believed.

Start by building. If any of the three changes below does not compile, that is
the most likely thing to be wrong with this file.

---

## 1. What the native app actually is

Capacitor 8 wrapping the same web app, with one custom plugin.

- `scripts/build_mobile_shell.mjs` copies the web app into `mobile-shell/`,
  flips `data-app-runtime="web"` to `"native"`, and **bundles the data**:
  `roads.pmtiles`, `basemap.pmtiles`, `graph2.bin.gz` and the overlays. The
  native app reads them as local files.
- Because of that flag, `index.html` **does not register the service worker**.
  None of the offline/service-worker machinery runs on iOS — it exists for the
  web PWA. Do not debug the worker on a device; it is not there.
- Everything else — the map, the router, the safety model — is the shared web
  code. `npm test` covers it, and covers it on the same bytes iOS ships.

So the native-only surface is exactly one file:
`ios/App/App/BridgeViewController.swift` (819 lines), which provides location,
background tracking and spoken navigation.

Rebuild the shell with `npm run ios:sync` after any web change. `mobile-shell/`
is generated — never edit it.

---

## 2. Changed, unverified — check these first

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
main, via `requireLocationServices(_:then:)`.

**Verify:** it still rejects correctly with Location Services switched off
system-wide (Settings → Privacy → Location Services → off). That is the path
whose control flow changed most.

### `Info.plist` required `armv7`

A 32-bit capability on a 64-bit-only app. Now `arm64`. **Verify:** it still
installs on a device, and the App Store validator is happy.

---

## 3. Found, deliberately not changed

Both are real but small, and both deserve a device rather than a guess.

### `stopTracking` reports success for a start it cancelled

```swift
self.pendingStartCall?.resolve(self.statusPayload())
```

If `startTracking` is still waiting on the permission dialog and `stopTracking`
arrives, the pending start **resolves as though tracking began**. The JS side
then believes navigation is running when it is not. Rejecting would be more
honest, but it changes what the web layer sees, so check what
`startNativeNavigation` in `app.js` does with a rejection before switching it.

### `getCurrentPosition` can hang forever

With `.notDetermined`, the call is parked in `pendingPositionCalls` and
authorization is requested. `locationManagerDidChangeAuthorization` handles
authorized and denied, but `case .notDetermined: break` — so if the rider
dismisses the dialog without choosing, nothing ever resolves or rejects that
promise. A timeout that rejects after, say, 30 s would close it.

---

## 4. Not examined

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

`npm test` — about 7 minutes, 42 files, and it runs the exact JS the native
shell bundles. Worth running before blaming anything on iOS:

- `test_offline_pwa.mjs` — service worker only, so **not** the native path
- `test_route_potential.mjs` — routing returns the cheapest path
- `test_style_churn.mjs` — the map is not told things it already knows
- `test_region_portable.mjs` — nothing is hardcoded to Washington
- `test_app_update_flow.mjs` — web update flow; the native app updates through
  the App Store instead, so this one does not apply either

If a bug reproduces in a desktop browser, it is not an iOS bug — fix it in the
shared code where there is a test harness for it.
