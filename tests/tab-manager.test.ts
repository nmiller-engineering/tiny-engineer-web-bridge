import { describe, expect, it } from 'vitest';
import { effectiveState, TabRegistry } from '../src/background/tab-manager';
import type { AIState, Platform } from '../src/shared/types';

const timing = { completionMs: 2000, staleMs: 30_000 };
const T0 = 1_000_000;

function rep(reg: TabRegistry, tabId: number, state: AIState, now: number, platform: Platform = 'claude', seq = now) {
  return reg.report(tabId, { platform, state, confidence: 0.8, signals: [], seq }, now);
}

describe('effectiveState', () => {
  it('expires completed into idle and stale busy states into unknown', () => {
    const reg = new TabRegistry();
    rep(reg, 1, 'completed', T0);
    expect(effectiveState(reg.get(1)!, T0 + 1999, timing)).toBe('completed');
    expect(effectiveState(reg.get(1)!, T0 + 2000, timing)).toBe('idle');
    rep(reg, 2, 'responding', T0);
    expect(effectiveState(reg.get(2)!, T0 + 30_000, timing)).toBe('responding');
    expect(effectiveState(reg.get(2)!, T0 + 30_001, timing)).toBe('unknown');
    rep(reg, 3, 'idle', T0);
    expect(effectiveState(reg.get(3)!, T0 + 10_000_000, timing)).toBe('idle');
  });

  it('keeps stateSince across heartbeats of the same state', () => {
    const reg = new TabRegistry();
    rep(reg, 1, 'completed', T0);
    rep(reg, 1, 'completed', T0 + 1500);
    expect(reg.get(1)!.stateSince).toBe(T0);
    expect(reg.get(1)!.lastSeen).toBe(T0 + 1500);
  });

  it('drops out-of-order reports', () => {
    const reg = new TabRegistry();
    expect(rep(reg, 1, 'responding', T0, 'claude', 5)).toBe(true);
    expect(rep(reg, 1, 'thinking', T0 + 1, 'claude', 4)).toBe(false);
    expect(reg.get(1)!.state).toBe('responding');
  });
});

describe('arbitration', () => {
  it('active-tab: the most recently focused AI tab wins, even if another is busy', () => {
    const reg = new TabRegistry();
    rep(reg, 1, 'responding', T0, 'chatgpt');
    rep(reg, 2, 'idle', T0, 'claude');
    reg.focus(1);
    reg.focus(2);
    expect(reg.select('active-tab', T0, timing)).toMatchObject({ tabId: 2, state: 'idle' });
    reg.focus(99); // a non-AI tab: control stays with the last AI tab
    expect(reg.select('active-tab', T0, timing)).toMatchObject({ tabId: 2 });
    reg.focus(1);
    expect(reg.select('active-tab', T0, timing)).toMatchObject({ tabId: 1, state: 'responding' });
  });

  it('activity-priority: a busy background tab beats an idle focused tab', () => {
    const reg = new TabRegistry();
    rep(reg, 1, 'responding', T0, 'chatgpt');
    rep(reg, 2, 'idle', T0, 'claude');
    reg.focus(2);
    expect(reg.select('activity-priority', T0, timing)).toMatchObject({ tabId: 1, state: 'responding' });
  });

  it('activity-priority: focus breaks ties, then recency, then tab id', () => {
    const reg = new TabRegistry();
    rep(reg, 5, 'thinking', T0);
    rep(reg, 3, 'responding', T0 + 10);
    expect(reg.select('activity-priority', T0 + 20, timing)?.tabId).toBe(3); // more recent state change
    reg.focus(5);
    expect(reg.select('activity-priority', T0 + 20, timing)?.tabId).toBe(5); // focused
    const reg2 = new TabRegistry();
    rep(reg2, 9, 'thinking', T0);
    rep(reg2, 4, 'thinking', T0);
    expect(reg2.select('activity-priority', T0, timing)?.tabId).toBe(4); // deterministic
  });

  it('activity-priority: completion in a background tab is shown, then expires', () => {
    const reg = new TabRegistry();
    rep(reg, 1, 'completed', T0);
    rep(reg, 2, 'idle', T0);
    reg.focus(2);
    expect(reg.select('activity-priority', T0 + 100, timing)).toMatchObject({ tabId: 1, state: 'completed' });
    expect(reg.select('activity-priority', T0 + 2100, timing)).toMatchObject({ tabId: 2, state: 'idle' });
  });

  it('stale busy tabs lose priority', () => {
    const reg = new TabRegistry();
    rep(reg, 1, 'responding', T0);
    rep(reg, 2, 'user_typing', T0 + 40_000);
    expect(reg.select('activity-priority', T0 + 40_000, timing)).toMatchObject({ tabId: 2, state: 'user_typing' });
  });

  it('returns null without tabs, removes closed tabs and survives snapshot/restore', () => {
    const reg = new TabRegistry();
    expect(reg.select('active-tab', T0, timing)).toBeNull();
    rep(reg, 1, 'thinking', T0);
    reg.focus(1);
    const copy = new TabRegistry();
    copy.restore(reg.snapshot());
    expect(copy.select('active-tab', T0, timing)).toMatchObject({ tabId: 1, state: 'thinking' });
    copy.remove(1);
    expect(copy.select('active-tab', T0, timing)).toBeNull();
  });

  it('computes the next self-expiry', () => {
    const reg = new TabRegistry();
    rep(reg, 1, 'completed', T0);
    rep(reg, 2, 'thinking', T0);
    expect(reg.nextExpiry(T0, timing)).toBe(T0 + 2000);
    expect(reg.nextExpiry(T0 + 2000, timing)).toBe(T0 + 30_001);
  });
});
