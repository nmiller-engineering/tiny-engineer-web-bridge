// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomDetector, type PlatformProfile } from '../../src/detectors/base';
import { chatgptProfile } from '../../src/detectors/chatgpt';
import { claudeProfile } from '../../src/detectors/claude';
import { openwebuiProfile } from '../../src/detectors/openwebui';
import { parseContentMessage } from '../../src/shared/messaging';
import type { AIState } from '../../src/shared/types';
import { appendToken, click, loadFixture, typeInto } from '../helpers/dom';

interface Scenario {
  name: string;
  profile: PlatformProfile;
  dir: string;
  composer: string;
  streamTarget: string;
  stop: string;
}

const SCENARIOS: Scenario[] = [
  { name: 'ChatGPT', profile: chatgptProfile, dir: 'chatgpt', composer: '#prompt-textarea', streamTarget: '[data-message-author-role="assistant"] .markdown', stop: '[data-testid="stop-button"]' },
  { name: 'Claude', profile: claudeProfile, dir: 'claude', composer: '.ProseMirror', streamTarget: '.font-claude-response', stop: 'button[aria-label="Stop response"]' },
  { name: 'Open WebUI', profile: openwebuiProfile, dir: 'openwebui', composer: '#chat-input', streamTarget: '[id^="c-"][id$="-content"]', stop: 'button[aria-label="Stop"]' },
];

let detector: DomDetector;
let emitted: AIState[];
let path = '/c/1';

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function start(profile: PlatformProfile): void {
  emitted = [];
  detector = new DomDetector(profile, { getPath: () => path, timing: { debounceMs: 300, typingIdleMs: 4000, completedHoldMs: 3000 } });
  detector.subscribe((s) => emitted.push(s));
  detector.initialize();
}

/** Stream for `ms`, one token every 150 ms. */
async function stream(selector: string, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 150) {
    appendToken(selector);
    await tick(150);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  path = '/c/1';
  document.body.replaceChildren();
});

afterEach(() => {
  detector?.destroy();
  vi.useRealTimers();
});

