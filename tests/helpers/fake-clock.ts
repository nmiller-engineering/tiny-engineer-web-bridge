/** Deterministic clock + timer scheduler for background logic tests. */
export class FakeClock {
  now = 1_700_000_000_000;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  readonly deps = {
    now: () => this.now,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = this.nextId++;
      this.timers.set(id, { at: this.now + Math.max(0, ms), fn });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      this.timers.delete(handle as number);
    },
  };

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Advance time, firing due timers in order and letting promises settle in between. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await flushPromises();
      let nextId: number | null = null;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, t] of this.timers) {
        if (t.at <= target && (t.at < nextAt || (t.at === nextAt && id < (nextId ?? Infinity)))) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.now = Math.max(this.now, timer.at);
      timer.fn();
    }
    this.now = target;
    await flushPromises();
  }
}

export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}
