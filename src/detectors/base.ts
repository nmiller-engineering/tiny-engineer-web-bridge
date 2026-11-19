/**
 * DOM-based AI activity detection.
 *
 * A detector watches *structure*, never conversation text:
 *  - presence/visibility of a "stop generating" control,
 *  - explicit streaming / busy / tool / error markers (attributes, classes),
 *  - the fact that DOM nodes inside the assistant's response area are being
 *    added or changed (counts and timestamps only — no text is read),
 *  - `input` events on the prompt composer (timestamps only),
 *  - clicks on the stop control (to tell user aborts from completions).
 *
 * Limitation: web UIs rarely expose the model's internal phases. "thinking"
 * here means "a request is in progress but no response output has been seen
 * yet (or a platform marks it explicitly)"; "responding" means "response
 * content is visibly being streamed into the page". Nothing more is claimed.
 */
import type { AIState, DetectionSnapshot, Platform, SignalName } from '../shared/types';
import { classifyStatusLabel, hasDraft, type BlockCategory } from './labels';
import { describeNode, describePath, TraceRecorder, type TraceReport } from './trace';

export interface AIDetector {
  readonly platform: string;
  initialize(): void;
  getState(): AIState;
  subscribe(callback: (state: AIState) => void): () => void;
  destroy(): void;
}

/** A label-based fallback for stop controls, optionally limited to a container. */
export interface LabelRule {
  /** CSS selector of the container to search in; null = whole document. */
  scope: string | null;
  /** Matched against the button's aria-label (UI chrome, not conversation content). */
  pattern: RegExp;
}

/**
 * Selectors describing one web UI. Every selector is an *assumption* about a
 * third-party UI; see docs/DETECTION.md for provenance and verification status.
 */
export interface PlatformProfile {
  platform: Platform;
  /** The prompt input. */
  composer: string[];
  /** Language-independent stop/cancel controls. */
  stopButtons: string[];
  /** aria-label fallbacks for stop controls (UI-language dependent). */
  stopLabels: LabelRule[];
  /** "Request in progress" markers that do not imply output yet (small indicator elements; changes inside them are not answer output). */
  generating: string[];
  /**
   * Turn-level busy markers on containers (e.g. the whole answer message):
   * the task is running while one is present. Unlike `generating`, changes
   * inside them still count as answer output.
   */
  busy?: string[];
  /** Explicit "output is streaming" markers. */
  streaming: string[];
  /** Explicit "model is thinking/reasoning" markers. */
  thinking: string[];
  /** Explicit "tool is running" markers. */
  tool: string[];
  /** Error markers (counted; only *new* ones trigger the error state). */
  error: string[];
  /** Containers of assistant responses (for streaming activity). */
  response: string[];
  /** Messages the user sent; a count increase confirms a submit. */
  userMessage?: string[];
  /** Send controls (a click with a non-empty prompt = submit). */
  sendButtons?: string[];
  /**
   * Answer blocks. The last element matching `items` is the active block:
   * if it is/contains `text` it is answer prose; otherwise its `header`
   * (a short status label such as "Thinking…" or "Searching the web") is
   * classified into thinking/tool.
   */
  blocks?: { items: string; text: string; header: string };
}

export interface DetectorTiming {
  /** A new state must persist this long before it is emitted. */
  debounceMs: number;
  /** User-typing ends after this much input inactivity. */
  typingIdleMs: number;
  /** How long `completed` is reported after a generation ends. */
  completedHoldMs: number;
  /** How long a new error is reported. */
  errorHoldMs: number;
  /**
   * Generation is considered over only after all busy signals are absent this
   * long. Agents pause between steps (tool execution); those gaps keep the
   * task running (reported as thinking) instead of completing it.
   */
  endGraceMs: number;
  /** Response DOM activity counts as "streaming" for this long. */
  activityWindowMs: number;
  /** After this long without recognizable UI, report `unknown`. */
  unrecognizedAfterMs: number;
  /** A submit counts as a pending request for this long without confirmation… */
  pendingUnconfirmedMs: number;
  /** …and for this long once the user's message appeared but no answer yet. */
  pendingConfirmedMs: number;
}

export const DEFAULT_DETECTOR_TIMING: DetectorTiming = {
  debounceMs: 150,
  typingIdleMs: 4000,
  completedHoldMs: 3000,
  errorHoldMs: 8000,
  endGraceMs: 2000,
  activityWindowMs: 2500,
  unrecognizedAfterMs: 5000,
  pendingUnconfirmedMs: 4000,
  pendingConfirmedMs: 60_000,
};

