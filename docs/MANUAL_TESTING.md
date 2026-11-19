# Manual test checklist

Automated tests use synthetic fixtures and fake robots only. **Live behavior has not been verified** until the items below are checked on real sites and hardware. Record Firefox version, date and result.

Preparation: `npm run build`, load `dist/manifest.json` via `about:debugging`, enable **Debug logging** and keep Options → Diagnostics open in a second window. Without hardware use `npm run mock-robot -- --port 8080` (host `127.0.0.1`, port `8080`) and watch its console.

## Connection (Wi-Fi)
- [ ] Wrong IP → status Disconnected with a timeout message, browser stays responsive.
- [ ] Correct IP → Save & allow access shows Firefox permission prompt; Test connection shows firmware version, no robot motion.
- [ ] Robot with `access_token`: missing token → clear message; wrong token → 401 message; correct → Connected.
- [ ] Unplug robot power during use → Disconnected; plug back → reconnects within ~1 min (auto-reconnect on) and shows the current state.
- [ ] Each Test button in Animations plays the animation; normal control resumes after ~6 s.

## Chrome
- [ ] `chrome://extensions` → Developer mode → Load unpacked `dist-chrome/` (or the extracted `-chrome.zip`); settings page opens.
- [ ] Wi-Fi connection test and the per-platform checks below work as in Firefox.

## Connection (USB / Web Serial — Chrome only; Firefox shows it as unavailable)
- [ ] Options show whether Web Serial is available in this Firefox.
- [ ] Choose USB device lists the robot; Test connection reports “over USB” and the firmware version.
- [ ] Animations play over USB while the robot's Wi-Fi is off/USB-only.
- [ ] Unplug/replug the cable → next command reopens the port.
- [ ] Note whether opening the port reboots the robot, and whether commands still work after the background has been idle for > 1 min.

## Per platform (ChatGPT, Claude, Open WebUI)
- [ ] Idle chat → Diagnostics shows tab with `composer`, state Idle.
- [ ] Typing in the prompt → User typing (robot unchanged with default mapping).
- [ ] Press Enter → robot `thinking` within about half a second, even before the answer appears (Diagnostics signal `submitted`).
- [ ] Shift+Enter (new line) and Enter in an empty box do **not** start thinking.
- [ ] Extended thinking / tool use (web search, running a command): Diagnostics shows `block-thinking` / `block-tool`; robot `thinking` / `reading`.
- [ ] Answer streams → Responding → robot `typing`.
- [ ] Answer finishes → Completed → robot `ring`, then idle, no further command.
- [ ] Click Stop during an answer → idle, **no** `ring`.
- [ ] Long answer (> 5 min, e.g. deep research) → robot does not switch to `attention` mid-answer.
- [ ] Tool use / web search (Open WebUI) → Using a tool → robot `reading`.
- [ ] Provoke an error (e.g. disconnect network mid-answer) → Error → robot `error`.
- [ ] Switch to another chat during an answer → no false `ring`.
- [ ] Reload page during an answer → robot returns to idle; detector restarts.
- [ ] Close tab during an answer → robot returns to `none`.
- [ ] Non-English UI language: note which states still work.

## When a state is missed
- [ ] Diagnostics → Debug log on → reload the AI tab → send one prompt → wait for the answer → **Copy detection report** and attach it to the issue.

## Multiple tabs
- [ ] Active-tab mode: two AI tabs; only the focused one drives the robot; switching between idle tabs sends no command.
- [ ] Activity-priority mode: an answer in a background tab drives the robot; its completion rings.

## Lifecycle & privacy
- [ ] Disable the extension switch → robot goes to `none`, no further commands.
- [ ] Disable a platform → its tabs stop reporting.
- [ ] Wait > 1 min idle (background suspends), then start an answer → works, no duplicate command on wake.
- [ ] Browser console / debug log contain no conversation text, token or URLs with secrets.
- [ ] Network monitor (Browser Toolbox): the extension contacts only the robot.
