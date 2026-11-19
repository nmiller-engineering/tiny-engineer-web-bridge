/**
 * Last-state-wins animation command queue.
 *
 * - At most one request in flight (the firmware is single-threaded).
 * - Only the most recent wanted animation is kept; intermediate ones are dropped.
 * - Requests identical to what the robot is believed to show are suppressed
 *   (unless `force`, used for the continuous-animation keepalive).
 * - Commands are spaced by `minIntervalMs` (the firmware holds every
 *   animation for at least 1 s anyway, so sending faster gains nothing).
 * - After a failure, further sends back off exponentially (2 s … 60 s).
 */
import type { Animation } from '../shared/types';

export interface SendOutcome {
  ok: boolean;
  message: string;
  /** False for failures a retry cannot fix (bad token, missing permission…). */
  retryable?: boolean;
}

export interface CommandQueueDeps {
  send: (animation: Animation) => Promise<SendOutcome>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  minIntervalMs: () => number;
  /** Whether a failed animation should be retried automatically. */
  shouldRetry: (animation: Animation) => boolean;
  onResult?: (animation: Animation, outcome: SendOutcome) => void;
}

interface Pending {
  animation: Animation;
  force: boolean;
}

export const BACKOFF_START_MS = 2000;
export const BACKOFF_MAX_MS = 60_000;

export class CommandQueue {
  private believed: Animation | null = null;
  private believedAt = 0;
  private pending: Pending | null = null;
  private inFlight: Animation | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private backoffMs = 0;
  private blockedUntil = Number.NEGATIVE_INFINITY;
  private timer: unknown = null;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly deps: CommandQueueDeps) {}

  /** What the robot is believed to be showing (null = unknown). */
  get current(): Animation | null {
    return this.believed;
  }

  get currentSince(): number {
    return this.believedAt;
  }

  /** The animation the queue is converging to. */
  get target(): Animation | null {
    return this.pending?.animation ?? this.inFlight ?? this.believed;
  }

  request(animation: Animation, opts: { force?: boolean } = {}): void {
    const force = opts.force === true;
    if (this.inFlight !== null) {
      this.pending = !force && animation === this.inFlight ? null : { animation, force };
      return; // flushed when the in-flight request settles
    }
    if (!force && animation === this.believed) {
      this.pending = null;
      this.cancelTimer();
      this.resolveIdle();
      return;
    }
    this.pending = { animation, force };
    this.schedule();
  }

  /** Record a state change the robot performs on its own (one-shot → none). */
  assume(animation: Animation): void {
    if (this.inFlight === null && this.pending === null) {
      this.believed = animation;
      this.believedAt = this.deps.now();
    }
  }

  snapshot(): { believed: Animation | null; believedAt: number } {
    return { believed: this.believed, believedAt: this.believedAt };
  }

  /** Restore belief after a background restart (nothing is sent). */
  restore(snap: { believed: Animation | null; believedAt: number }): void {
    this.believed = snap.believed;
    this.believedAt = snap.believedAt;
  }

  /** Forget the believed robot state (e.g. after reconfiguration). */
  invalidate(): void {
    this.believed = null;
  }

  /** Clear backoff so the next request goes out promptly (after a successful health check). */
  resetBackoff(): void {
    this.backoffMs = 0;
    this.blockedUntil = Number.NEGATIVE_INFINITY;
    if (this.pending && this.inFlight === null) this.schedule();
  }

  /** Resolves when nothing is pending or in flight. Test helper. */
  whenIdle(): Promise<void> {
    if (this.pending === null && this.inFlight === null) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private schedule(): void {
    this.cancelTimer();
    const now = this.deps.now();
    const at = Math.max(now, this.lastAttemptAt + this.deps.minIntervalMs(), this.blockedUntil);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, Math.max(0, at - now));
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private async flush(): Promise<void> {
    const job = this.pending;
    if (job === null || this.inFlight !== null) return;
    this.pending = null;
    if (!job.force && job.animation === this.believed) {
      this.resolveIdle();
      return;
    }
    this.inFlight = job.animation;
    this.lastAttemptAt = this.deps.now();

    let outcome: SendOutcome;
    try {
      outcome = await this.deps.send(job.animation);
    } catch (err) {
      outcome = { ok: false, message: err instanceof Error ? err.message : 'send failed' };
    }

    this.inFlight = null;
    if (outcome.ok) {
      this.believed = job.animation;
      this.believedAt = this.deps.now();
      this.backoffMs = 0;
      this.blockedUntil = Number.NEGATIVE_INFINITY;
    } else {
      this.believed = null; // robot state unknown now
      this.backoffMs = this.backoffMs === 0 ? BACKOFF_START_MS : Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
      this.blockedUntil = this.deps.now() + this.backoffMs;
      if (this.pending === null && outcome.retryable !== false && this.deps.shouldRetry(job.animation)) {
        this.pending = { animation: job.animation, force: false };
      }
    }
    this.deps.onResult?.(job.animation, outcome);

    if (this.pending !== null) {
      if (!this.pending.force && this.pending.animation === this.believed) {
        this.pending = null;
      } else {
        this.schedule();
        return;
      }
    }
    this.resolveIdle();
  }

  private resolveIdle(): void {
    if (this.pending !== null || this.inFlight !== null) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
