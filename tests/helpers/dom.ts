import { readFileSync } from 'node:fs';
import path from 'node:path';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures');

/** Replace the current document body with a fixture's body (simulates a UI re-render). */
export function loadFixture(platform: string, name: string, doc: Document = document): void {
  const html = readFileSync(path.join(FIXTURES, platform, `${name}.html`), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  doc.body.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => doc.importNode(n, true)));
}

/** Append a text "token" to the last element matching selector (simulates streaming). */
export function appendToken(selector: string, doc: Document = document): void {
  const all = doc.querySelectorAll(selector);
  const target = all[all.length - 1];
  if (!target) throw new Error(`no element for ${selector}`);
  target.append(doc.createTextNode(' token'));
}

export function typeInto(selector: string, doc: Document = document): void {
  const el = doc.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
}

export function click(selector: string, doc: Document = document): void {
  const el = doc.querySelector(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  (el as HTMLElement).click();
}
