/**
 * Message contracts between content scripts, extension pages and the
 * background script, plus strict validators for everything that crosses a
 * trust boundary.
 *
 * Content scripts run inside AI web pages and are treated as untrusted: they
 * may only send the two message kinds below, carrying enumerated values.
 * They can never name a URL, HTTP method, body or animation.
 */
import {
  isAIState,
  isAnimation,
  isPlatform,
  isSignalName,
  SIGNAL_NAMES,
  type AIState,
  type Animation,
  type ArbitrationMode,
  type Platform,
  type SignalName,
} from './types';

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Content script → background
// ---------------------------------------------------------------------------

export interface HelloMessage {
  v: typeof PROTOCOL_VERSION;
  kind: 'hello';
  platform: Platform;
}

export interface StateMessage {
  v: typeof PROTOCOL_VERSION;
  kind: 'state';
  platform: Platform;
  state: AIState;
  confidence: number;
  signals: SignalName[];
  /** Monotonic per page load; lets the background drop reordered messages. */
  seq: number;
}

/** Debug-only structural trace of one request (see detectors/trace.ts). */
export interface ReportMessage {
  v: typeof PROTOCOL_VERSION;
  kind: 'report';
  platform: Platform;
  report: DetectionReport;
}

export interface DetectionReport {
  durationMs: number;
  timeline: { t: number; e: string }[];
  mutations: { d: string; type: 'child' | 'text' | 'attr'; act: boolean; add: string; n: number; first: number; last: number }[];
}

export type ContentMessage = HelloMessage | StateMessage | ReportMessage;

/** Reply to every content message. Carries only non-secret tuning values. */
export interface ContentReply {
  active: boolean;
  debounceMs: number;
  typingIdleMs: number;
  completionMs: number;
  /** A request counts as finished only after this long without busy signals. */
  taskEndMs: number;
  heartbeatMs: number;
  /** Record a structural detection report (only while debug logging is on). */
  trace: boolean;
}

const STATE_KEYS = new Set(['v', 'kind', 'platform', 'state', 'confidence', 'signals', 'seq']);
const HELLO_KEYS = new Set(['v', 'kind', 'platform']);
const REPORT_KEYS = new Set(['v', 'kind', 'platform', 'report']);
/** Same character set the trace recorder emits: structure only, no free text. */
const REPORT_STRING = /^[\w\-:./[\]%#()="^ >,]*$/;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9;
const reportString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && REPORT_STRING.test(v);

function parseReport(raw: unknown): DetectionReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!finite(r.durationMs) || !Array.isArray(r.timeline) || !Array.isArray(r.mutations)) return null;
  if (r.timeline.length > 120 || r.mutations.length > 100) return null;
  const timeline: DetectionReport['timeline'] = [];
  for (const x of r.timeline) {
    const e = x as Record<string, unknown>;
    if (typeof e !== 'object' || e === null || !finite(e.t) || !reportString(e.e, 60)) return null;
    timeline.push({ t: e.t, e: e.e });
  }
  const mutations: DetectionReport['mutations'] = [];
  for (const x of r.mutations) {
    const m = x as Record<string, unknown>;
    if (typeof m !== 'object' || m === null) return null;
    if (!reportString(m.d, 700) || !reportString(m.add, 260) || typeof m.act !== 'boolean') return null;
    if (m.type !== 'child' && m.type !== 'text' && m.type !== 'attr') return null;
    if (!finite(m.n) || !finite(m.first) || !finite(m.last)) return null;
    mutations.push({ d: m.d, type: m.type, act: m.act, add: m.add, n: m.n, first: m.first, last: m.last });
  }
  return { durationMs: r.durationMs, timeline, mutations };
}

function hasOnlyKeys(o: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(o).every((k) => allowed.has(k));
}

/** Strictly parse a message from a content script. Returns null if invalid. */
export function parseContentMessage(raw: unknown): ContentMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION || !isPlatform(m.platform)) return null;

  if (m.kind === 'hello') {
    if (!hasOnlyKeys(m, HELLO_KEYS)) return null;
    return { v: PROTOCOL_VERSION, kind: 'hello', platform: m.platform };
  }

  if (m.kind === 'report') {
    if (!hasOnlyKeys(m, REPORT_KEYS)) return null;
    const report = parseReport(m.report);
    return report ? { v: PROTOCOL_VERSION, kind: 'report', platform: m.platform, report } : null;
  }

  if (m.kind === 'state') {
    if (!hasOnlyKeys(m, STATE_KEYS)) return null;
    if (!isAIState(m.state)) return null;
    if (typeof m.confidence !== 'number' || !(m.confidence >= 0 && m.confidence <= 1)) return null;
    if (typeof m.seq !== 'number' || !Number.isSafeInteger(m.seq) || m.seq < 0) return null;
    if (!Array.isArray(m.signals) || m.signals.length > SIGNAL_NAMES.length) return null;
    if (!m.signals.every(isSignalName)) return null;
    return {
      v: PROTOCOL_VERSION,
      kind: 'state',
      platform: m.platform,
      state: m.state,
      confidence: m.confidence,
      signals: [...new Set(m.signals)],
      seq: m.seq,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extension pages (popup/options) → background
// ---------------------------------------------------------------------------

export type PageRequest =
  | { kind: 'getStatus' }
  | { kind: 'testConnection' }
  | { kind: 'testAnimation'; animation: Animation }
  | { kind: 'getDebugLog' }
  | { kind: 'getDetectionReports' }
  | { kind: 'getSerialInfo' }
  | { kind: 'clearDebugLog' };

export function parsePageRequest(raw: unknown): PageRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.kind) {
    case 'getStatus':
    case 'testConnection':
    case 'getDebugLog':
    case 'getDetectionReports':
    case 'getSerialInfo':
    case 'clearDebugLog':
      return { kind: m.kind };
    case 'testAnimation':
      return isAnimation(m.animation) ? { kind: 'testAnimation', animation: m.animation } : null;
    default:
      return null;
  }
}

export type ConnectionState = 'unconfigured' | 'no-permission' | 'unknown' | 'connected' | 'disconnected' | 'error';

export interface TabStatus {
  tabId: number;
  platform: Platform;
  state: AIState;
  effectiveState: AIState;
  confidence: number;
  signals: SignalName[];
  ageMs: number;
}

export interface StatusSnapshot {
  enabled: boolean;
  connection: ConnectionState;
  connectionDetail: string;
  firmwareVersion: string | null;
  authRequired: boolean | null;
  robotAnimation: string | null;
  lastSent: { animation: Animation; state: AIState | null; at: number } | null;
  lastCommand: { animation: Animation; ok: boolean; at: number; detail: string } | null;
  lastError: { message: string; at: number } | null;
  controller: { tabId: number; platform: Platform; state: AIState; confidence: number } | null;
  arbitration: ArbitrationMode;
  tabs: TabStatus[];
}

export interface ConnectionTestResult {
  ok: boolean;
  connection: ConnectionState;
  message: string;
  firmwareVersion: string | null;
  authRequired: boolean | null;
  robotAnimation: string | null;
}

export interface AnimationTestResult {
  ok: boolean;
  message: string;
}