describe.each(SCENARIOS)('$name detector (fixtures)', (sc) => {
  it('reports idle for an idle chat', async () => {
    loadFixture(sc.dir, 'idle');
    start(sc.profile);
    await tick(1000);
    expect(detector.getState()).toBe('idle');
    expect(detector.getSnapshot().signals).toContain('composer');
    expect(emitted).toEqual([]);
  });

  it('detects user typing and returns to idle after inactivity', async () => {
    loadFixture(sc.dir, 'idle');
    start(sc.profile);
    await tick(500);
    for (let i = 0; i < 5; i++) {
      typeInto(sc.composer);
      await tick(200);
    }
    await tick(300);
    expect(detector.getState()).toBe('user_typing');
    await tick(5000);
    expect(detector.getState()).toBe('idle');
    expect(emitted).toEqual(['user_typing', 'idle']);
  });

  it('ignores input outside the composer', async () => {
    loadFixture(sc.dir, 'idle');
    const other = document.createElement('input');
    document.body.append(other);
    start(sc.profile);
    other.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await tick(1000);
    expect(detector.getState()).toBe('idle');
  });

  it('runs thinking → responding → completed → idle', async () => {
    loadFixture(sc.dir, 'idle');
    start(sc.profile);
    await tick(500);
    loadFixture(sc.dir, 'thinking');
    await tick(1000);
    expect(detector.getState()).toBe('thinking');
    loadFixture(sc.dir, 'streaming');
    await stream(sc.streamTarget, 2000);
    expect(detector.getState()).toBe('responding');
    expect(detector.getSnapshot().signals).toContain('response-activity');
    loadFixture(sc.dir, 'completed');
    await tick(2500); // completion waits 2 s without busy signals (agents pause between steps)
    expect(detector.getState()).toBe('completed');
    await tick(3500);
    expect(detector.getState()).toBe('idle');
    expect(emitted).toEqual(['thinking', 'responding', 'completed', 'idle']);
  });

  it('treats a stop-button click as an abort (no completion)', async () => {
    loadFixture(sc.dir, 'streaming');
    start(sc.profile);
    await stream(sc.streamTarget, 1500);
    expect(detector.getState()).toBe('responding');
    click(sc.stop);
    loadFixture(sc.dir, 'completed');
    await tick(3000);
    expect(detector.getState()).toBe('idle');
    expect(emitted).not.toContain('completed');
    expect(emitted.at(-1)).toBe('idle');
  });

  it('reports an error that appears during a request', async () => {
    loadFixture(sc.dir, 'thinking');
    start(sc.profile);
    await tick(1000);
    loadFixture(sc.dir, 'error');
    await tick(1000);
    expect(detector.getState()).toBe('error');
    await tick(9000);
    expect(detector.getState()).toBe('idle');
    expect(emitted).toEqual(['thinking', 'error', 'idle']);
  });

  it('does not report an error that was already on the page', async () => {
    loadFixture(sc.dir, 'error');
    start(sc.profile);
    await tick(2000);
    expect(detector.getState()).toBe('idle');
  });

  it('ignores unrelated DOM churn and re-renders of old answers', async () => {
    loadFixture(sc.dir, 'idle');
    start(sc.profile);
    const nav = document.querySelector('nav')!;
    for (let i = 0; i < 20; i++) {
      nav.append(document.createElement('a'));
      appendToken(sc.streamTarget === '[id^="c-"][id$="-content"]' ? '#c-1-content' : sc.streamTarget);
      await tick(100);
    }
    await tick(1000);
    expect(emitted).toEqual([]);
    expect(detector.getState()).toBe('idle');
  });

  it('does not mistake SPA navigation to another chat for a completion', async () => {
    loadFixture(sc.dir, 'streaming');
    start(sc.profile);
    await stream(sc.streamTarget, 1200);
    path = '/c/2';
    loadFixture(sc.dir, 'idle');
    await tick(4000);
    expect(emitted).not.toContain('completed');
    expect(detector.getState()).toBe('idle');
  });

  it('tolerates brief flicker of the stop control between steps', async () => {
    loadFixture(sc.dir, 'streaming');
    start(sc.profile);
    await stream(sc.streamTarget, 900);
    loadFixture(sc.dir, 'completed');
    await tick(300); // shorter than the end grace period
    loadFixture(sc.dir, 'streaming');
    await stream(sc.streamTarget, 900);
    expect(emitted).not.toContain('completed');
  });

  it('stops observing after destroy()', async () => {
    loadFixture(sc.dir, 'idle');
    start(sc.profile);
    detector.destroy();
    loadFixture(sc.dir, 'thinking');
    await tick(2000);
    expect(emitted).toEqual([]);
  });
});

describe('platform specifics', () => {
  it('Open WebUI: reports tool_use while a status shimmer is shown', async () => {
    loadFixture('openwebui', 'thinking');
    start(openwebuiProfile);
    await tick(1000);
    loadFixture('openwebui', 'tool');
    await tick(1000);
    expect(detector.getState()).toBe('tool_use');
    expect(detector.getSnapshot().signals).toContain('tool-marker');
  });

  it('Open WebUI: the cursor marker alone keeps generation alive when the stop button is hidden (user typing during generation)', async () => {
    loadFixture('openwebui', 'thinking');
    start(openwebuiProfile);
    await tick(800);
    document.querySelector('button[aria-label="Stop"]')!.remove();
    await tick(2000);
    expect(detector.getState()).toBe('thinking');
  });

  it('ChatGPT: a read-aloud "Stop" button is not a generation signal', async () => {
    loadFixture('chatgpt', 'completed');
    start(chatgptProfile);
    await tick(1500);
    expect(detector.getState()).toBe('idle');
  });

  it('ChatGPT: a hidden stop button is ignored', async () => {
    loadFixture('chatgpt', 'thinking');
    (document.querySelector('[data-testid="stop-button"]') as HTMLElement).style.display = 'none';
    document.querySelector('.result-streaming')!.classList.remove('result-streaming');
    start(chatgptProfile);
    await tick(1500);
    expect(detector.getState()).toBe('idle');
  });

  it('reports unknown when the page layout is not recognized', async () => {
    loadFixture('chatgpt', 'unrecognized');
    start(chatgptProfile);
    await tick(1000);
    expect(detector.getState()).toBe('idle');
    await tick(5500);
    expect(detector.getState()).toBe('unknown');
    expect(detector.getSnapshot().signals).toContain('layout-unrecognized');
    expect(detector.getSnapshot().confidence).toBeLessThan(0.5);
  });

  it('survives invalid selectors in a profile', async () => {
    loadFixture('claude', 'idle');
    start({ ...claudeProfile, stopButtons: ['button[[[broken'], error: [':::nope'] });
    await tick(1000);
    expect(detector.getState()).toBe('idle');
  });

  it('never exposes page text in its snapshot', async () => {
    loadFixture('claude', 'streaming');
    start(claudeProfile);
    await stream('.font-claude-response', 1000);
    const json = JSON.stringify(detector.getSnapshot());
    expect(json).not.toMatch(/Partial|token|Question|Hello/);
  });
});

