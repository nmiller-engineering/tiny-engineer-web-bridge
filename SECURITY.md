# Security & privacy architecture

## Threat model

| Actor | Can | Must not be able to |
| --- | --- | --- |
| AI website (page scripts, page content) | change its DOM, dispatch events | read config/token, make the extension contact arbitrary hosts, send arbitrary commands, exfiltrate data |
| Other websites | nothing (no content scripts there) | – |
| Local network attacker | sniff/spoof plain HTTP to the robot | – (inherent firmware limitation, see below) |
| Anyone with access to the Firefox profile | read extension storage | – (storage is not encrypted) |

## Trust boundaries

1. **Content scripts are untrusted.** They run inside AI pages and are compiled from `src/content` + `src/detectors` only. Lint rules and `tests/architecture.test.ts` ensure these bundles contain no config, storage, device client, `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` or `navigator.serial`, and never read page text (`textContent`/`innerText`/`innerHTML`).
2. **Messages are validated** (`parseContentMessage`): exact key set, protocol version, enumerated platform/state/signal names, bounded confidence and sequence numbers. A content script cannot name a URL, method, header, body or animation — the background maps states to animations itself.
3. **Sender checks:** only top-frame tab senders of this extension; the sender's origin must equal the platform's expected origin (`https://chatgpt.com`, `https://claude.ai`, or the exact configured Open WebUI origin including port). Privileged requests (`getStatus`, `testConnection`, `testAnimation`, debug log) are only accepted from this extension's own pages.
4. **The device clients** can reach only the configured robot and only the documented endpoints/ops. Animation names come from a fixed allowlist.

## Network security (Wi-Fi)

- The firmware speaks plain HTTP; **traffic and the Bearer token are not encrypted** on your LAN. Use a trusted network; consider a dedicated IoT VLAN.
- Host validation: IPv4 or DNS hostname only; scheme, port, path, query, fragment, credentials (`user@`), IPv6 literals, `0.x`, multicast and broadcast are rejected. The URL is rebuilt and re-checked before every request.
- The token is sent only in `Authorization: Bearer …`, never in the URL, never to the public `/auth` endpoint, never logged. Tokens must be visible ASCII (prevents header injection).
- Requests use `redirect: 'manual'` (redirects are reported, not followed — the firmware redirects to its setup AP in provisioning mode), `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`, a timeout, and a 16 KiB response limit. Only known JSON fields are read.
- Firefox host permission for the robot is requested explicitly (`optional_host_permissions`) for the single host the user entered; an old robot host permission is removed when the address changes. `optional_host_permissions` lists `http://*/*` and `https://*/*` only so that a user-entered host *can be requested*; the extension never requests the wildcard itself.
- The extension pages' CSP omits Firefox's default `upgrade-insecure-requests` (it would break plain-HTTP robot access) and otherwise allows only `'self'` resources: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src http:; object-src 'none'; base-uri 'none'; form-action 'none'`. `connect-src http:` cannot name the user's host statically; the device client enforces the destination.

## USB / Web Serial

- The port is selected by the user via `navigator.serial.requestPort()` on the options page; the background only uses already granted ports (`getPorts()`) and never prompts.
- Only `sync`, `health` and `anim` (allowlisted name) are sent; log/event/stream frames from the device are ignored; frames are size-bounded and malformed frames are dropped.
- The serial protocol has no authentication: anyone with physical access can control the robot.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | settings (`local`), runtime state across suspension (`session`) |
| `scripting` | register detectors only for enabled platforms; inject into tabs already open |
| `alarms` | watchdog so the robot never stays busy after a lost signal while the background is suspended |
| host `https://chatgpt.com/*`, `https://claude.ai/*` | run the detectors there |
| optional host (requested per host) | the robot's address; the Open WebUI origin |

No `tabs`, `<all_urls>`, `webRequest`, `cookies`, `history` or `clipboard` permissions. No `fetch` monkey-patching and no response-body interception.

## Data handling

- No telemetry, analytics, remote logging, or remote code. All scripts are bundled; the manifest declares `data_collection_permissions: none`.
- Conversation content, passwords, cookies, AI session tokens and auth headers are never read or collected.
- Settings are stored in `browser.storage.local` of the Firefox profile — **not encrypted** — and never in `storage.sync`. Content scripts never access storage.
- The debug log is off by default, in memory only, capped, and contains only states, platform names, tab ids, animation names and error categories. Tab titles/URLs are not stored.

## Optional advanced (network) detection

Observing network-request metadata (`webRequest`) was considered. It would require broad host permissions and request-level access to AI sites, and DOM signals already provide the needed transitions. It is **not implemented**; no request bodies are intercepted and `fetch` is not patched.

## Reporting a vulnerability

Please open a GitHub security advisory (private) on this repository rather than a public issue.
