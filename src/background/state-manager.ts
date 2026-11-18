/**
 * Central state machine: turns per-tab detector reports into at most one
 * robot command per meaningful transition.
 *
 * Pipeline on every evaluation:
 *   tab reports → effective per-tab state (completion expiry, staleness)
 *   → arbitration (one controlling tab) → stability filter (minStableMs)
 *   → mapping (state → animation) → CommandQueue (dedupe, last-state-wins).
 *
 * Time and timers are injected, so the whole thing is unit-testable.
 */
import type { Config } from '../shared/config';
import { ANIMATION_KIND, DISABLED, type AIState, type Animation, type MappingTarget } from '../shared/types';
import type { CommandQueue } from './command-queue';
import type { Selection, TabRegistry } from './tab-manager';

/** States that represent events; they bypass the stability delay. */
const EVENT_STATES: ReadonlySet<AIState> = new Set(['completed', 'error']);

export interface StateManagerDeps {
  registry: TabRegistry;
  queue: CommandQueue;
  getConfig: () => Config;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  log?: (msg: string) => void;
  /** Called whenever the committed state changes (for status/persistence). */
  onCommit?: (commit: Commit) => void;
}

export interface Commit {
  state: AIState;
  target: MappingTarget;
  selection: Selection | null;
  at: number;
}

export interface StateManagerSnapshot {
  committed: { state: AIState; target: MappingTarget; at: number } | null;
  lastKeepaliveAt: number;
  disabledHandled: boolean;
}

export class StateManager {
  private candidate: { state: AIState; since: number } | null = null;
  private committed: { state: AIState; target: MappingTarget; at: number } | null = null;
  private lastSelection: Selection | null = null;
  private lastKeepaliveAt = 0;
  private timer: unknown = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private disabledHandled = false;

  constructor(private readonly deps: StateManagerDeps) {}

  get selection(): Selection | null {
    return this.lastSelection;
  }

  get committedState(): AIState | null {
    return this.committed?.state ?? null;
  }

  /** Force the next evaluation to re-issue the mapped animation (config change, test animation, reconnect). */
  invalidate(): void {
    this.committed = null;
    this.candidate = null;
  }

  evaluate(): void {
    const { registry, queue, getConfig, now: nowFn } = this.deps;
    const cfg = getConfig();
    const now = nowFn();

    if (!cfg.enabled) {
      this.lastSelection = null;
      this.candidate = null;
      if (!this.disabledHandled) {
        // Leave the robot at rest when the bridge is switched off.
        this.disabledHandled = true;
        this.committed = null;
        if (queue.current !== 'none') queue.request('none');
      }
      this.cancelTimer();
      return;
    }
    this.disabledHandled = false;

    const sel = registry.select(cfg.arbitration, now, cfg.timing);
    this.lastSelection = sel;
    const state: AIState = sel?.state ?? 'idle';

    if (this.candidate?.state !== state) this.candidate = { state, since: now };
    const required = EVENT_STATES.has(state) ? 0 : cfg.timing.minStableMs;
    const stableAt = this.candidate.since + required;

    if (now >= stableAt && this.committed?.state !== state) {
      this.commit(state, sel, cfg, now);
    }

    // Keepalive for continuous animations during long responses.
    let keepaliveAt = Number.POSITIVE_INFINITY;
    const target = this.committed?.target;
    if (
      cfg.timing.keepaliveMs > 0 &&
      target !== undefined &&
      target !== DISABLED &&
      ANIMATION_KIND[target] === 'continuous' &&
      queue.current === target &&
      this.committed?.state === state
    ) {
      const due = Math.max(this.lastKeepaliveAt, queue.currentSince) + cfg.timing.keepaliveMs;
      if (now >= due) {
        this.lastKeepaliveAt = now;
        this.deps.log?.(`keepalive ${target}`);
        queue.request(target, { force: true });
        keepaliveAt = now + cfg.timing.keepaliveMs;
      } else {
        keepaliveAt = due;
      }
    }

    const wake = Math.min(
      now < stableAt ? stableAt : Number.POSITIVE_INFINITY,
      registry.nextExpiry(now, cfg.timing) ?? Number.POSITIVE_INFINITY,
      keepaliveAt,
    );
    this.scheduleAt(wake, now);
  }

  private commit(state: AIState, sel: Selection | null, cfg: Config, now: number): void {
    const { queue } = this.deps;
    const target = cfg.mapping[state];
    this.committed = { state, target, at: now };
    this.lastKeepaliveAt = now;
    this.deps.log?.(`state → ${state} (${sel ? `${sel.platform} tab ${sel.tabId}` : 'no AI tab'}) ⇒ ${target}`);

    if (target !== DISABLED) {
      const believed = queue.current;
      if (target === 'none' && believed !== null && ANIMATION_KIND[believed] === 'oneshot' && queue.target === believed) {
        // One-shot animations (e.g. ring) return to `none` by themselves;
        // posting `none` now would only cut them short.
        queue.assume('none');
      } else {
        queue.request(target as Animation);
      }
    }
    this.deps.onCommit?.({ state, target, selection: sel, at: now });
  }

  private scheduleAt(at: number, now: number): void {
    if (!Number.isFinite(at)) {
      this.cancelTimer();
      return;
    }
    if (this.timer !== null && this.timerAt === at) return;
    this.cancelTimer();
    this.timerAt = at;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.timerAt = Number.POSITIVE_INFINITY;
      this.evaluate();
    }, Math.max(0, at - now));
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = Number.POSITIVE_INFINITY;
  }

  snapshot(): StateManagerSnapshot {
    return { committed: this.committed ? { ...this.committed } : null, lastKeepaliveAt: this.lastKeepaliveAt, disabledHandled: this.disabledHandled };
  }

  restore(snap: StateManagerSnapshot): void {
    this.committed = snap.committed ? { ...snap.committed } : null;
    this.lastKeepaliveAt = snap.lastKeepaliveAt;
    this.disabledHandled = snap.disabledHandled;
    // Treat the restored state as already stable.
    if (this.committed) this.candidate = { state: this.committed.state, since: this.committed.at };
  }

  dispose(): void {
    this.cancelTimer();
  }
}