describe('privacy of label inspection', () => {
  it('reads aria-labels only of controls whose label starts with "stop"', async () => {
    loadFixture('chatgpt', 'idle');
    const titled = document.createElement('button');
    titled.setAttribute('aria-label', 'Open conversation options for My secret project');
    document.querySelector('nav')!.append(titled);
    const reads: string[] = [];
    const orig = Element.prototype.getAttribute;
    Element.prototype.getAttribute = function (name: string) {
      if (name === 'aria-label') reads.push(orig.call(this, name) ?? '');
      return orig.call(this, name);
    };
    try {
      start(chatgptProfile);
      titled.click();
      await tick(1000);
    } finally {
      Element.prototype.getAttribute = orig;
    }
    expect(reads.some((r) => r.includes('secret'))).toBe(false);
  });
});

describe('Claude live structure (from a real detection report)', () => {
  it('counts animated text spans inside a busy-marked message as responding', async () => {
    loadFixture('claude', 'idle');
    start(claudeProfile);
    await tick(500);
    loadFixture('claude', 'live-streaming');
    const p = document.querySelector('.answer')!;
    for (let i = 0; i < 15; i++) {
      const span = document.createElement('span');
      span.className = '_animating_ta2es_10';
      span.setAttribute('data-wf', '');
      span.append(document.createTextNode(' word'));
      p.append(span);
      await tick(150);
    }
    expect(detector.getState()).toBe('responding');
    expect(detector.getSnapshot().signals).toEqual(expect.arrayContaining(['streaming-marker', 'response-activity']));
  });
});