const TICK_MS = 250;

/** Controls/indicators that the detection report records wherever they appear. */
const TRACE_CONTROLS = 'button, [role="button"], summary, [aria-expanded], [role="status"], [role="progressbar"]';
const MUTATION_COALESCE_MS = 60;

/** Raw structural observations at one instant. Exported for tests. */
export interface RawSignals {
  composer: boolean;
  response: boolean;
  stop: boolean;
  generatingMarker: boolean;
  busyMarker: boolean;
  streamingMarker: boolean;
  thinkingMarker: boolean;
  toolMarker: boolean;
  errorCount: number;
}

interface Tracker {
  generating: boolean;
  genStartedAt: number;
  notGeneratingSince: number | null;
  lastResponseActivityAt: number;
  lastInputAt: number;
  abortAt: number;
  errorBaseline: number;
  completedAt: number | null;
  errorAt: number | null;
  path: string;
  /** Last submit (Enter/send click with a non-empty prompt). */
  submitAt: number;
  /** User-message count at submit time. */
  userMsgBaseline: number;
  /** Category of the active answer block (for tracing changes). */
  lastBlock: string;
}

/** Visible enough to count: connected, not hidden by attribute or inline/computed style. */
export function isShown(el: Element): boolean {
  if (!el.isConnected) return false;
  if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const view = el.ownerDocument.defaultView;
  if (!view) return true;
  for (let n: Element | null = el; n; n = n.parentElement) {
    const style = view.getComputedStyle(n);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return []; // an invalid selector must never break detection
  }
}

function safeClosest(el: Element, selector: string): Element | null {
  try {
    return el.closest(selector);
  } catch {
    return null;
  }
}

function countAll(root: ParentNode, selectors: string[]): number {
  if (selectors.length === 0) return 0;
  return safeQueryAll(root, selectors.join(', ')).length;
}

function anyShown(root: ParentNode, selectors: string[]): boolean {
  return selectors.some((s) => safeQueryAll(root, s).some(isShown));
}

function countShown(root: ParentNode, selectors: string[]): number {
  const seen = new Set<Element>();
  for (const s of selectors) for (const el of safeQueryAll(root, s)) if (isShown(el)) seen.add(el);
  return seen.size;
}

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function closestAny(el: Element, selectors: string[]): Element | null {
  for (const s of selectors) {
    const hit = safeClosest(el, s);
    if (hit) return hit;
  }
  return null;
}

function matchesLabelRule(button: Element, rules: LabelRule[], doc: Document): boolean {
  // Never look at labels of other controls (they may contain chat titles).
  if (rules.length === 0 || !button.matches('[aria-label^="stop" i]')) return false;
  const label = button.getAttribute('aria-label')?.trim();
  if (!label) return false;
  return rules.some((r) => {
    if (!r.pattern.test(label)) return false;
    if (r.scope === null) return true;
    return safeQueryAll(doc, r.scope).some((scope) => scope.contains(button));
  });
}

export interface DomDetectorOptions {
  document?: Document;
  now?: () => number;
  timing?: Partial<DetectorTiming>;
  /** Override for tests: current path used to detect SPA chat switches. */
  getPath?: () => string;
  /** Receives a structural trace after each request while tracing is enabled. */
  onReport?: (report: TraceReport) => void;
}

/** Generic detector driven by a PlatformProfile. */
export class DomDetector implements AIDetector {
  readonly platform: Platform;
  private readonly doc: Document;
  private readonly now: () => number;
  private readonly getPath: () => string;
  private timing: DetectorTiming;

  private observer: MutationObserver | null = null;
  private listeners = new Set<(state: AIState) => void>();
  private evalTimer: ReturnType<typeof setTimeout> | null = null;
  private evalAt = Number.POSITIVE_INFINITY;
  private initializedAt = 0;
  private active = false;

  private emitted: DetectionSnapshot = { state: 'idle', confidence: 0.3, signals: [] };
  readonly trace: TraceRecorder;
  private lastRawKey = '';
  private pending: { state: AIState; since: number } | null = null;
  private t: Tracker;

