# Contributing

Thanks for helping! The most valuable contributions are **detector updates** when ChatGPT, Claude or Open WebUI change their markup.

## Setup

```bash
npm install
npm run dev            # watch build into dist/
npm run start:firefox  # Firefox with the extension loaded
npm test && npm run lint && npm run lint:firefox
```

## Rules

- Never read, log, store or transmit conversation text. Detectors may only use structure: element presence/visibility, attributes, accessible labels of UI controls, and the *fact* that nodes change.
- Content scripts must not import `shared/config`, `shared/storage` or anything in `background/`, and must not use network APIs (enforced by ESLint and `tests/architecture.test.ts`).
- Do not present selectors as verified unless you tested them on the live site; note version/date in `docs/DETECTION.md`.
- Every selector change needs a fixture in `tests/fixtures/<platform>/` and a test. Fixtures must be synthetic (no real conversations).
- Keep dependencies minimal; no runtime dependencies.
- No `innerHTML`; build DOM with `textContent`/`createElement`.

## Updating a detector

1. Open the site with the extension loaded, enable debug logging, and look at Options → Diagnostics (signals per tab).
2. Inspect the stop button / streaming area in the Firefox inspector and adjust `src/detectors/<platform>.ts`.
3. Update or add fixtures and run `npm test`.
4. Record the change in `docs/DETECTION.md`, and walk through `docs/MANUAL_TESTING.md`.

## Commits & PRs

Small, focused PRs. CI runs lint, typecheck, tests, `web-ext lint` and a reproducible packaging check.
