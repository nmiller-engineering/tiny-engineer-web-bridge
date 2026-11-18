/**
 * Content-script runtime: runs one detector in an AI page and reports
 * normalized state to the background script.
 *
 * Privacy/security boundary:
 *  - Only `hello` and `state` messages with enumerated values are sent.
 *  - No storage, no network, no access to configuration or tokens.
 *  - Never reads, stores or sends conversation text.
 */
import { DomDetector, type DetectorTiming, type PlatformProfile } from '../detectors/base';
import { PROTOCOL_VERSION, type ContentMessage, type ContentReply } from '../shared/messaging';

export interface Transport {
  send(message: ContentMessage): Promise<unknown>;
}

const GUARD = Symbol.for('tiny-engineer-web-bridge.content');

function parseReply(raw: unknown): ContentReply | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const debounceMs = num(r.debounceMs);
  const typingIdleMs = num(r.typingIdleMs);
  const completionMs = num(r.completionMs);
  const heartbeatMs = num(r.heartbeatMs);
  if (typeof r.active !== 'boolean' || debounceMs === null || typingIdleMs === null || completionMs === null || heartbeatMs === null) {
    return null;
  }
  return { active: r.active, debounceMs, typingIdleMs, completionMs, heartbeatMs };
}

export function detectorTimingFromReply(reply: ContentReply): Partial<DetectorTiming> {
  return {
    debounceMs: reply.debounceMs,
    typingIdleMs: reply.typingIdleMs,
    // Report `completed` a little longer than the background shows it, so
    // the background (not message timing) decides when it ends.
    completedHoldMs: reply.completionMs + 1000,
  };
}

export class ContentBridge {
  private detector: DomDetector | null = null;
  private seq = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatMs = 10_000;
  private stopped = false;

  constructor(
    private readonly profile: PlatformProfile,
    private readonly transport: Transport,
    private readonly win: Window = window,
  ) {}

  async start(): Promise<void> {
    const reply = await this.post({ v: PROTOCOL_VERSION, kind: 'hello', platform: this.profile.platform });
    if (!reply || !reply.active || this.stopped) {
      this.stop();
      return;
    }
    this.heartbeatMs = Math.max(2000, reply.heartbeatMs);
    this.detector = new DomDetector(this.profile, { document: this.win.document, timing: detectorTimingFromReply(reply) });
    this.detector.subscribe(() => this.report());
    this.detector.initialize();
    this.report();
    this.heartbeat = setInterval(() => {
      // Only busy states need a heartbeat; idle tabs stay silent.
      if (this.detector && this.detector.getState() !== 'idle') this.report();
    }, this.heartbeatMs);
    this.win.addEventListener('pagehide', this.onPageHide);
    this.win.addEventListener('pageshow', this.onPageShow);
  }

  stop(): void {
    this.stopped = true;
    this.detector?.destroy();
    this.detector = null;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.win.removeEventListener('pagehide', this.onPageHide);
    this.win.removeEventListener('pageshow', this.onPageShow);
  }

  /** Page goes away or into the back/forward cache: tell the background we are idle. */
  private readonly onPageHide = () => {
    if (!this.detector) return;
    void this.post({ v: PROTOCOL_VERSION, kind: 'state', platform: this.profile.platform, state: 'idle', confidence: 1, signals: [], seq: ++this.seq });
  };

  private readonly onPageShow = (ev: PageTransitionEvent) => {
    if (ev.persisted) this.report();
  };

  private report(): void {
    if (!this.detector || this.stopped) return;
    const snap = this.detector.getSnapshot();
    void this.post({
      v: PROTOCOL_VERSION,
      kind: 'state',
      platform: this.profile.platform,
      state: snap.state,
      confidence: Math.round(snap.confidence * 100) / 100,
      signals: snap.signals,
      seq: ++this.seq,
    }).then((reply) => {
      if (reply && !reply.active) this.stop();
    });
  }

  private async post(message: ContentMessage): Promise<ContentReply | null> {
    try {
      return parseReply(await this.transport.send(message));
    } catch {
      // Extension reloaded/updated or disabled: this script is orphaned.
      this.stop();
      return null;
    }
  }
}

/** Entry point used by the per-platform content bundles. */
export function runContentScript(profile: PlatformProfile): void {
  const g = globalThis as unknown as Record<symbol, ContentBridge | undefined>;
  if (g[GUARD]) return; // already injected into this page
  const bridge = new ContentBridge(profile, {
    send: (message) => browser.runtime.sendMessage(message),
  });
  g[GUARD] = bridge;
  const origStop = bridge.stop.bind(bridge);
  bridge.stop = () => {
    origStop();
    if (g[GUARD] === bridge) g[GUARD] = undefined; // allow re-injection later
  };
  void bridge.start();
}
