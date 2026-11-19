import { describe, expect, it } from 'vitest';
import { parseContentMessage, parsePageRequest } from '../src/shared/messaging';

const valid = { v: 1, kind: 'state', platform: 'claude', state: 'thinking', confidence: 0.6, signals: ['stop-button'], seq: 3 };

describe('parseContentMessage', () => {
  it('accepts well-formed messages', () => {
    expect(parseContentMessage(valid)).toEqual(valid);
    expect(parseContentMessage({ v: 1, kind: 'hello', platform: 'chatgpt' })).toEqual({ v: 1, kind: 'hello', platform: 'chatgpt' });
  });

  it('dedupes signals', () => {
    expect(parseContentMessage({ ...valid, signals: ['composer', 'composer'] })?.kind).toBe('state');
  });

  it.each([
    ['null', null],
    ['string', 'thinking'],
    ['array', [valid]],
    ['wrong version', { ...valid, v: 2 }],
    ['unknown kind', { ...valid, kind: 'command' }],
    ['unknown platform', { ...valid, platform: 'gemini' }],
    ['unknown state', { ...valid, state: 'hacking' }],
    ['confidence > 1', { ...valid, confidence: 1.5 }],
    ['confidence NaN', { ...valid, confidence: Number.NaN }],
    ['negative seq', { ...valid, seq: -1 }],
    ['fractional seq', { ...valid, seq: 1.5 }],
    ['unknown signal', { ...valid, signals: ['<script>'] }],
    ['signals not array', { ...valid, signals: 'stop-button' }],
    ['injected url', { ...valid, url: 'http://evil/' }],
    ['injected animation', { ...valid, animation: 'dead' }],
    ['injected method', { ...valid, method: 'DELETE' }],
    ['hello with extras', { v: 1, kind: 'hello', platform: 'claude', body: 'x' }],
  ])('rejects %s', (_label, msg) => expect(parseContentMessage(msg)).toBeNull());
});

describe('detection report messages', () => {
  const report = { durationMs: 1200, timeline: [{ t: 0, e: 'generation-start' }], mutations: [{ d: 'div.font-claude-response > p', type: 'text', act: true, add: '', n: 3, first: 10, last: 900 }] };

  it('accepts structural reports', () => {
    expect(parseContentMessage({ v: 1, kind: 'report', platform: 'claude', report })?.kind).toBe('report');
  });

  it.each([
    ['free text in a descriptor', { ...report, mutations: [{ ...report.mutations[0], d: 'p > Dear diary, my password is…' }] }],
    ['quotes/newlines', { ...report, timeline: [{ t: 0, e: "x'\n" }] }],
    ['too many groups', { ...report, mutations: Array(101).fill(report.mutations[0]) }],
    ['bad type', { ...report, mutations: [{ ...report.mutations[0], type: 'script' }] }],
    ['missing numbers', { ...report, durationMs: 'long' }],
  ])('rejects %s', (_l, r) => {
    expect(parseContentMessage({ v: 1, kind: 'report', platform: 'claude', report: r })).toBeNull();
  });
});

describe('parsePageRequest', () => {
  it('validates animation names', () => {
    expect(parsePageRequest({ kind: 'testAnimation', animation: 'ring' })).toEqual({ kind: 'testAnimation', animation: 'ring' });
    expect(parsePageRequest({ kind: 'testAnimation', animation: 'ring&x=1' })).toBeNull();
    expect(parsePageRequest({ kind: 'deleteEverything' })).toBeNull();
    expect(parsePageRequest({ kind: 'getStatus', extra: 1 })).toEqual({ kind: 'getStatus' });
  });
});
