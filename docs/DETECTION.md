# Detection: signals, selectors and assumptions

## What is (and is not) observable

Web UIs do not expose a model's internal phases. The detectors therefore report what the **page shows**:

| State | Meaning in this extension |
| --- | --- |
| `thinking` | A request is in progress (stop control / busy marker visible) but no answer output is being added right now, or the platform shows an explicit thinking marker. |
| `responding` | Nodes inside the assistant's answer area are being added/changed while a request is in progress. |
| `tool_use` | An explicit in-progress tool/status marker is visible (Open WebUI only). |
| `completed` | Request signals disappeared (for ≥ 700 ms) without a user click on stop and without a new error. |
| `error` | A new error marker appeared (errors already on the page when it loaded are ignored). |
| `user_typing` | `input` events on the prompt composer in the last 4 s. Only the event timestamp is used. |
| `unknown` | Neither composer nor answer area was recognized for 5 s (layout changed / not a chat page). |

Extended reasoning that streams text into the page usually appears as `responding`; a long silent wait appears as `thinking`.

## Live findings

| Date | Platform | Result |
| --- | --- | --- |
| 2026-11-19 | Claude | idle, user typing, responding, completed and mid-answer thinking detected. Initial thinking not shown. Tool/command use shown as thinking (no Claude tool rule yet). |
| 2026-11-19 | Claude | A rule ignoring changes inside `aria-busy`/status elements broke responding (Claude marks the streaming message busy) → **reverted**. Detection report verified `div[data-testid=assistant-message][data-is-streaming]`, answer text in `div.prose > div[data-alluvium]` as `span[data-wf]` chunks; the stop button was **not** matched. In the reported request, text started ~50 ms after the request (no visible thinking phase). Next: report from a request with a visible “Thinking…” phase and a tool call. |

## Detection report

With **Debug log** on, the extension records a structural trace of each request: which elements changed (tag, id, classes, a few allowlisted attributes such as `data-testid`, `data-state`, `aria-expanded`), whether the detector counted the change as answer output, and a timeline of signals and states. It never contains text, labels (except “stop…” control labels) or URLs, is validated by the background, kept in memory only, and copied with **Diagnostics → Copy detection report**. Attach it to issues about missed states.

## Signals (reported to Diagnostics)

`composer`, `stop-button`, `generating-marker`, `streaming-marker`, `response-activity`, `thinking-marker`, `tool-marker`, `error-marker`, `user-input`, `user-abort`, `layout-unrecognized`.

Confidence values: idle with composer 0.9, responding with marker + activity 0.9, activity only 0.75, tool 0.75, thinking 0.55–0.6, error 0.75, completed 0.8, unknown 0.2.

## Platform selectors

### ChatGPT — `src/detectors/chatgpt.ts` — **unverified assumptions**

| Purpose | Selector(s) |
| --- | --- |
| composer | `#prompt-textarea`, `[data-testid="prompt-textarea"]`, `form [contenteditable="true"]`, `form textarea` |
| stop | `button[data-testid="stop-button"]`; English fallback aria-label `Stop streaming` / `Stop generating` (bare “Stop” is excluded — read-aloud uses it) |
| streaming | `.result-streaming` |
| answer area | `[data-message-author-role="assistant"]` |
| error | `[data-testid="error-message"]`, `.text-token-text-error` |
| tool | none known |

### Claude — `src/detectors/claude.ts` — **unverified assumptions**

| Purpose | Selector(s) |
| --- | --- |
| composer | `[data-testid="chat-input"]`, `div.ProseMirror[contenteditable="true"]`, `fieldset [contenteditable="true"]` |
| stop | `button[data-testid="stop-button"]`; English fallback aria-label `Stop response` / `Stop generating` |
| streaming | `[data-is-streaming="true"]` |
| answer area | `[data-is-streaming]`, `.font-claude-response`, `.font-claude-message` |
| error | `[data-testid="message-error"]` |
| tool | none known |

### Open WebUI — `src/detectors/openwebui.ts` — **from source, commit `0666e59` (2026-11-17)**

| Purpose | Selector(s) | Source |
| --- | --- | --- |
| composer | `#chat-input` (+ fallbacks) | `MessageInput.svelte` (`id={inputId}`) |
| stop | `#message-input-container button[aria-label="Stop"]` (i18n → English only) | `MessageInput.svelte` |
| generating | `#response-content-container .animate-cursor-pulse` | `ResponseMessage.svelte`, shown while `!message.done` |
| tool | `.status-description .shimmer` | `StatusHistory/StatusItem.svelte` |
| error | `[data-sonner-toast][data-type="error"]` | svelte-sonner toasts (library behavior, not checked in source) |
| answer area | `#response-content-container` | `ResponseMessage.svelte` |

Open WebUI hides its stop button while the user types during a generation; the cursor marker keeps the request detected.

## What still needs live validation

Everything above for ChatGPT and Claude, the Open WebUI error toast selector, and all platforms in non-English UI languages. Use `docs/MANUAL_TESTING.md` and report results (signals only, no content) in an issue.
