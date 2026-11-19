# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-18

First public release.

### Added
- **Chrome / Chromium** build (`npm run build:chrome`, `npm run package:chrome`) from the same codebase, with an automated end-to-end test in real Chromium (`npm run test:e2e`).
- Detection of AI activity on **ChatGPT**, **Claude** and any self-hosted **Open WebUI** from page structure only (idle, user typing, thinking, responding, tool use, completed, error, unknown). No conversation content is read.
- Direct control of the Tiny Engineer robot over **Wi-Fi** (HTTP API, optional Bearer token) or, in Chrome, **USB** (Web Serial via a pinned “USB connection” tab, upstream serial protocol). USB is not available in Firefox, which grants Web Serial only to websites.
- Configurable animation for each state with one-click test, plus “Do nothing”.
- Central state machine with debouncing, duplicate suppression, last-state-wins queue, reconnect back-off, keepalive for long answers and a lost-signal fallback.
- Multi-tab handling: *Active tab* or *Busy tab first*.
- **Fast, layered detection:** pressing Enter/send starts `thinking` immediately (before the answer exists); the active answer block distinguishes text, thinking and tool blocks (short status headers, English + German); faster defaults (debounce 150 ms, stability 250 ms, command spacing 250 ms).
- Optional **detection report** (debug mode): a structural, text-free trace of what changed during a request, to fix detection after website changes.
- Popup with live activity and robot status; settings page with onboarding, connection test, platform permissions, timing and diagnostics. Light and dark theme.
- Reproducible `.xpi` and source archives; CI and tag-based release workflow with optional Mozilla (unlisted) signing.

### Security
- Strict message validation and origin binding, minimal permissions, per-host permission prompts, no runtime dependencies, no telemetry. See SECURITY.md for the review log.

[1.0.0]: https://github.com/nmiller-engineering/tiny-engineer-web-bridge/releases/tag/v1.0.0
