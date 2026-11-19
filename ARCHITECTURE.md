# Architecture

```
 AI web page (chatgpt.com / claude.ai / your Open WebUI)            Firefox extension (privileged)
┌──────────────────────────────────────────────┐        ┌───────────────────────────────────────────────────────────┐
│ content/entry-<platform>.js                  │        │ background.js (MV3 event page)                            │
│  ├─ detectors/<platform>.ts (PlatformProfile)│ state  │  ├─ bridge.ts        orchestration                        │
│  ├─ detectors/base.ts  DomDetector           │──────▶ │  ├─ tab-manager.ts   per-tab records + arbitration        │
│  │   MutationObserver, input/click listeners │ msgs   │  ├─ state-manager.ts stability, mapping, keepalive        │
│  └─ content/observer.ts ContentBridge        │◀────── │  ├─ command-queue.ts last-state-wins, dedupe, back-off    │
│      hello / state / heartbeat               │ reply  │  ├─ device-client.ts Wi-Fi: 4 fixed HTTP endpoints ───────┼──▶ Tiny Engineer :80
│  (no storage, no network, no config)         │        │  ├─ serial-client.ts USB: Web Serial, sync/health/anim ───┼──▶ Tiny Engineer USB CDC
└──────────────────────────────────────────────┘        │  ├─ content-scripts.ts dynamic registration               │
                                                        │  └─ index.ts         browser events, storage, alarms      │
 popup/ + options/ ── getStatus / testConnection ─────▶ └───────────────────────────────────────────────────────────┘
        (storage.local config)  ──── storage.onChanged ──────▲
```

## Modules

| Module | Responsibility | Browser APIs |
| --- | --- | --- |
| `shared/types.ts` | States, platforms, animation names and kinds (continuous / one-shot / hold) | – |
| `shared/config.ts` | Config model, defaults, validation & sanitizing | – |
| `shared/messaging.ts` | Message contracts + strict validators | – |
| `shared/storage.ts` | Load/save config (`storage.local`) — privileged contexts only | storage |
| `detectors/base.ts` | Generic structural detector (`AIDetector` interface) | DOM |
| `detectors/{chatgpt,claude,openwebui}.ts` | Platform selector profiles | – |
| `content/observer.ts` | Runs a detector, reports state, heartbeats, page lifecycle | runtime messaging |
| `background/tab-manager.ts` | Tab records, effective state (completion expiry, staleness), arbitration | – |
| `background/state-manager.ts` | Central state machine | – (injected timers) |
| `background/command-queue.ts` | Last-state-wins queue to the robot | – |
| `background/device-client.ts` | HTTP client (Wi-Fi) | fetch |
| `background/serial-protocol.ts` / `serial-client.ts` | COBS framing + Web Serial client (USB) | navigator.serial |
| `background/bridge.ts` | Wires everything, status, connection test | – (injected) |
| `background/index.ts` | Event listeners, persistence, alarms, content-script registration | tabs, windows, alarms, storage, scripting, permissions |

All logic modules take time, timers, `fetch` and the serial provider as injected dependencies, so they are tested without a browser.

## Data flow

