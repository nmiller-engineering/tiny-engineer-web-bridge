# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-11-19

### Added
- **Off = sleep:** turning the robot link off sends the robot to `sleep`; turning it on sends `wakeup`.
- **Unreachable robot is visible:** while on, an orange “!” on the toolbar icon (and a hint in the popup) shows that the robot does not answer — e.g. after it lost Wi-Fi or got a new IP address.
- **Simpler popup:** a big “Robot link on/off” button and an “Open dashboard” button (connection test moved to a small link).
- **Toolbar on/off:** the toolbar icon turns grey with an “OFF” badge while the bridge is off.
- **Keyboard shortcut** **Alt+Shift+R** turns the bridge on/off (changeable in the browser's extension shortcut settings).
- **One-click mode (optional):** a click on the icon turns the bridge on/off instead of opening the popup; settings and on/off are in the icon's right-click menu. Choose under Settings → Behaviour or via the right-click menu.

### Fixed
- **ChatGPT “typing” not detected:** answers rendered as list items (`li[data-message-role=assistant]`) are now recognised; selectors cross-checked with the maintained chatgpt.js library.

### Changed
- New permission `contextMenus` (right-click menu of the toolbar icon only).

## [1.0.0] - 2026-11-18

First public release.

### Added
- **Chrome / Chromium** build (`npm run build:chrome`, `npm run package:chrome`) from the same codebase, with an automated end-to-end test in real Chromium (`npm run test:e2e`).
- Detection of AI activity on **ChatGPT**, **Claude** and any self-hosted **Open WebUI** from page structure only (idle, user typing, thinking, responding, tool use, completed, error, unknown). No conversation content is read.
- Direct control of the Tiny Engineer robot over **Wi-Fi** (HTTP API, optional Bearer token) or, in Chrome, **USB** (Web Serial via a pinned “USB connection” tab, upstream serial protocol). USB is not available in Firefox, which grants Web Serial only to websites.
- Configurable animation for each state with one-click test, plus “Do nothing”.
- Central state machine with debouncing, duplicate suppression, last-state-wins queue, reconnect back-off, keepalive for long answers and a lost-signal fallback.
- Multi-tab handling: *Active tab* or *Busy tab first*.
- **Robust fallback:** if a site's busy markers change, answer growth after sending still drives `responding`/`completed`; broader ChatGPT stop-button rules.
- **Agent runs:** “completed” only when the whole task is finished — pauses between steps (up to 2 s, configurable) and Claude's turn-level busy markers keep the task running.
- **Fast, layered detection:** pressing Enter/send starts `thinking` immediately (before the answer exists); the active answer block distinguishes text, thinking and tool blocks (short status headers, English + German); faster defaults (debounce 150 ms, stability 250 ms, command spacing 250 ms).
- Optional **detection report** (debug mode): a structural, text-free trace of what changed during a request, to fix detection after website changes.
- Popup with live activity and robot status; settings page with onboarding, connection test, platform permissions, timing and diagnostics. Light and dark theme.
- Reproducible `.xpi` and source archives; CI and tag-based release workflow with optional Mozilla (unlisted) signing.

### Security
- Strict message validation and origin binding, minimal permissions, per-host permission prompts, no runtime dependencies, no telemetry. See SECURITY.md for the review log.

[1.1.0]: https://github.com/nmiller-engineering/tiny-engineer-web-bridge/releases/tag/v1.1.0
[1.0.0]: https://github.com/nmiller-engineering/tiny-engineer-web-bridge/releases/tag/v1.0.0
