/**
 * The ONLY place where content scripts read on-screen text.
 *
 * Two narrowly scoped reads, both evaluated in memory and reduced to an
 * enumerated result before anything else sees them:
 *  - `classifyStatusLabel`: the short header of a non-text answer block
 *    (e.g. "Thinking…", "Searching the web", "Running command"). Labels
 *    longer than MAX_LABEL are ignored, so answer prose or thought content
 *    is never classified. Only the category leaves this module.
 *  - `hasDraft`: whether the prompt box contains anything (a boolean), to
 *    tell a real submit from Enter in an empty box.
 *
 * Nothing read here is stored, logged or transmitted. Enforced by
 * tests/architecture.test.ts (no other content-script source reads text).
 */

export type BlockCategory = 'thinking' | 'tool' | 'other';

/** Status headers are short; anything longer is content and is not looked at. */
export const MAX_LABEL = 80;

/**
 * Vocabulary of status headers. English and German UI; extend as needed.
 * Matched case-insensitively against the start of the label.
 */
const THINKING = [
  /^(thinking|thought|reasoning|pondering|considering|contemplating|reflecting)\b/i,
  /^(denkt|denke|nachdenken|nachgedacht|überleg|ueberleg|grübel)/i,
];

const TOOL = [
  /^(search|searched|searching|fetch|fetched|fetching|brows|look(ed|ing) up|read|reading|view|viewed|viewing|open(ed|ing)?)\b/i,
  /^(run|ran|running|execut|calling|called|used|using|creat|creating|created|edit|edited|editing|writ|wrote|updat|analy[sz]|install|download|upload|query|querying|list(ed|ing)?)/i,
  /^(such|durchsuch|ruft|rief|aufgerufen|führ|ausgeführt|erstell|bearbeit|schreib|les|liest|gelesen|analys|verwend|nutz|öffn|lade|herunter)/i,
];

/** Normalise whitespace and leading ellipses/bullets/icons-as-text. */
function normalise(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(/^[\s•·…\-–—:]+/, '').trim();
}

/** Classify a status header. Returns null when there is no usable short label. */
export function classifyLabelText(raw: string): BlockCategory | null {
  const text = normalise(raw);
  if (text.length === 0 || text.length > MAX_LABEL) return null;
  if (THINKING.some((r) => r.test(text))) return 'thinking';
  if (TOOL.some((r) => r.test(text))) return 'tool';
  return 'other';
}

/** Read and classify the label of a status header element. */
export function classifyStatusLabel(el: Element): BlockCategory | null {
  const text = el.textContent ?? '';
  // Cheap guard before normalising: long text is never a status header.
  if (text.length > MAX_LABEL * 4) return null;
  return classifyLabelText(text);
}

/** True when the prompt box contains any non-whitespace text (boolean only). */
export function hasDraft(composer: Element): boolean {
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) return composer.value.trim().length > 0;
  return (composer.textContent ?? '').trim().length > 0;
}
