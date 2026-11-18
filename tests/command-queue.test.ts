import { describe, expect, it } from 'vitest';
import { CommandQueue, type SendOutcome } from '../src/background/command-queue';
import type { Animation } from '../src/shared/types';
import { FakeClock } from './helpers/fake-clock';

function setup(opts: { fail?: (a: Animation) => SendOutcome | null; latency?: number; retry?: boolean } = {}) {
  const clock = new FakeClock();
  const sent: { animation: Animation; at: number }[] = [];
  const queue = new CommandQueue({
    ...clock.deps,
    minIntervalMs: () => 1000,
    shouldRetry: () => opts.retry ?? false,
    send: async (animation) => {
      sent.push({ animation, at: clock.now });
      if (opts.latency) await new Promise<void>((r) => clock.deps.setTimer(r, opts.latency!));
      return opts.fail?.(animation) ?? { ok: true, message: 'ok' };
    },
  });
  return { clock, queue, sent };
}

describe('CommandQueue', () => {
  it('sends a request and suppresses duplicates', async () => {
    const { clock, queue, sent } = setup();
    queue.request('thinking');
    await clock.advance(0);
    queue.request('thinking');
    queue.request('thinking');
    await clock.advance(5000);
    expect(sent.map((s) => s.animation)).toEqual(['thinking']);
    expect(queue.current).toBe('thinking');
  });

  it('keeps only the latest request (last-state-wins) and spaces commands', async () => {
    const { clock, queue, sent } = setup();
    queue.request('thinking');
    await clock.advance(0);
    queue.request('typing');
    queue.request('reading');
    queue.request('ring');
    await clock.advance(3000);
    expect(sent.map((s) => s.animation)).toEqual(['thinking', 'ring']);
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(1000);
  });

  it('cancels a pending change that returns to the current animation (oscillation)', async () => {
    const { clock, queue, sent } = setup();
    queue.request('typing');
    await clock.advance(0);
    queue.request('thinking'); // waits for min interval
    queue.request('typing'); // back to what the robot shows
    await clock.advance(3000);
    expect(sent.map((s) => s.animation)).toEqual(['typing']);
  });

  it('handles requests while one is in flight', async () => {
    const { clock, queue, sent } = setup({ latency: 300 });
    queue.request('thinking');
    await clock.advance(100); // in flight
    queue.request('typing');
    queue.request('reading');
    await clock.advance(3000);
    expect(sent.map((s) => s.animation)).toEqual(['thinking', 'reading']);
  });

  it('re-sends when forced (keepalive)', async () => {
    const { clock, queue, sent } = setup();
    queue.request('typing');
    await clock.advance(0);
    queue.request('typing', { force: true });
    await clock.advance(2000);
    expect(sent.map((s) => s.animation)).toEqual(['typing', 'typing']);
  });

  it('assumes one-shot auto-return without sending', async () => {
    const { clock, queue, sent } = setup();
    queue.request('ring');
    await clock.advance(0);
    queue.assume('none');
    queue.request('none');
    await clock.advance(2000);
    expect(sent.map((s) => s.animation)).toEqual(['ring']);
    expect(queue.current).toBe('none');
  });

  it('backs off after failures and retries retryable animations', async () => {
    let failing = true;
    const { clock, queue, sent } = setup({ retry: true, fail: () => (failing ? { ok: false, message: 'down', retryable: true } : null) });
    queue.request('typing');
    await clock.advance(0);
    expect(queue.current).toBeNull();
    await clock.advance(1999);
    expect(sent).toHaveLength(1); // still backing off (2 s)
    await clock.advance(1);
    expect(sent).toHaveLength(2);
    await clock.advance(4000); // backoff doubled to 4 s
    expect(sent).toHaveLength(3);
    failing = false;
    await clock.advance(8000);
    expect(sent).toHaveLength(4);
    expect(queue.current).toBe('typing');
    await clock.advance(120_000);
    expect(sent).toHaveLength(4); // no more traffic once delivered
  });

  it('does not retry non-retryable failures', async () => {
    const { clock, queue, sent } = setup({ retry: true, fail: () => ({ ok: false, message: '401', retryable: false }) });
    queue.request('typing');
    await clock.advance(120_000);
    expect(sent).toHaveLength(1);
  });

  it('never exceeds one command per second under a flood of changes', async () => {
    const { clock, queue, sent } = setup();
    const names: Animation[] = ['thinking', 'typing', 'reading', 'none'];
    for (let i = 0; i < 200; i++) {
      queue.request(names[i % names.length]!);
      await clock.advance(50);
    }
    await clock.advance(5000);
    for (let i = 1; i < sent.length; i++) expect(sent[i]!.at - sent[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    expect(sent.length).toBeLessThanOrEqual(12);
  });
});
