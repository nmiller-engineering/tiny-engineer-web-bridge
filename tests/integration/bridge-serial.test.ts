/** End-to-end: Bridge using the USB (Web Serial) transport against fake firmware. */
import { describe, expect, it } from 'vitest';
import { Bridge } from '../../src/background/bridge';
import { cloneDefaultConfig } from '../../src/shared/config';
import type { AIState } from '../../src/shared/types';
import { FakeFirmwarePort, fakeProvider } from '../helpers/fake-serial';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(port: FakeFirmwarePort | null) {
  const config = cloneDefaultConfig();
  config.device.transport = 'serial';
  config.timing.minStableMs = 50;
  config.timing.requestTimeoutMs = 300;
  let fetchCalls = 0;
  const bridge = new Bridge(config, {
    fetch: async () => {
      fetchCalls++;
      throw new Error('no network expected');
    },
    now: Date.now,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    serialProvider: () => (port ? fakeProvider([port]) : null),
  });
  let seq = 0;
  const report = (state: AIState) => bridge.handleContent({ v: 1, kind: 'state', platform: 'chatgpt', state, confidence: 0.8, signals: [], seq: ++seq }, 1, true);
  return { bridge, report, fetchCalls: () => fetchCalls };
}

describe('Bridge ↔ fake firmware (USB / Web Serial)', () => {
  it('tests the connection over USB without any HTTP', async () => {
    const port = new FakeFirmwarePort();
    const { bridge, fetchCalls } = setup(port);
    expect(bridge.getStatus().connection).not.toBe('unconfigured');
    const res = await bridge.testConnection();
    expect(res).toMatchObject({ ok: true, connection: 'connected', firmwareVersion: 'v0.3.0-serial' });
    expect(res.message).toMatch(/over USB/);
    expect(fetchCalls()).toBe(0);
  });

  it('drives animations over USB', async () => {
    const port = new FakeFirmwarePort();
    const { report } = setup(port);
    report('thinking');
    await sleep(1200);
    report('responding');
    await sleep(1200);
    report('completed');
    await sleep(500);
    expect(port.received.filter((r) => r.op === 'anim').map((r) => r.name)).toEqual(['thinking', 'typing', 'ring']);
    expect(port.opens).toBe(1);
  });

  it('explains when Web Serial is unavailable', async () => {
    const { bridge } = setup(null);
    const res = await bridge.testConnection();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Web Serial is not available/);
  });

  it('releases the port when switching back to Wi-Fi', async () => {
    const port = new FakeFirmwarePort();
    const { bridge } = setup(port);
    await bridge.testConnection();
    expect(port.isOpen).toBe(true);
    const next = structuredClone(bridge.currentConfig);
    next.device.transport = 'http';
    bridge.setConfig(next);
    await sleep(20);
    expect(port.isOpen).toBe(false);
  });
});