  private readonly onInput = (ev: Event) => this.handleInput(ev);
  private readonly onKeyDown = (ev: Event) => this.handleKeyDown(ev as KeyboardEvent);
  private readonly onClick = (ev: Event) => this.handleClick(ev);

  constructor(
    private readonly profile: PlatformProfile,
    opts: DomDetectorOptions = {},
  ) {
    this.platform = profile.platform;
    this.doc = opts.document ?? document;
    this.now = opts.now ?? (() => Date.now());
    this.getPath = opts.getPath ?? (() => this.doc.location?.pathname ?? '');
    this.timing = { ...DEFAULT_DETECTOR_TIMING, ...opts.timing };
    this.t = this.freshTracker();
    this.trace = new TraceRecorder(opts.onReport);
  }

  private freshTracker(): Tracker {
    return {
      generating: false,
      genStartedAt: 0,
      notGeneratingSince: null,
      lastResponseActivityAt: Number.NEGATIVE_INFINITY,
      lastInputAt: Number.NEGATIVE_INFINITY,
      abortAt: Number.NEGATIVE_INFINITY,
      errorBaseline: 0,
      completedAt: null,
      errorAt: null,
      path: this.getPath(),
      submitAt: Number.NEGATIVE_INFINITY,
      userMsgBaseline: 0,
      lastBlock: '',
    };
  }

  setTiming(timing: Partial<DetectorTiming>): void {
    this.timing = { ...this.timing, ...timing };
  }

