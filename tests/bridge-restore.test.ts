import { describe, expect, it } from 'vitest';
import { sanitizeSnapshot, type BridgeSnapshot } from '../src/background/bridge';

describe('restored session data', () => {
  it('drops malformed records and unknown values', () => {
    const snap = {
      registry: {
        records: [
          { tabId: 1, platform: 'claude', state: 'thinking', confidence: 0.6, signals: ['stop-button', '<x>'], stateSince: 1, lastSeen: 1, seq: 0 },
          { tabId: 2, platform: 'evil', state: 'thinking', confidence: 1, signals: [], stateSince: 1, lastSeen: 1, seq: 0 },
          { tabId: 'x', platform: 'claude', state: 'idle', confidence: 1, signals: [], stateSince: 1, lastSeen: 1, seq: 0 },
          null,
        ],
        focusOrder: [1, 'a', 2.5],
      },
      state: { committed: null, lastKeepaliveAt: 0, disabledHandled: false },
      queue: { believed: 'self-destruct', believedAt: 'now' },
      status: {},
    } as unknown as BridgeSnapshot;
    const clean = sanitizeSnapshot(snap);
    expect(clean.registry.records.map((r) => r.tabId)).toEqual([1]);
    expect(clean.registry.records[0]!.signals).toEqual(['stop-button']);
    expect(clean.registry.focusOrder).toEqual([1]);
    expect(clean.queue).toEqual({ believed: null, believedAt: 0 });
  });
});
