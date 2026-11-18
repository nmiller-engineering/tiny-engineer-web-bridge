// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomDetector, type PlatformProfile } from '../../src/detectors/base';
import { chatgptProfile } from '../../src/detectors/chatgpt';
import { claudeProfile } from '../../src/detectors/claude';
import { openwebuiProfile } from '../../src/detectors/openwebui';
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
    await tick(1200);
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