  initialize(): void {
    if (this.active) return;
    this.active = true;
    this.initializedAt = this.now();
    this.t = this.freshTracker();
    this.t.errorBaseline = countShown(this.doc, this.profile.error);
    this.observer = new MutationObserver((records) => this.handleMutations(records));
    this.observer.observe(this.doc.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-label', 'data-testid', 'data-is-streaming', 'disabled', 'hidden', 'class', 'style', 'aria-busy', 'aria-hidden', 'data-state', 'data-type', 'id'],
    });
    // Capture phase so page handlers that stop propagation do not hide events.
    this.doc.addEventListener('input', this.onInput, true);
    this.doc.addEventListener('keydown', this.onKeyDown, true);
    this.doc.addEventListener('click', this.onClick, true);
    this.evaluate();
  }

  destroy(): void {
    this.active = false;
    this.observer?.disconnect();
    this.observer = null;
    this.doc.removeEventListener('input', this.onInput, true);
    this.doc.removeEventListener('keydown', this.onKeyDown, true);
    this.doc.removeEventListener('click', this.onClick, true);
    if (this.evalTimer !== null) clearTimeout(this.evalTimer);
    this.evalTimer = null;
    this.listeners.clear();
  }

  getState(): AIState {
    return this.emitted.state;
  }

  getSnapshot(): DetectionSnapshot {
    return { ...this.emitted, signals: [...this.emitted.signals] };
  }

  subscribe(callback: (state: AIState) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // ------------------------------------------------------------------ events

  private handleInput(ev: Event): void {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (!closestAny(target, this.profile.composer)) return;
    this.t.lastInputAt = this.now();
    this.scheduleEvaluate(MUTATION_COALESCE_MS);
  }

  /** Enter (without Shift, not while composing) in a non-empty prompt box = submit. */
  private handleKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || ev.altKey) return;
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const composer = closestAny(target, this.profile.composer);
    if (composer && hasDraft(composer)) this.markSubmit();
  }

  private markSubmit(): void {
    this.t.submitAt = this.now();
    this.t.userMsgBaseline = countAll(this.doc, this.profile.userMessage ?? []);
    this.trace.mark(this.t.submitAt, 'submit');
    this.scheduleEvaluate(0);
  }

  /** True while a submitted request has not produced an answer yet. */
  private pendingSubmit(now: number): boolean {
    const t = this.t;
    if (t.submitAt === Number.NEGATIVE_INFINITY || t.generating) return false;
    const confirmed = (this.profile.userMessage?.length ?? 0) > 0 && countAll(this.doc, this.profile.userMessage!) > t.userMsgBaseline;
    return now - t.submitAt < (confirmed ? this.timing.pendingConfirmedMs : this.timing.pendingUnconfirmedMs);
  }

  /** Category of the active (last) answer block, or null if the profile has no block model. */
  private activeBlock(): { category: BlockCategory | 'text' | 'none'; header: Element | null } | null {
    const b = this.profile.blocks;
    if (!b) return null;
    const items = safeQueryAll(this.doc, b.items);
    const last = items[items.length - 1];
    if (!last) return { category: 'none', header: null };
    if (safeMatches(last, b.text) || safeQueryAll(last, b.text).length > 0) return { category: 'text', header: null };
    const header = safeQueryAll(last, b.header)[0] ?? null;
    return { category: classifyStatusLabel(header ?? last) ?? 'other', header };
  }

  private handleClick(ev: Event): void {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('button, [role="button"]');
    if (!button) return;
    if (!this.t.generating && (this.profile.sendButtons ?? []).some((s) => safeMatches(button, s))) {
      const composer = safeQueryAll(this.doc, this.profile.composer.join(', ')).find((c) => hasDraft(c));
      if (composer) this.markSubmit();
    }
    if (this.isStopControl(button)) {
      this.t.abortAt = this.now();
      this.scheduleEvaluate(MUTATION_COALESCE_MS);
    }
  }

  private isStopControl(button: Element): boolean {
    return (
      this.profile.stopButtons.some((s) => {
        try {
          return button.matches(s);
        } catch {
          return false;
        }
      }) || matchesLabelRule(button, this.profile.stopLabels, this.doc)
    );
  }

  private handleMutations(records: MutationRecord[]): void {
    const now = this.now();
    if (this.trace.enabled) {
      this.traceMutations(records, now);
    } else if (now - this.t.lastResponseActivityAt > 100) {
      for (const r of records) {
        if (this.isResponseActivity(r)) {
          this.t.lastResponseActivityAt = now;
          break;
        }
      }
    }
    this.scheduleEvaluate(MUTATION_COALESCE_MS);
  }

  /** Debug-only: record what changes (structure only) for the detection report. */
  private traceMutations(records: MutationRecord[], now: number): void {
    for (const r of records.slice(0, 400)) {
      const act = this.isResponseActivity(r);
      if (act) this.t.lastResponseActivityAt = now;
      const el = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
      if (!el) continue;
      const container = closestAny(el, this.profile.response);
      const added = Array.from(r.addedNodes).find((n) => n.nodeType === 1) as Element | undefined;
      const addedIsControl = added !== undefined && safeMatches(added, TRACE_CONTROLS);
      // The answer area, controls appearing anywhere, and — while a request
      // runs — any element added elsewhere (e.g. a separate thinking indicator).
      const busy = this.t.generating || now - this.t.genStartedAt < 3000;
      if (!container && !addedIsControl && !(busy && added !== undefined)) continue;
      const type = r.type === 'characterData' ? 'text' : r.type === 'attributes' ? 'attr' : 'child';
      const addDesc = added ? describeNode(added) : r.addedNodes.length > 0 ? '#text' : '';
      this.trace.mutation(now, describePath(el, container, 7), type, act, addDesc);
    }
  }

  /**
   * True when a mutation adds or changes content inside an assistant response
   * (not inside status/thinking/tool markers, not in the composer).
   * Only node types and positions are inspected, never text.
   */
  private isResponseActivity(r: MutationRecord): boolean {
    if (r.type === 'attributes') return false;
    const node = r.target;
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el) return false;
    if (!closestAny(el, this.profile.response)) return false;
    const ignore = [...this.profile.thinking, ...this.profile.tool, ...this.profile.generating, ...this.profile.composer];
    if (closestAny(el, ignore)) return false;
    if (r.type === 'characterData') return true;
    // childList: count only when something other than a status marker was added.
    for (const added of Array.from(r.addedNodes)) {
      if (added.nodeType === 3) return true;
      if (added.nodeType === 1) {
        const ae = added as Element;
        const isMarker = ignore.some((s) => {
          try {
            return ae.matches(s) || ae.querySelector(s) !== null;
          } catch {
            return false;
          }
        });
        if (!isMarker) return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------- evaluation

  private scheduleEvaluate(delay: number): void {
    if (!this.active) return;
    const at = this.now() + delay;
    if (this.evalTimer !== null && this.evalAt <= at) return;
    if (this.evalTimer !== null) clearTimeout(this.evalTimer);
    this.evalAt = at;
    this.evalTimer = setTimeout(() => {
      this.evalTimer = null;
      this.evalAt = Number.POSITIVE_INFINITY;
      this.evaluate();
    }, delay);
  }

  /** Read the structural signals from the DOM. */
  sample(): RawSignals {
    const doc = this.doc;
    const p = this.profile;
    let stop = anyShown(doc, p.stopButtons);
    if (!stop && p.stopLabels.length > 0) {
      // Only elements whose label starts with "stop" are ever inspected.
      stop = safeQueryAll(doc, 'button[aria-label^="stop" i], [role="button"][aria-label^="stop" i]').some(
        (b) => isShown(b) && matchesLabelRule(b, p.stopLabels, doc),
      );
    }
    return {
      composer: anyShown(doc, p.composer),
      response: safeQueryAll(doc, p.response.join(', ') || ':not(*)').length > 0,
      stop,
      generatingMarker: anyShown(doc, p.generating),
      busyMarker: anyShown(doc, p.busy ?? []),
      streamingMarker: anyShown(doc, p.streaming),
      thinkingMarker: anyShown(doc, p.thinking),
      toolMarker: anyShown(doc, p.tool),
      errorCount: countShown(doc, p.error),
    };
  }

  /** Re-read the DOM, update the state machine and emit if a new state is stable. */
  evaluate(): void {
    if (!this.active) return;
    const now = this.now();
    const raw = this.sample();
    const next = this.classify(raw, now);

    if (next.state === this.emitted.state) {
      this.pending = null;
      this.emitted = next; // refresh confidence/signals silently
    } else {
      if (this.pending?.state !== next.state) this.pending = { state: next.state, since: now };
      if (now - this.pending.since >= this.timing.debounceMs) {
        this.pending = null;
        this.emitted = next;
        this.trace.mark(now, `state:${next.state}`);
        for (const cb of [...this.listeners]) cb(next.state);
      }
    }

    // Keep ticking while anything time-dependent is going on.
    const busy =
      this.pending !== null ||
      this.emitted.state !== 'idle' ||
      this.t.generating ||
      this.t.notGeneratingSince !== null ||
      now - this.initializedAt < this.timing.unrecognizedAfterMs + TICK_MS;
    if (busy) {
      const wait = this.pending ? Math.min(TICK_MS, Math.max(0, this.pending.since + this.timing.debounceMs - now)) : TICK_MS;
      this.scheduleEvaluate(wait);
    }
  }

  private traceBlock(block: { category: string; header: Element | null }, now: number): void {
    if (!this.trace.enabled) return;
    const key = `${block.category}|${block.header ? describeNode(block.header) : ''}`;
    if (key === this.t.lastBlock) return;
    this.t.lastBlock = key;
    this.trace.mark(now, `block:${block.category}${block.header ? ` header=${describeNode(block.header).slice(0, 40)}` : ''}`);
  }

  private traceSignals(raw: RawSignals, now: number): void {
    const on = (['composer', 'stop', 'generatingMarker', 'busyMarker', 'streamingMarker', 'thinkingMarker', 'toolMarker'] as const).filter((k) => raw[k]);
    const key = `${on.join(',')}|err${raw.errorCount}`;
    if (key === this.lastRawKey) return;
    this.lastRawKey = key;
    this.trace.mark(now, `signals:${on.join(',') || 'none'} errors:${raw.errorCount}`);
  }

  /** Pure-ish classification: updates the generation tracker and returns a snapshot. */
  private classify(raw: RawSignals, now: number): DetectionSnapshot {
    const t = this.t;
    const signals: SignalName[] = [];

    // SPA navigation to another chat: forget in-flight bookkeeping so a
    // switch is never mistaken for a completed answer.
    const path = this.getPath();
    if (path !== t.path) {
      t.path = path;
      t.generating = false;
      t.notGeneratingSince = null;
      t.completedAt = null;
      t.errorAt = null;
      t.abortAt = Number.NEGATIVE_INFINITY;
      t.lastInputAt = Number.NEGATIVE_INFINITY;
      t.errorBaseline = raw.errorCount;
      // A new chat gets its own URL right after the first message: keep a fresh submit.
      if (now - t.submitAt > 5000) t.submitAt = Number.NEGATIVE_INFINITY;
    }

    const rawGenerating = raw.stop || raw.generatingMarker || raw.busyMarker || raw.streamingMarker;
    if (this.trace.enabled) this.traceSignals(raw, now);
    if (raw.stop) signals.push('stop-button');
    if (raw.generatingMarker || raw.busyMarker) signals.push('generating-marker');
    if (raw.streamingMarker) signals.push('streaming-marker');
    if (raw.composer) signals.push('composer');

    // Error bookkeeping: only errors that appear after the baseline count.
    if (raw.errorCount < t.errorBaseline) t.errorBaseline = raw.errorCount;
    if (raw.errorCount > t.errorBaseline && t.errorAt === null) {
      t.errorAt = now;
      if (t.generating) this.trace.finish(t.genStartedAt, now);
      t.generating = false;
      t.notGeneratingSince = null;
      t.completedAt = null;
    }
    if (t.errorAt !== null && now - t.errorAt >= this.timing.errorHoldMs) {
      t.errorAt = null;
      t.errorBaseline = raw.errorCount;
    }

    // Generation lifecycle.
    if (rawGenerating && t.errorAt === null) {
      t.notGeneratingSince = null;
      if (!t.generating) {
        t.generating = true;
        t.genStartedAt = now;
        t.submitAt = Number.NEGATIVE_INFINITY; // the pending request has started
        this.trace.mark(now, 'generation-start');
        t.completedAt = null;
        t.errorBaseline = Math.min(t.errorBaseline, raw.errorCount);
      }
    } else if (t.generating) {
      t.notGeneratingSince ??= now;
      if (now - t.notGeneratingSince >= this.timing.endGraceMs) {
        t.generating = false;
        t.notGeneratingSince = null;
        const aborted = t.abortAt >= t.genStartedAt;
        if (!aborted) t.completedAt = now;
        this.trace.mark(now, aborted ? 'generation-end:aborted' : 'generation-end');
        this.trace.finish(t.genStartedAt, now);
      }
    }
    if (t.abortAt >= t.genStartedAt && t.abortAt > Number.NEGATIVE_INFINITY) signals.push('user-abort');

    // Decide.
    if (t.errorAt !== null) {
      signals.push('error-marker');
      return { state: 'error', confidence: 0.75, signals };
    }

    if (t.generating) {
      const activity = t.lastResponseActivityAt >= t.genStartedAt && now - t.lastResponseActivityAt < this.timing.activityWindowMs;
      if (activity) signals.push('response-activity');
      const block = this.activeBlock();
      if (block) this.traceBlock(block, now);
      if (raw.toolMarker || block?.category === 'tool') {
        signals.push(raw.toolMarker ? 'tool-marker' : 'block-tool');
        return { state: 'tool_use', confidence: raw.toolMarker ? 0.75 : 0.85, signals };
      }
      if (raw.thinkingMarker || block?.category === 'thinking') {
        signals.push(raw.thinkingMarker ? 'thinking-marker' : 'block-thinking');
        return { state: 'thinking', confidence: raw.thinkingMarker ? 0.75 : 0.85, signals };
      }
      if (block?.category === 'other') {
        // A non-text block with an unrecognised header (status, card, tool): not answer prose.
        signals.push('block-thinking');
        return { state: 'thinking', confidence: 0.6, signals };
      }
      if (block?.category === 'text') signals.push('block-text');
      if (raw.streamingMarker && activity) return { state: 'responding', confidence: 0.9, signals };
      if (activity) return { state: 'responding', confidence: 0.75, signals };
      // A request is in flight but no output is visible (yet / right now).
      // A streaming marker alone may be set before the first token arrives.
      return { state: 'thinking', confidence: raw.streamingMarker ? 0.55 : 0.6, signals };
    }

    // Submitted, but the answer has not started yet: the model is thinking.
    if (this.pendingSubmit(now)) {
      signals.push('submitted');
      return { state: 'thinking', confidence: 0.7, signals };
    }

    if (t.completedAt !== null && now - t.completedAt < this.timing.completedHoldMs) {
      return { state: 'completed', confidence: 0.8, signals };
    }
    t.completedAt = null;

    if (now - t.lastInputAt < this.timing.typingIdleMs) {
      signals.push('user-input');
      return { state: 'user_typing', confidence: 0.9, signals };
    }

    if (!raw.composer && !raw.response) {
      if (now - this.initializedAt >= this.timing.unrecognizedAfterMs) {
        signals.push('layout-unrecognized');
        return { state: 'unknown', confidence: 0.2, signals };
      }
      return { state: 'idle', confidence: 0.3, signals };
    }
    return { state: 'idle', confidence: raw.composer ? 0.9 : 0.6, signals };
  }
}
