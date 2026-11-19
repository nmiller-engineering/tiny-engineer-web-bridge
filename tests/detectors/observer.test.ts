// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentBridge } from '../../src/content/observer';
import { claudeProfile } from '../../src/detectors/claude';
import type { ContentMessage } from '../../src/shared/messaging';
import { parseContentMessage } from '../../src/shared/messaging';
import { loadFixture } from '../helpers/dom';

const reply = (active: boolean) => ({ active, debounceMs: 300, typingIdleMs: 4000, completionMs: 2000, heartbeatMs: 2000 });

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('ContentBridge', () => {
  it('says hello, reports valid state messages and heartbeats only while busy', async () => {
    loadFixture('claude', 'thinking');
    const sent: ContentMessage[] = [];
    const bridge = new ContentBridge(claudeProfile, { send: async (m) => (sent.push(m), reply(true)) });
    await bridge.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent[0]).toEqual({ v: 1, kind: 'hello', platform: 'claude' });
    expect(sent.every((m) => parseContentMessage(m) !== null)).toBe(true); // passes the background validator
    const states = sent.filter((m) => m.kind === 'state');
    expect(states.at(-1)).toMatchObject({ state: 'thinking' });
    const before = states.length;
    await vi.advanceTimersByTimeAsync(4100);
    expect(sent.filter((m) => m.kind === 'state').length).toBeGreaterThanOrEqual(before + 2); // heartbeats
    bridge.stop();
  });

  it('stays dormant when the background says the platform is inactive', async () => {
    loadFixture('claude', 'thinking');
    const sent: ContentMessage[] = [];
    const bridge = new ContentBridge(claudeProfile, { send: async (m) => (sent.push(m), reply(false)) });
    await bridge.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(1);
  });

  it('stops quietly when the extension context is gone', async () => {
    loadFixture('claude', 'idle');
    const send = vi.fn(async () => {
      throw new Error('Extension context invalidated.');
    });
    const bridge = new ContentBridge(claudeProfile, { send });
    await bridge.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports idle on pagehide', async () => {
    loadFixture('claude', 'thinking');
    const sent: ContentMessage[] = [];
    const bridge = new ContentBridge(claudeProfile, { send: async (m) => (sent.push(m), reply(true)) });
    await bridge.start();
    await vi.advanceTimersByTimeAsync(500);
    window.dispatchEvent(new Event('pagehide'));
    expect(sent.at(-1)).toMatchObject({ kind: 'state', state: 'idle' });
    bridge.stop();
  });
});