describe('detection report (debug only)', () => {
  it('records structure of a request without any page text', async () => {
    const reports: unknown[] = [];
    loadFixture('claude', 'idle');
    emitted = [];
    detector = new DomDetector(claudeProfile, { getPath: () => path, onReport: (r) => reports.push(r) });
    detector.trace.setEnabled(true);
    detector.initialize();
    await tick(500);
    loadFixture('claude', 'live-streaming');
    await tick(800);
    await stream('.answer', 900);
    loadFixture('claude', 'completed');
    await tick(2600);
    expect(reports).toHaveLength(1);
    const json = JSON.stringify(reports[0]);
    expect(json).not.toMatch(/Thinking|Hello|Question|Partial|token|Full answer|Write your prompt|Earlier chat/);
    expect(json).toContain('generation-start');
    expect(json).toContain('data-alluvium');
    const msg = parseContentMessage({ v: 1, kind: 'report', platform: 'claude', report: reports[0] });
    expect(msg?.kind).toBe('report');
    const report = reports[0] as { mutations: { act: boolean; d: string }[] };
    expect(report.mutations.some((m) => m.act && m.d.includes('p.answer'))).toBe(true);
  });

  it('records nothing while tracing is off', async () => {
    const reports: unknown[] = [];
    loadFixture('claude', 'thinking');
    detector = new DomDetector(claudeProfile, { getPath: () => path, onReport: (r) => reports.push(r) });
    detector.initialize();
    await tick(800);
    loadFixture('claude', 'completed');
    await tick(1500);
    expect(reports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Submit detection and answer blocks (design of 2026-11-19)
// ---------------------------------------------------------------------------

function typeDraft(text = 'Hello Claude'): void {
  const p = document.querySelector('.ProseMirror p')!;
  p.textContent = text;
  p.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

function pressEnter(opts: KeyboardEventInit = {}): void {
  document.querySelector('.ProseMirror')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...opts }));
}

function addUserMessage(): void {
  const m = document.createElement('div');
  m.setAttribute('data-testid', 'user-message');
  document.querySelector('main')!.prepend(m);
}

/** Append a transcript item: a text block, or a non-text block with a status header. */
function addBlock(kind: 'text' | 'status', label = ''): HTMLElement {
  const item = document.createElement('div');
  item.className = 'contents';
  item.setAttribute('data-item-key', String(Math.random()));
  if (kind === 'text') {
    const prose = document.createElement('div');
    prose.className = 'prose';
    prose.append(document.createElement('p'));
    item.append(prose);
  } else {
    const header = document.createElement('button');
    header.setAttribute('aria-expanded', 'false');
    header.textContent = label;
    const body = document.createElement('div');
    body.className = 'block-body';
    item.append(header, body);
  }
  document.getElementById('transcript')!.append(item);
  return item;
}

async function grow(el: Element, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 150) {
    el.append(document.createTextNode(' word'));
    await tick(150);
  }
}

describe('submit detection: thinking starts when the prompt is sent', () => {
  it('Enter in a non-empty prompt → thinking before any answer element exists', async () => {
    loadFixture('claude', 'idle');
    start(claudeProfile);
    await tick(300);
    typeDraft();
    pressEnter();
    addUserMessage(); // Claude shows the sent message right away
    await tick(400);
    expect(detector.getState()).toBe('thinking');
    expect(detector.getSnapshot().signals).toContain('submitted');
    await tick(8000); // long wait for the first token: still thinking (confirmed submit)
    expect(detector.getState()).toBe('thinking');
    loadFixture('claude', 'live-blocks');
    await grow(addBlock('text').querySelector('p')!, 1200);
    expect(detector.getState()).toBe('responding');
    // Typing and sending within the debounce window skips a "user typing" flash.
    expect(emitted).toEqual(['thinking', 'responding']);
  });

  it('Enter in an empty prompt, and Shift+Enter, are not submits', async () => {
    loadFixture('claude', 'idle');
    start(claudeProfile);
    await tick(300);
    pressEnter();
    await tick(600);
    expect(detector.getState()).toBe('idle');
    typeDraft();
    pressEnter({ shiftKey: true });
    await tick(600);
    expect(detector.getState()).toBe('user_typing');
  });

  it('an unconfirmed submit falls back to idle after a few seconds', async () => {
    loadFixture('claude', 'idle');
    start(claudeProfile);
    typeDraft();
    pressEnter(); // e.g. blocked by a validation error: no message appears
    await tick(500);
    expect(detector.getState()).toBe('thinking');
    await tick(4500);
    expect(detector.getState()).not.toBe('thinking');
  });

  it('a click on the send button with a draft is a submit (ChatGPT)', async () => {
    loadFixture('chatgpt', 'idle');
    start(chatgptProfile);
    await tick(300);
    const p = document.querySelector('#prompt-textarea p')!;
    p.textContent = 'Question';
    (document.querySelector('[data-testid="send-button"]') as HTMLElement).click();
    await tick(400);
    expect(detector.getState()).toBe('thinking');
  });

  it('survives the new-chat URL change right after sending', async () => {
    loadFixture('claude', 'idle');
    path = '/new';
    start(claudeProfile);
    typeDraft();
    pressEnter();
    addUserMessage();
    await tick(200);
    path = '/chat/abc'; // claude.ai navigates to the new conversation
    await tick(2000);
    expect(detector.getState()).toBe('thinking');
  });
});

describe('active answer block decides thinking / tool use / responding (Claude)', () => {
  it('thinking block → tool block → text block', async () => {
    loadFixture('claude', 'live-blocks');
    start(claudeProfile);
    const thinking = addBlock('status', 'Thinking…');
    await grow(thinking.querySelector('.block-body')!, 900); // thought text streams, still thinking
    expect(detector.getState()).toBe('thinking');
    expect(detector.getSnapshot().signals).toContain('block-thinking');

    const tool = addBlock('status', 'Searching the web');
    await tick(600);
    expect(detector.getState()).toBe('tool_use');
    expect(detector.getSnapshot().signals).toContain('block-tool');
    tool.querySelector('button')!.textContent = 'Searched 8 sites';
    await tick(400);
    expect(detector.getState()).toBe('tool_use');

    const text = addBlock('text');
    await grow(text.querySelector('p')!, 900);
    expect(detector.getState()).toBe('responding');
    expect(detector.getSnapshot().signals).toContain('block-text');
    expect(emitted).toEqual(['thinking', 'tool_use', 'responding']);
  });

  it('German UI labels', async () => {
    loadFixture('claude', 'live-blocks');
    start(claudeProfile);
    addBlock('status', 'Durchsucht das Web');
    await tick(600);
    expect(detector.getState()).toBe('tool_use');
  });

  it('an unknown non-text block counts as thinking, not as an answer', async () => {
    loadFixture('claude', 'live-blocks');
    start(claudeProfile);
    const b = addBlock('status', 'Artifact');
    await grow(b.querySelector('.block-body')!, 900);
    expect(detector.getState()).toBe('thinking');
  });

  it('no label text reaches snapshots or detection reports', async () => {
    const reports: unknown[] = [];
    loadFixture('claude', 'live-blocks');
    detector = new DomDetector(claudeProfile, { getPath: () => path, onReport: (r) => reports.push(r) });
    detector.trace.setEnabled(true);
    emitted = [];
    detector.subscribe((s) => emitted.push(s));
    detector.initialize();
    addBlock('status', 'Searching the web for secret-topic');
    await tick(600);
    loadFixture('claude', 'completed');
    await tick(2600);
    const json = JSON.stringify([detector.getSnapshot(), reports]);
    expect(json).not.toMatch(/Searching|secret-topic/);
    expect(json).toContain('block:tool');
  });
});


describe('agent runs: "completed" only when the whole task is finished', () => {
  function setStreaming(on: boolean): void {
    document.querySelector('[data-testid="assistant-message"]')!.setAttribute('data-is-streaming', String(on));
  }
  function setBusy(on: boolean): void {
    const m = document.querySelector('[data-testid="assistant-message"]')!;
    if (on) m.setAttribute('data-busy', 'true');
    else {
      m.removeAttribute('data-busy');
      m.removeAttribute('aria-busy');
      document.querySelector('[data-transcript-live]')?.removeAttribute('data-transcript-live');
    }
  }

  it('pauses between steps (no busy marker) shorter than the wait do not complete', async () => {
    loadFixture('claude', 'live-blocks');
    setBusy(false);
    start(claudeProfile);
    for (let step = 0; step < 3; step++) {
      setStreaming(true);
      await grow(addBlock('text').querySelector('p')!, 900);
      setStreaming(false); // step done, tool executes
      await tick(1500);
      expect(detector.getState()).not.toBe('completed');
    }
    await tick(2500); // final: nothing restarts
    expect(emitted.filter((s) => s === 'completed')).toHaveLength(1);
    expect(emitted).not.toContain('idle');
  });

  it('a turn-level busy marker keeps a long tool step running', async () => {
    loadFixture('claude', 'live-blocks');
    start(claudeProfile);
    await grow(addBlock('text').querySelector('p')!, 900);
    setStreaming(false); // streaming paused for a long-running command…
    await tick(8000); // …but the message is still marked busy
    expect(detector.getState()).toBe('thinking');
    expect(emitted).not.toContain('completed');
    setBusy(false); // the whole reply is finished
    await tick(2500);
    expect(detector.getState()).toBe('completed');
    expect(emitted.filter((s) => s === 'completed')).toHaveLength(1);
  });
});