1. A content script (registered only for enabled platforms) creates a `DomDetector`. It sends `hello` and receives non-secret timing values.
2. The detector samples structural signals on DOM mutations/input and on a 250 ms tick while something is happening. A new state must persist for `debounceMs` (300 ms) before it is emitted.
3. The content script sends `state` messages on change and a heartbeat every ≤10 s while not idle.
4. The background validates the message (shape, enums, sender is a top-frame tab, sender origin equals the platform's expected origin, platform enabled) and updates the tab registry.
5. `StateManager.evaluate()`:
   - effective tab state: `completed` expires after `completionMs`; busy states without heartbeat for `staleMs` become `unknown`;
   - arbitration selects one tab;
   - the selected state must be stable for `minStableMs` (500 ms) — `completed`/`error` are events and bypass this;
   - the mapped animation is requested from the queue, unless the mapping is “Do nothing”;
   - `none` after a one-shot animation (e.g. `ring`) is *assumed*, not sent, because the firmware returns to `none` itself;
   - continuous animations are re-posted every `keepaliveMs` while the tab is fresh, so the firmware's `continuous_timeout` does not fire mid-answer.
6. `CommandQueue` sends at most one request at a time, at least 1 s apart, drops intermediate states and duplicates, and backs off (2 s → 60 s) after failures.

## State machine (detector side)

```
          input in composer                         stop/streaming/busy marker
 idle ─────────────────────▶ user_typing ──┐      ┌──────────────────────────────┐
  ▲  ◀──── typingIdleMs ─────────────────── │      ▼                              │
  │                                          └──▶ thinking ◀──── no output ───▶ responding
  │                                                 │   ▲ tool marker              ▲ output DOM activity
  │                                                 ▼   │                          │
  │                                              tool_use ─────────────────────────┘
  │       generation signals gone ≥ endGraceMs
  ├──── user clicked stop (abort) ◀─────────────────┤
  ├──── completedHoldMs ◀──── completed ◀───────────┤ (otherwise)
  └──── errorHoldMs ◀──────── error ◀──── new error marker (any time)
 unknown: no composer/answer area recognized for 5 s
```

SPA navigation to another chat resets generation tracking, so switching chats never produces a false `completed`.

## Multi-tab arbitration

- **active-tab** (default): the most recently focused AI tab controls the robot. Focusing a non-AI tab keeps control with the last AI tab. Ties (no focus history) → most recently heard-from tab, then lowest tab id.
- **activity-priority**: rank busy (3) > completed/error (2) > user_typing (1) > idle/unknown (0); ties → focus recency, then most recent state change, then lowest tab id.

Because commands are deduplicated by animation, switching between tabs in the same state sends nothing.

## Firefox MV3 background lifecycle

The background is a non-persistent event page. Listeners are registered synchronously; handlers await an `init()` promise. Runtime state (tab registry, committed state, believed robot animation, status) is persisted to `storage.session` (debounced) and restored on wake, so a restart neither re-sends nor forgets the robot state. Timers may not survive suspension, so a 30 s `alarms` watchdog runs whenever a tab is busy, a continuous animation is active, or the robot is unreachable with auto-reconnect on. Content scripts are registered with `scripting.registerContentScripts` (non-persistent; re-synced on startup) and injected into already open tabs when a platform is enabled.

## Transports

| | Wi-Fi (default) | USB / Web Serial |
| --- | --- | --- |
| Operations | `GET /auth`, `GET /health`, `GET /anim`, `POST /anim?name=` | `sync`, `health`, `anim` |
| Auth | optional Bearer token (never on `/auth`, never in URL) | none (physical access) |
| Permission | per-host optional permission | port chosen via `requestPort()` in the options page |
| Framing | HTTP/JSON | COBS frames, 7-byte header, JSON payloads, 115200 baud |

Both implement `RobotClient`; `Bridge.client` picks one from `config.device.transport`.

## Browser targets

One codebase, two builds (`scripts/build.mjs --target=firefox|chrome`):

| | Firefox (`dist/`) | Chrome (`dist-chrome/`) |
| --- | --- | --- |
| Background | MV3 event page (`background.scripts`) | MV3 service worker (`background.service_worker`) |
| Manifest | `browser_specific_settings.gecko` (id, `data_collection_permissions`) | derived via `chromeManifest()`; `minimum_chrome_version: 120` |
| API namespace | `browser.*` | `browser.*` (Chrome ≥ 13x exposes it; a one-line banner aliases `chrome` for older versions) |
| USB | not available — Firefox grants Web Serial only to websites via site-permission add-ons | `RemoteSerialClient` in the worker forwards `auth/health/anim-get/anim` to `usb/index.html`, which owns the port with the same `SerialClient` |

`src/shared/target.ts` exposes the build target (`__TARGET__`). Messages are answered with `sendResponse` + `return true`, which works in both browsers.

```
Chrome service worker ── usbRequest {op, animation} ──▶ USB connection tab (Web Lock: one active)
       (no Web Serial)  ◀── DeviceResult (validated) ──     SerialClient → navigator.serial → robot
```

`tests-e2e/chrome.e2e.mjs` loads the Chrome build into real Chromium with the mock robot and a local Open WebUI fixture and checks settings → worker → HTTP, page detection → robot commands, the popup and the USB-tab routing.
