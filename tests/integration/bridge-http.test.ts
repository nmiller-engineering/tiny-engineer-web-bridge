/**
 * End-to-end: Bridge (state machine + queue + HTTP client) against the mock
 * Tiny Engineer server over real HTTP on 127.0.0.1.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Bridge } from '../../src/background/bridge';
import { cloneDefaultConfig, type Config } from '../../src/shared/config';
import type { AIState, Platform } from '../../src/shared/types';
// @ts-expect-error — plain JS tool module
import { createMockRobot } from '../../tools/mock-tiny-engineer.mjs';

type MockRobot = ReturnType<typeof createMockRobot>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let robot: MockRobot | null = null;
let bridge: Bridge | null = null;

async function setup(opts: { token?: string; configToken?: string; delayMs?: number; provisioned?: boolean; mutate?: (c: Config) => void } = {}) {
  robot = createMockRobot({ token: opts.token ?? '', delayMs: opts.delayMs ?? 0, provisioned: opts.provisioned ?? true, quiet: true });
  const port: number = await robot!.listen();
  const config = cloneDefaultConfig();
  config.device = { ...config.device, host: '127.0.0.1', port, token: opts.configToken ?? opts.token ?? '' };
  config.timing.minStableMs = 50;
  config.timing.requestTimeoutMs = 500;
  opts.mutate?.(config);
  bridge = new Bridge(config, {
    fetch: (i, init) => fetch(i, init),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    hasDevicePermission: async () => true,
  });
  let seq = 0;
  const report = (state: AIState, tabId = 1, platform: Platform = 'claude') =>
    bridge!.handleContent({ v: 1, kind: 'state', platform, state, confidence: 0.8, signals: [], seq: ++seq }, tabId, true);
  return { robot: robot!, bridge, report, config };
}

afterEach(async () => {
  await robot?.close();
  robot = null;
  bridge = null;
});

describe('Bridge ↔ mock Tiny Engineer (HTTP)', () => {
  it('tests the connection via /auth, /health and /anim', async () => {
    const { bridge, robot } = await setup();
    const res = await bridge.testConnection();
    expect(res).toMatchObject({ ok: true, connection: 'connected', firmwareVersion: 'v0.3.0-mock', authRequired: false, robotAnimation: 'none' });
    expect(robot.state.requests.map((r: { path: string }) => r.path)).toEqual(['/auth', '/health', '/anim']);
    expect(robot.animPosts()).toEqual([]); // no motion during a test
  });

  it('uses optional Bearer auth', async () => {
    const { bridge, robot } = await setup({ token: 's3cret' });
    expect((await bridge.testConnection()).ok).toBe(true);
    const auths = robot.state.requests.map((r: { path: string; auth: string }) => `${r.path}:${r.auth}`);
    expect(auths).toEqual(['/auth:none', '/health:valid', '/anim:valid']);
  });

  it('reports a wrong or missing token', async () => {
    const wrong = await setup({ token: 's3cret', configToken: 'nope' });
    expect(await wrong.bridge.testConnection()).toMatchObject({ ok: false, connection: 'error' });
    await robot!.close();
    const missing = await setup({ token: 's3cret', configToken: '' });
    expect((await missing.bridge.testConnection()).message).toMatch(/requires an access token/);
  });

  it('reports an unprovisioned robot', async () => {
    const { bridge } = await setup({ provisioned: false });
    expect((await bridge.testConnection()).message).toMatch(/not provisioned/);
  });

  it('times out on a slow robot and reports a refused connection', async () => {
    const slow = await setup({ delayMs: 1500 });
    const res = await slow.bridge.testConnection();
    expect(res).toMatchObject({ ok: false, connection: 'disconnected' });
    expect(res.message).toMatch(/within 500 ms/);
    await robot!.close();
    robot = null;
    const config = cloneDefaultConfig();
    config.device = { ...config.device, host: '127.0.0.1', port: 9 }; // nothing listens on discard port
    const b = new Bridge(config, { fetch, now: Date.now, setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) });
    expect(await b.testConnection()).toMatchObject({ ok: false, connection: 'disconnected' });
  });

  it('drives a full AI response with valid commands only', async () => {
    const { robot, report } = await setup();
    report('idle');
    await sleep(200);
    report('thinking');
    await sleep(1200);
    report('responding');
    await sleep(1200);
    report('completed');
    await sleep(1200);
    report('idle');
    await sleep(500);
    const names = robot.animPosts().map((r: { name: string }) => r.name);
    expect(names).toEqual(['none', 'thinking', 'typing', 'ring']); // ring returns to none by itself
    expect(robot.animPosts().every((r: { status: number }) => r.status === 200)).toBe(true);
  });

  it('suppresses duplicates and collapses rapid changes', async () => {
    const { robot, report } = await setup();
    const states: AIState[] = ['thinking', 'responding', 'tool_use', 'responding', 'thinking', 'responding'];
    for (let i = 0; i < 60; i++) {
      report(states[i % states.length]!);
      await sleep(20);
    }
    report('responding');
    for (let i = 0; i < 10; i++) {
      report('responding'); // heartbeats
      await sleep(100);
    }
    await sleep(1500);
    const posts = robot.animPosts();
    expect(posts.length).toBeLessThanOrEqual(3);
    expect(posts.at(-1)?.name).toBe('typing');
    for (let i = 1; i < posts.length; i++) expect(posts[i].at - posts[i - 1].at).toBeGreaterThanOrEqual(950);
  });

  it('works without the robot and recovers when it comes back', async () => {
    const { robot, report, bridge } = await setup();
    const port = (robot.server.address() as { port: number }).port;
    await robot.close();
    report('responding');
    await sleep(800);
    expect(bridge.getStatus().connection).toBe('disconnected');
    const again = createMockRobot({ quiet: true });
    robot2 = again;
    await again.listen(port);
    await bridge.probe();
    await sleep(1500);
    expect(bridge.getStatus().connection).toBe('connected');
    expect(again.animPosts().map((r: { name: string }) => r.name)).toEqual(['typing']);
  });
});

let robot2: MockRobot | null = null;
afterEach(async () => {
  await robot2?.close();
  robot2 = null;
});
