import { describe, expect, it } from 'vitest';
import { CommandQueue } from '../src/background/command-queue';
import { StateManager } from '../src/background/state-manager';
import { TabRegistry } from '../src/background/tab-manager';
import { cloneDefaultConfig, type Config } from '../src/shared/config';
import type { AIState, Animation, Platform } from '../src/shared/types';
import { FakeClock } from './helpers/fake-clock';

function setup(mutate: (c: Config) => void = () => undefined) {
  const clock = new FakeClock();
  const config = cloneDefaultConfig();
  config.device.host = '127.0.0.1';
  config.timing.minStableMs = 500; // tests below exercise the stability window explicitly
  mutate(config);
  const sent: Animation[] = [];
  const registry = new TabRegistry();
  const queue = new CommandQueue({
    ...clock.deps,
    minIntervalMs: () => 1000,
    shouldRetry: () => false,
    send: async (a) => {
      sent.push(a);
      return { ok: true, message: 'ok' };
    },
  });
  const sm = new StateManager({ registry, queue, getConfig: () => config, ...clock.deps });
  let seq = 0;
  const report = (tabId: number, state: AIState, platform: Platform = 'claude') => {
    registry.report(tabId, { platform, state, confidence: 0.8, signals: [], seq: ++seq }, clock.now);
    sm.evaluate();
  };
  return { clock, config, sent, registry, queue, sm, report };
}

describe('StateManager', () => {
  it('runs a full request lifecycle: thinking → responding → completed → idle', async () => {
    const { clock, sent, report, registry } = setup();
    report(1, 'idle');
    registry.focus(1);
    await clock.advance(1000);
    expect(sent).toEqual(['none']);

    report(1, 'thinking');
    await clock.advance(400);
    expect(sent).toEqual(['none']); // not yet stable (500 ms)
    await clock.advance(200);
    expect(sent).toEqual(['none', 'thinking']);

    report(1, 'responding');
    await clock.advance(1500);
    expect(sent).toEqual(['none', 'thinking', 'typing']);

    report(1, 'completed');
    await clock.advance(1000);
    expect(sent).toEqual(['none', 'thinking', 'typing', 'ring']); // event state: no stability delay

    // Completion window ends → idle. `ring` returns to none by itself, so nothing is posted.
    await clock.advance(5000);
    expect(sent).toEqual(['none', 'thinking', 'typing', 'ring']);
  });

  it('debounces oscillation shorter than the minimum stable time', async () => {
    const { clock, sent, report } = setup();
    report(1, 'idle');
    await clock.advance(1000);
    for (let i = 0; i < 10; i++) {
      report(1, i % 2 ? 'responding' : 'thinking');
      await clock.advance(200);
    }
    report(1, 'responding');
    await clock.advance(3000);
    expect(sent).toEqual(['none', 'typing']);
  });

  it('suppresses duplicate commands when states map to the same animation', async () => {
    const { clock, sent, report, config } = setup((c) => (c.mapping.tool_use = 'typing'));
    report(1, 'responding');
    await clock.advance(1000);
    report(1, 'tool_use');
    await clock.advance(1000);
    report(1, 'responding');
    await clock.advance(1000);
    expect(sent).toEqual(['typing']);
    expect(config.mapping.responding).toBe('typing');
  });

  it('honours "disabled" mappings by leaving the robot alone', async () => {
    const { clock, sent, report } = setup();
    report(1, 'responding');
    await clock.advance(1000);
    report(1, 'user_typing'); // default mapping: disabled
    await clock.advance(2000);
    expect(sent).toEqual(['typing']);
  });

  it('sends none after an aborted request (busy → idle)', async () => {
    const { clock, sent, report } = setup();
    report(1, 'responding');
    await clock.advance(1000);
    report(1, 'idle');
    await clock.advance(1000);
    expect(sent).toEqual(['typing', 'none']);
  });

  it('error interrupts and then returns to idle', async () => {
    const { clock, sent, report } = setup();
    report(1, 'thinking');
    await clock.advance(1000);
    report(1, 'error');
    await clock.advance(1000);
    report(1, 'idle');
    await clock.advance(1000);
    expect(sent).toEqual(['thinking', 'error', 'none']);
  });

  it('falls back to none when a busy tab stops reporting (lost signal)', async () => {
    const { clock, sent, report } = setup();
    report(1, 'responding');
    await clock.advance(1000);
    expect(sent).toEqual(['typing']);
    await clock.advance(30_000); // no heartbeats
    await clock.advance(1000);
    expect(sent).toEqual(['typing', 'none']);
  });

  it('refreshes continuous animations with a keepalive while the tab is fresh', async () => {
    const { clock, sent, report } = setup((c) => (c.timing.keepaliveMs = 60_000));
    report(1, 'responding');
    await clock.advance(1000);
    for (let i = 0; i < 15; i++) {
      await clock.advance(10_000);
      report(1, 'responding'); // heartbeat
    }
    await clock.advance(100);
    expect(sent).toEqual(['typing', 'typing', 'typing']);
  });

  it('closing the controlling tab returns the robot to idle', async () => {
    const { clock, sent, report, registry, sm } = setup();
    report(1, 'responding');
    await clock.advance(1000);
    registry.remove(1);
    sm.evaluate();
    await clock.advance(1000);
    expect(sent).toEqual(['typing', 'none']);
  });

  it('switching between idle tabs sends nothing new', async () => {
    const { clock, sent, report, registry, sm } = setup();
    report(1, 'idle');
    report(2, 'idle', 'chatgpt');
    await clock.advance(1000);
    for (let i = 0; i < 6; i++) {
      registry.focus(i % 2 ? 1 : 2);
      sm.evaluate();
      await clock.advance(700);
    }
    expect(sent).toEqual(['none']);
  });

  it('sends none once when the bridge is disabled, and nothing afterwards', async () => {
    const { clock, sent, report, config, sm } = setup();
    report(1, 'responding');
    await clock.advance(1000);
    config.enabled = false;
    sm.evaluate();
    report(1, 'thinking');
    await clock.advance(5000);
    expect(sent).toEqual(['typing', 'none']);
    config.enabled = true;
    sm.invalidate();
    sm.evaluate();
    await clock.advance(2000);
    expect(sent).toEqual(['typing', 'none', 'thinking']);
  });

  it('restores after a background restart without re-sending', async () => {
    const a = setup();
    a.report(1, 'responding');
    await a.clock.advance(1000);
    const regSnap = a.registry.snapshot();
    const smSnap = a.sm.snapshot();
    const qSnap = a.queue.snapshot();

    const b = setup();
    b.clock.now = a.clock.now;
    b.registry.restore(regSnap);
    b.queue.restore(qSnap);
    b.sm.restore(smSnap);
    b.sm.evaluate();
    await b.clock.advance(2000);
    expect(b.sent).toEqual([]);
  });
});
