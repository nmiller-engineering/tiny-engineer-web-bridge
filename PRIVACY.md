# Privacy policy — Tiny Engineer Web Bridge

_Last updated: 2026-11-18_

**Short version: the extension collects nothing, sends nothing to us, and never reads your conversations.**

## What the extension does
It watches the *structure* of ChatGPT, Claude and Open WebUI pages (for example whether a “stop” button is visible or whether the answer area is changing) and tells your Tiny Engineer robot which animation to play.

## Data it does not collect
- No conversation content: prompts and answers are never read, stored or transmitted.
- No passwords, cookies, session tokens or account data of AI services.
- No analytics, telemetry, crash reports, advertising identifiers or remote logging.
- No browsing history; the extension only runs on the AI sites you enable.

## Data stored on your computer
Your settings (robot address, port, optional robot token, chosen USB device, enabled platforms, animation mapping, timing) are stored in Firefox's extension storage of your profile. They are **not encrypted** and never synced. Uninstalling the extension removes them. An optional debug log lives only in memory and contains states and error categories, never content or tokens.

## Network communication
The only network traffic the extension creates is to **your own robot** at the address you enter (Wi-Fi), or over the USB cable you select. This traffic contains only animation commands and status queries. The Wi-Fi connection to the robot is plain HTTP inside your local network.

## Permissions
Site access to chatgpt.com and claude.ai, and — only after you allow it — to your Open WebUI address and your robot's address. See SECURITY.md for details.

## Contact
Questions or concerns: open an issue at https://github.com/nmiller-engineering/tiny-engineer-web-bridge/issues
