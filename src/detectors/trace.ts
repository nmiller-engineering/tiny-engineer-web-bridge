/**
 * Opt-in structural trace of one AI request ("detection report").
 *
 * Enabled only while the user has debug logging switched on. Records WHICH
 * elements change while a request runs, described by tag name, id, CSS
 * classes and a few allowlisted attributes — never text, never aria-labels
 * (except stop-control labels, which are UI chrome), never URLs. The report
 * lets a maintainer write precise detection rules after a website change.
 */

/** Characters allowed in descriptors; everything else is dropped. */
const DESCRIPTOR_CHARS = /[^\w\-:./[\]%#()="^ >,]/g;
const MAX_DESCRIPTOR = 700;
const MAX_EVENTS = 3000;
const MAX_MUTATIONS = 100;
const MAX_TIMELINE = 120;
const KEEP_MS = 120_000;

/** Attributes whose values are structural (never user content). */
const VALUE_ATTRS = [
  'data-testid',
  'data-is-streaming',
  'data-busy',
  'data-cds-reply-type',
  'data-transcript-live',
  'data-state',
  'data-status',
  'data-type',
  'role',
  'aria-expanded',
  'aria-busy',
  'aria-live',
  'aria-hidden',
];

export type TraceMutationType = 'child' | 'text' | 'attr';

export interface TraceMutation {
  /** Structural path, outermost first, e.g. "div[data-is-streaming=true] > div.font-claude-response > p". */
  d: string;
  type: TraceMutationType;
  /** Whether the detector counted this as "answer being written". */
  act: boolean;
  /** Descriptor of the first added element (childList only). */
  add: string;
  n: number;
  /** ms relative to generation start. */
  first: number;
  last: number;
}

export interface TraceReport {
  durationMs: number;
  timeline: { t: number; e: string }[];
  mutations: TraceMutation[];
}

function clean(s: string, max = MAX_DESCRIPTOR): string {
  return s.replace(DESCRIPTOR_CHARS, '').slice(0, max);
}

/** One element as `tag#id.class1.class2[attr=value][data-flag]`. No text, no labels. */
export function describeNode(el: Element): string {
  let s = el.tagName.toLowerCase();
  if (el.id && /^[\w-]{1,48}$/.test(el.id)) s += `#${el.id}`;
  const classes = Array.from(el.classList)
    .filter((c) => /^[\w\-:./[\]%()]{1,48}$/.test(c))
    .slice(0, 6);
  if (classes.length) s += `.${classes.join('.')}`;
  for (const name of VALUE_ATTRS) {
    const v = el.getAttribute(name);
    if (v !== null && /^[\w-]{0,24}$/.test(v)) s += `[${name}=${v}]`;
  }
  // Other data-* attributes: names only (values could be anything).
  for (const a of Array.from(el.attributes)) {
    if (a.name.startsWith('data-') && !VALUE_ATTRS.includes(a.name) && /^[\w-]{1,40}$/.test(a.name)) s += `[${a.name}]`;
  }
  if (el.matches('[aria-label^="stop" i]')) s += '[aria-label^=stop]';
  return clean(s, 260);
}

/** Path from `el` up to (and including) `stopAt`, or at most `depth` levels. */
export function describePath(el: Element, stopAt: Element | null, depth = 6): string {
  const parts: string[] = [];
  for (let n: Element | null = el; n && parts.length < depth; n = n.parentElement) {
    parts.unshift(describeNode(n));
    if (n === stopAt || n.tagName === 'BODY') break;
  }
  return clean(parts.join(' > '));
}

interface Event {
  at: number;
  d: string;
  type: TraceMutationType;
  act: boolean;
  add: string;
}

export class TraceRecorder {
  enabled = false;
  private events: Event[] = [];
  private timeline: { at: number; e: string }[] = [];
  private report: TraceReport | null = null;

  constructor(private readonly onReport?: (report: TraceReport) => void) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.events = [];
      this.timeline = [];
    }
  }

  mutation(at: number, d: string, type: TraceMutationType, act: boolean, add = ''): void {
    if (!this.enabled) return;
    this.events.push({ at, d, type, act, add: clean(add, 260) });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  /** Signal or state change, e.g. "+stop-button", "-streaming-marker", "state:thinking". */
  mark(at: number, event: string): void {
    if (!this.enabled) return;
    this.timeline.push({ at, e: clean(event, 60) });
    if (this.timeline.length > MAX_TIMELINE * 3) this.timeline.splice(0, this.timeline.length - MAX_TIMELINE * 3);
  }

  /** Build the report for a finished generation [start, end]. */
  finish(start: number, end: number): TraceReport | null {
    if (!this.enabled) return null;
    const from = start - 1500;
    const to = end + 500;
    const groups = new Map<string, TraceMutation>();
    for (const ev of this.events) {
      if (ev.at < from || ev.at > to) continue;
      const key = `${ev.type}|${ev.act}|${ev.d}|${ev.add}`;
      const g = groups.get(key);
      const t = ev.at - start;
      if (g) {
        g.n++;
        g.last = t;
      } else {
        groups.set(key, { d: ev.d, type: ev.type, act: ev.act, add: ev.add, n: 1, first: t, last: t });
      }
    }
    const report: TraceReport = {
      durationMs: end - start,
      timeline: this.timeline
        .filter((x) => x.at >= from && x.at <= to)
        .slice(0, MAX_TIMELINE)
        .map((x) => ({ t: x.at - start, e: x.e })),
      mutations: [...groups.values()].sort((a, b) => a.first - b.first).slice(0, MAX_MUTATIONS),
    };
    const cutoff = end - KEEP_MS;
    this.events = this.events.filter((e) => e.at >= cutoff);
    this.timeline = this.timeline.filter((e) => e.at >= cutoff);
    this.report = report;
    this.onReport?.(report);
    return report;
  }

  get lastReport(): TraceReport | null {
    return this.report;
  }
}
