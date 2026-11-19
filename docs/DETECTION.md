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
| 2026-11-19 | Claude | Root cause of unreliable initial thinking: before the answer element exists, no signal was visible (stop button not matched). New layer: submit detection (Enter/send) → thinking immediately; block model for thinking/tool blocks. Real-Chromium test: Enter → robot `thinking` in ~330 ms. Awaiting live verification on claude.ai. |
| 2026-11-19 | Claude | A rule ignoring changes inside `aria-busy`/status elements broke responding (Claude marks the streaming message busy) → **reverted**. Detection report verified `div[data-testid=assistant-message][data-is-streaming]`, answer text in `div.prose > div[data-alluvium]` as `span[data-wf]` chunks; the stop button was **not** matched. In the reported request, text started ~50 ms after the request (no visible thinking phase). Next: report from a request with a visible “Thinking…” phase and a tool call. |

## Detection report

With **Debug log** on, the extension records a structural trace of each request: which elements changed (tag, id, classes, a few allowlisted attributes such as `data-testid`, `data-state`, `aria-expanded`), whether the detector counted the change as answer output, and a timeline of signals and states. It never contains text, labels (except “stop…” control labels) or URLs, is validated by the background, kept in memory only, and copied with **Diagnostics → Copy detection report**. Attach it to issues about missed states.

## Detection design (layers, fastest first)

1. **Submit** — Enter (without Shift, not during IME composition) in a non-empty prompt box, or a click on the send control with a draft, starts a *pending request* → `thinking` immediately. It is confirmed when a new user message appears (`userMessage` selectors) and then lasts until the answer starts (max. 60 s); unconfirmed it expires after 4 s. This covers the phase before the platform creates any answer element (on Claude: before `data-is-streaming` appears), which is when users see “thinking”.
2. **Lifecycle** — stop control / streaming / busy markers start and end a generation (end needs 700 ms without signals).
3. **Active answer block** (profiles with a block model; Claude) — the last block of the streaming answer decides:
   text block (`.prose`) → `responding` while it grows, `thinking` during pauses; non-text block → its short status header is classified: thinking vocabulary → `thinking`, tool vocabulary → `tool_use`, unknown → `thinking` (never “responding”).
4. **Answer activity** — fallback for platforms without a block model: DOM growth in the answer area → `responding`, otherwise `thinking`.

Pipeline latency with defaults (debounce 150 ms, stable 250 ms, command spacing 250 ms): Enter → robot command ≈ 0.3–0.5 s. Measured in real Chromium by `npm run test:e2e`: ~330 ms (with 150 ms stability).

## Signals (reported to Diagnostics)

`composer`, `stop-button`, `generating-marker`, `streaming-marker`, `response-activity`, `thinking-marker`, `tool-marker`, `error-marker`, `user-input`, `user-abort`, `layout-unrecognized`, `submitted`, `block-text`, `block-thinking`, `block-tool`.

Confidence values: idle with composer 0.9, responding with marker + activity 0.9, activity only 0.75, tool 0.75, thinking 0.55–0.6, error 0.75, completed 0.8, unknown 0.2.

## Platform selectors

### Status label vocabulary (`src/detectors/labels.ts`)

Thinking: thinking, thought, reasoning, pondering, considering, … / denkt, nachdenken, überlegt, …
Tool: search(ed/ing), fetch, read, view, open, run/ran, execut…, calling, used/using, creat…, edit, writ…, analy…, install, download, query … / such…, ruft, führt aus, erstell…, bearbeit…, schreib…, les…, analys…, verwend…, nutz…
Labels longer than 80 characters are ignored. Extend the lists when a platform prints new status words.

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
| answer area | `[data-testid="assistant-message"]` (**verified**), `[data-is-streaming]` (**verified**), `.font-claude-response`, `.font-claude-message` |
| answer blocks | `[data-testid=assistant-message][data-is-streaming=true] [data-item-key]`, text = `.prose` (**verified**); status header = `button, [aria-expanded], summary, [role=status]` (assumed) |
| user messages / send | `[data-testid="user-message"]`, `button[aria-label^="send" i]` (assumed) |
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
