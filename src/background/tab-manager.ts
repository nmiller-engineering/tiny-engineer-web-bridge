/**
 * Registry of AI tabs and deterministic multi-tab arbitration.
 *
 * Pure logic: browser events (tab activated/closed/navigated) are fed in by
 * background/index.ts; time is passed in explicitly.
 */
import type { TimingConfig } from '../shared/config';
import { BUSY_STATES, type AIState, type ArbitrationMode, type Platform, type SignalName } from '../shared/types';

export interface TabRecord {
  tabId: number;
  platform: Platform;
  /** Last state reported by the tab's detector. */
  state: AIState;
  confidence: number;
  signals: SignalName[];
  /** When `state` was first reported (wall clock ms). */
  stateSince: number;
  /** Last message of any kind from this tab. */
  lastSeen: number;
  /** Last accepted sequence number (per page load). */
  seq: number;
}

export interface Selection {
  tabId: number;
  platform: Platform;
  state: AIState;
  confidence: number;
}

export type ArbitrationTiming = Pick<TimingConfig, 'completionMs' | 'staleMs'>;

export interface RegistrySnapshot {
  records: TabRecord[];
  focusOrder: number[];
}

const MAX_FOCUS_HISTORY = 64;

/** States that must be refreshed by heartbeats to stay valid. */
const NEEDS_HEARTBEAT: ReadonlySet<AIState> = new Set(['thinking', 'responding', 'tool_use', 'user_typing', 'error']);

/**
 * The state a tab effectively contributes right now:
 * - `completed` expires into `idle` after the completion window.
 * - An active state without recent heartbeat becomes `unknown` (signal lost,
 *   e.g. tab frozen/crashed) so the robot never stays busy indefinitely.
 */
export function effectiveState(rec: TabRecord, now: number, timing: ArbitrationTiming): AIState {
  if (rec.state === 'completed') {
    return now - rec.stateSince >= timing.completionMs ? 'idle' : 'completed';
  }
  if (NEEDS_HEARTBEAT.has(rec.state) && now - rec.lastSeen > timing.staleMs) return 'unknown';
  return rec.state;
}

/** Arbitration rank in activity-priority mode (higher wins). */
export function priorityRank(state: AIState): number {
  if (BUSY_STATES.has(state)) return 3;
  if (state === 'completed' || state === 'error') return 2;
  if (state === 'user_typing') return 1;
  return 0;
}

export class TabRegistry {
  private records = new Map<number, TabRecord>();
  /** Most recently focused tab first (all tabs, AI or not). */
  private focusOrder: number[] = [];

  get size(): number {
    return this.records.size;
  }

  get(tabId: number): TabRecord | undefined {
    return this.records.get(tabId);
  }

  all(): TabRecord[] {
    return [...this.records.values()];
  }

  /**
   * Record a report. Returns false if it was dropped as out of order.
   * A lower seq than the last one means either reordering (drop) or a page
   * reload (seq restarts at 0 — accepted via `fresh`).
   */
  report(
    tabId: number,
    r: { platform: Platform; state: AIState; confidence: number; signals: SignalName[]; seq: number },
    now: number,
    fresh = false,
  ): boolean {
    const prev = this.records.get(tabId);
    if (prev && !fresh && prev.platform === r.platform && r.seq < prev.seq) return false;
    const sameState = prev !== undefined && prev.state === r.state && prev.platform === r.platform;
    this.records.set(tabId, {
      tabId,
      platform: r.platform,
      state: r.state,
      confidence: r.confidence,
      signals: r.signals,
      stateSince: sameState ? prev.stateSince : now,
      lastSeen: now,
      seq: r.seq,
    });
    return true;
  }

  /** Register a tab that just loaded a detector (hello). Resets its state. */
  hello(tabId: number, platform: Platform, now: number): void {
    this.records.set(tabId, {
      tabId,
      platform,
      state: 'idle',
      confidence: 0.5,
      signals: [],
      stateSince: now,
      lastSeen: now,
      seq: -1,
    });
  }

  remove(tabId: number): boolean {
    this.focusOrder = this.focusOrder.filter((id) => id !== tabId);
    return this.records.delete(tabId);
  }

  /** Drop all tabs of a platform (e.g. the platform was disabled). */
  removePlatform(platform: Platform): void {
    for (const [id, rec] of this.records) if (rec.platform === platform) this.records.delete(id);
  }

  clear(): void {
    this.records.clear();
  }

  focus(tabId: number): void {
    this.focusOrder = [tabId, ...this.focusOrder.filter((id) => id !== tabId)].slice(0, MAX_FOCUS_HISTORY);
  }

  get focused(): number | null {
    return this.focusOrder[0] ?? null;
  }

  /** Pick the tab that controls the robot, or null if there is none. */
  select(mode: ArbitrationMode, now: number, timing: ArbitrationTiming): Selection | null {
    if (this.records.size === 0) return null;
    const focusIndex = (id: number) => {
      const i = this.focusOrder.indexOf(id);
      return i === -1 ? Number.POSITIVE_INFINITY : i;
    };
    const candidates = this.all().map((rec) => ({ rec, eff: effectiveState(rec, now, timing), fi: focusIndex(rec.tabId) }));

    let chosen: (typeof candidates)[number] | undefined;
    if (mode === 'active-tab') {
      // The most recently focused AI tab. Without any focus history (e.g.
      // fresh start), fall back to the most recently heard-from tab.
      candidates.sort((a, b) => a.fi - b.fi || b.rec.lastSeen - a.rec.lastSeen || a.rec.tabId - b.rec.tabId);
      chosen = candidates[0];
    } else {
      candidates.sort(
        (a, b) =>
          priorityRank(b.eff) - priorityRank(a.eff) ||
          a.fi - b.fi ||
          b.rec.stateSince - a.rec.stateSince ||
          a.rec.tabId - b.rec.tabId,
      );
      chosen = candidates[0];
    }
    if (!chosen) return null;
    return { tabId: chosen.rec.tabId, platform: chosen.rec.platform, state: chosen.eff, confidence: chosen.rec.confidence };
  }

  /** Earliest future time at which some tab's effective state changes by itself. */
  nextExpiry(now: number, timing: ArbitrationTiming): number | null {
    let next: number | null = null;
    for (const rec of this.records.values()) {
      let t: number | null = null;
      if (rec.state === 'completed') t = rec.stateSince + timing.completionMs;
      else if (NEEDS_HEARTBEAT.has(rec.state)) t = rec.lastSeen + timing.staleMs + 1;
      if (t !== null && t > now && (next === null || t < next)) next = t;
    }
    return next;
  }

  /** True if any tab is in a state that needs a watchdog. */
  hasActiveTabs(now: number, timing: ArbitrationTiming): boolean {
    return this.all().some((r) => {
      const eff = effectiveState(r, now, timing);
      return eff !== 'idle' && eff !== 'unknown';
    });
  }

  snapshot(): RegistrySnapshot {
    return { records: this.all().map((r) => ({ ...r, signals: [...r.signals] })), focusOrder: [...this.focusOrder] };
  }

  restore(snap: RegistrySnapshot): void {
    this.records = new Map(snap.records.map((r) => [r.tabId, { ...r }]));
    this.focusOrder = [...snap.focusOrder];
  }
}
