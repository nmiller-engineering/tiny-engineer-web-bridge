/**
 * Background orchestration, independent of browser APIs so it can be tested
 * end-to-end against a mocked Tiny Engineer HTTP server.
 */
import { isDeviceConfigured, type Config } from '../shared/config';
import type {
  AnimationTestResult,
  ConnectionState,
  ConnectionTestResult,
  ContentMessage,
  ContentReply,
  StatusSnapshot,
  TabStatus,
} from '../shared/messaging';
import { ANIMATION_KIND, isAIState, isAnimation, isPlatform, isSignalName, type Animation, type Platform } from '../shared/types';
import { CommandQueue, type SendOutcome } from './command-queue';
import { DeviceClient, type DeviceErrorKind, type DeviceTarget, type RobotClient } from './device-client';
import { SerialClient, type SerialProvider } from './serial-client';
import type { DebugLog } from './logger';
import { StateManager, type StateManagerSnapshot } from './state-manager';
import { effectiveState, TabRegistry, type RegistrySnapshot } from './tab-manager';

export interface BridgeDeps {
  fetch: typeof fetch;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  hasDevicePermission?: (target: DeviceTarget) => Promise<boolean>;
  /** Web Serial provider (navigator.serial) — null/absent when unavailable. */
  serialProvider?: () => SerialProvider | null;
  /** Called (debounced by the caller if desired) whenever state worth persisting changes. */
  onChange?: () => void;
  log?: DebugLog;
}

interface StatusState {
  connection: ConnectionState;
  connectionDetail: string;
  firmwareVersion: string | null;
  authRequired: boolean | null;
  robotAnimation: string | null;
  lastSent: StatusSnapshot['lastSent'];
  lastCommand: StatusSnapshot['lastCommand'];
  lastError: StatusSnapshot['lastError'];
}

export interface BridgeSnapshot {
  registry: RegistrySnapshot;
  state: StateManagerSnapshot;
  queue: { believed: Animation | null; believedAt: number };
  status: StatusState;
}

const TEST_ANIMATION_RESUME_MS = 6000;

function connectionFor(kind: DeviceErrorKind): ConnectionState {
  switch (kind) {
    case 'timeout':
    case 'network':
      return 'disconnected';
    case 'no-permission':
      return 'no-permission';
    case 'not-configured':
    case 'invalid-target':
      return 'unconfigured';
    case 'unavailable':
      return 'error';
    default:
      return 'error';
  }
}

const TRANSIENT: ReadonlySet<DeviceErrorKind> = new Set(['timeout', 'network', 'not-provisioned', 'http']);

export class Bridge {
  readonly registry = new TabRegistry();
  readonly queue: CommandQueue;
  readonly state: StateManager;
  private readonly httpClient: DeviceClient;
  private readonly serialClient: SerialClient;
  private config: Config;
  private status: StatusState = {
    connection: 'unknown',
    connectionDetail: '',
    firmwareVersion: null,
    authRequired: null,
    robotAnimation: null,
    lastSent: null,
    lastCommand: null,
    lastError: null,
  };
  private resumeTimer: unknown = null;
  private lastRefreshAt = Number.NEGATIVE_INFINITY;

  constructor(
    config: Config,
    private readonly deps: BridgeDeps,
  ) {
    this.config = config;
    if (!isDeviceConfigured(config)) this.status.connection = 'unconfigured';

    this.serialClient = new SerialClient({
      provider: () => deps.serialProvider?.() ?? null,
      selection: () => ({ usbVendorId: this.config.device.usbVendorId, usbProductId: this.config.device.usbProductId }),
      timeoutMs: () => this.config.timing.requestTimeoutMs,
    });

    this.httpClient = new DeviceClient({
      fetch: deps.fetch,
      getTarget: () => (isDeviceConfigured(this.config) ? this.target() : null),
      timeoutMs: () => this.config.timing.requestTimeoutMs,
      hasPermission: deps.hasDevicePermission,
    });

    this.queue = new CommandQueue({
      send: (a) => this.sendAnimation(a),
      now: deps.now,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      minIntervalMs: () => 1000, // matches the firmware's 1 s minimum hold
      shouldRetry: (a) => this.config.device.autoReconnect && (ANIMATION_KIND[a] === 'idle' || ANIMATION_KIND[a] === 'continuous'),
    });

    this.state = new StateManager({
      registry: this.registry,
      queue: this.queue,
      getConfig: () => this.config,
      now: deps.now,
      setTimer: deps.setTimer,
      clearTimer: deps.clearTimer,
      log: (m) => this.log(m),
      onCommit: () => deps.onChange?.(),
    });
  }

  /** The client for the configured transport. */
  get client(): RobotClient {
    return this.config.device.transport === 'serial' ? this.serialClient : this.httpClient;
  }

  private log(message: string): void {
    this.deps.log?.log(message);
  }

  private target(): DeviceTarget {
    return { host: this.config.device.host, port: this.config.device.port, token: this.config.device.token };
  }

  get currentConfig(): Config {
    return this.config;
  }

  /** Apply a new configuration. */
  setConfig(next: Config): void {
    const prev = this.config;
    this.config = next;
    const deviceChanged =
      prev.device.transport !== next.device.transport ||
      prev.device.usbVendorId !== next.device.usbVendorId ||
      prev.device.usbProductId !== next.device.usbProductId ||
      prev.device.host !== next.device.host ||
      prev.device.port !== next.device.port ||
      prev.device.token !== next.device.token;
    if (deviceChanged) {
      // Release the USB port when switching away from it or to another device.
      void this.serialClient.close();
      this.queue.invalidate();
      this.queue.resetBackoff();
      this.status = {
        ...this.status,
        connection: isDeviceConfigured(next) ? 'unknown' : 'unconfigured',
        connectionDetail: '',
        firmwareVersion: null,
        authRequired: null,
        robotAnimation: null,
      };
    }
    for (const p of ['chatgpt', 'claude', 'openwebui'] as const) {
      if (!next.platforms[p] || (p === 'openwebui' && prev.platforms.openwebuiOrigin !== next.platforms.openwebuiOrigin)) {
        this.registry.removePlatform(p);
      }
    }
    if (deviceChanged || JSON.stringify(prev.mapping) !== JSON.stringify(next.mapping) || prev.enabled !== next.enabled) {
      this.state.invalidate();
    }
    this.state.evaluate();
    this.deps.onChange?.();
  }

  isPlatformActive(platform: Platform): boolean {
    return this.config.enabled && this.config.platforms[platform];
  }

  contentReply(active: boolean): ContentReply {
    const t = this.config.timing;
    return {
      active,
      debounceMs: t.debounceMs,
      typingIdleMs: t.typingIdleMs,
      completionMs: t.completionMs,
      heartbeatMs: Math.max(2000, Math.min(10_000, Math.floor(t.staleMs / 3))),
    };
  }

  /**
   * Handle an already-validated content message. `originOk` must be computed
   * by the caller from the sender's URL (not from the message).
   */
  handleContent(msg: ContentMessage, tabId: number, originOk: boolean): ContentReply {
    const active = originOk && this.isPlatformActive(msg.platform);
    const now = this.deps.now();
    if (!active) {
      if (this.registry.get(tabId)?.platform === msg.platform && this.registry.remove(tabId)) this.state.evaluate();
      return this.contentReply(false);
    }
    if (msg.kind === 'hello') {
      this.registry.hello(tabId, msg.platform, now);
      this.log(`tab ${tabId}: ${msg.platform} detector started`);
    } else {
      const prev = this.registry.get(tabId)?.state;
      const accepted = this.registry.report(tabId, msg, now);
      if (accepted && prev !== msg.state) this.log(`tab ${tabId}: ${msg.platform} ${prev ?? '∅'} → ${msg.state} (${msg.confidence})`);
    }
    this.state.evaluate();
    this.deps.onChange?.();
    return this.contentReply(true);
  }

  tabRemoved(tabId: number): void {
    if (this.registry.remove(tabId)) {
      this.log(`tab ${tabId}: closed/navigated away`);
      this.state.evaluate();
      this.deps.onChange?.();
    }
  }

  tabActivated(tabId: number): void {
    this.registry.focus(tabId);
    this.state.evaluate();
    this.deps.onChange?.();
  }

  /** Called by watchdog alarms and after restarts. */
  tick(): void {
    this.state.evaluate();
  }

  /** Whether the watchdog alarm should keep running. */
  needsWatchdog(): boolean {
    const now = this.deps.now();
    if (this.registry.hasActiveTabs(now, this.config.timing)) return true;
    const c = this.queue.current;
    if (c !== null && ANIMATION_KIND[c] === 'continuous') return true;
    return this.config.device.autoReconnect && this.status.connection === 'disconnected' && isDeviceConfigured(this.config);
  }

  private async sendAnimation(animation: Animation): Promise<SendOutcome> {
    const res = await this.client.setAnimation(animation);
    const at = this.deps.now();
    if (res.ok) {
      this.status.connection = 'connected';
      this.status.connectionDetail = '';
      this.status.robotAnimation = res.data.animation;
      const via = this.config.device.transport === 'serial' ? 'USB' : 'HTTP';
      this.status.lastCommand = { animation, ok: true, at, detail: `${via} ${res.status}` };
      const committed = this.state.committedState;
      this.status.lastSent = { animation, state: committed && isAIState(committed) ? committed : null, at };
      this.log(`anim ${animation} → ${res.status} (${this.config.device.transport})`);
      this.deps.onChange?.();
      return { ok: true, message: 'ok' };
    }
    this.status.connection = connectionFor(res.error);
    this.status.connectionDetail = res.message;
    this.status.lastCommand = { animation, ok: false, at, detail: res.error };
    this.status.lastError = { message: res.message, at };
    this.log(`anim ${animation} failed: ${res.error} (${this.config.device.transport})`);
    this.deps.onChange?.();
    return { ok: false, message: res.message, retryable: TRANSIENT.has(res.error) };
  }

  /** Full connection test: /auth (public) → /health → /anim. */
  async testConnection(): Promise<ConnectionTestResult> {
    const fail = (connection: ConnectionState, message: string): ConnectionTestResult => {
      this.status.connection = connection;
      this.status.connectionDetail = message;
      this.status.lastError = { message, at: this.deps.now() };
      this.deps.onChange?.();
      return { ok: false, connection, message, firmwareVersion: this.status.firmwareVersion, authRequired: this.status.authRequired, robotAnimation: null };
    };

    const auth = await this.client.getAuth();
    if (!auth.ok) return fail(connectionFor(auth.error), auth.message);
    this.status.authRequired = auth.data.required;
    this.status.firmwareVersion = auth.data.version;
    if (this.config.device.transport === 'http' && auth.data.required === true && this.config.device.token === '') {
      return fail('error', 'The robot requires an access token. Enter it in the connection settings.');
    }

    const health = await this.client.getHealth();
    if (!health.ok) return fail(connectionFor(health.error), health.message);
    this.status.firmwareVersion = health.data.version ?? this.status.firmwareVersion;

    const anim = await this.client.getAnimation();
    if (!anim.ok) return fail(connectionFor(anim.error), anim.message);
    this.status.robotAnimation = anim.data.animation;
    this.status.connection = 'connected';
    this.status.connectionDetail = '';
    if (anim.data.animation !== null && isAnimation(anim.data.animation)) this.queue.restore({ believed: anim.data.animation, believedAt: this.deps.now() });
    this.queue.resetBackoff();
    this.state.invalidate();
    this.state.evaluate();
    this.deps.onChange?.();
    const v = this.status.firmwareVersion ? ` (firmware ${this.status.firmwareVersion})` : '';
    const via = this.config.device.transport === 'serial' ? ' over USB' : '';
    return {
      ok: true,
      connection: 'connected',
      message: `Connected to Tiny Engineer${via}${v}.`,
      firmwareVersion: this.status.firmwareVersion,
      authRequired: this.status.authRequired,
      robotAnimation: this.status.robotAnimation,
    };
  }

  /** Lightweight reconnect probe (no motion). */
  async probe(): Promise<void> {
    if (!isDeviceConfigured(this.config)) return;
    const res = await this.client.getHealth();
    if (res.ok) {
      const wasDown = this.status.connection !== 'connected';
      this.status.connection = 'connected';
      this.status.connectionDetail = '';
      this.status.firmwareVersion = res.data.version ?? this.status.firmwareVersion;
      if (wasDown) {
        this.log('robot reachable again');
        this.queue.invalidate();
        this.queue.resetBackoff();
        this.state.invalidate();
        this.state.evaluate();
      }
    } else {
      this.status.connection = connectionFor(res.error);
      this.status.connectionDetail = res.message;
    }
    this.deps.onChange?.();
  }

  /** Play an animation on request from the settings UI, then resume normal control. */
  testAnimation(animation: Animation): AnimationTestResult {
    if (!isDeviceConfigured(this.config)) return { ok: false, message: 'Configure the robot address first.' };
    this.queue.request(animation, { force: true });
    if (this.resumeTimer !== null) this.deps.clearTimer(this.resumeTimer);
    this.resumeTimer = this.deps.setTimer(() => {
      this.resumeTimer = null;
      this.state.invalidate();
      this.state.evaluate();
    }, TEST_ANIMATION_RESUME_MS);
    return { ok: true, message: `Sent “${animation}”. Normal control resumes in a few seconds.` };
  }

  getStatus(): StatusSnapshot {
    const now = this.deps.now();
    const sel = this.state.selection;
    const tabs: TabStatus[] = this.registry.all().map((r) => ({
      tabId: r.tabId,
      platform: r.platform,
      state: r.state,
      effectiveState: effectiveState(r, now, this.config.timing),
      confidence: r.confidence,
      signals: [...r.signals],
      ageMs: now - r.lastSeen,
    }));
    return {
      enabled: this.config.enabled,
      connection: isDeviceConfigured(this.config) ? this.status.connection : 'unconfigured',
      connectionDetail: this.status.connectionDetail,
      firmwareVersion: this.status.firmwareVersion,
      authRequired: this.status.authRequired,
      robotAnimation: this.status.robotAnimation,
      lastSent: this.status.lastSent,
      lastCommand: this.status.lastCommand,
      lastError: this.status.lastError,
      controller: sel ? { tabId: sel.tabId, platform: sel.platform, state: sel.state, confidence: sel.confidence } : null,
      arbitration: this.config.arbitration,
      tabs,
    };
  }

  /** Refresh the robot's reported animation for the UI (GET /anim, no motion). */
  async refreshRobotAnimation(minIntervalMs = 3000): Promise<void> {
    // Serial has no read-only animation query; status comes from command replies.
    if (!isDeviceConfigured(this.config) || this.config.device.transport === 'serial') return;
    // Read-only, but still throttled: the popup polls while it is open.
    const now = this.deps.now();
    if (now - this.lastRefreshAt < minIntervalMs) return;
    this.lastRefreshAt = now;
    const res = await this.client.getAnimation();
    if (res.ok) {
      this.status.robotAnimation = res.data.animation;
      this.status.connection = 'connected';
      this.status.connectionDetail = '';
    } else {
      this.status.connection = connectionFor(res.error);
      this.status.connectionDetail = res.message;
    }
  }

  snapshot(): BridgeSnapshot {
    return { registry: this.registry.snapshot(), state: this.state.snapshot(), queue: this.queue.snapshot(), status: { ...this.status } };
  }

  restore(raw: BridgeSnapshot): void {
    const snap = sanitizeSnapshot(raw);
    this.registry.restore(snap.registry);
    this.state.restore(snap.state);
    this.queue.restore(snap.queue);
    this.status = { ...this.status, ...snap.status };
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Keep only well-formed tab records from restored session data. */
export function sanitizeSnapshot(snap: BridgeSnapshot): BridgeSnapshot {
  const records = snap.registry.records
    .filter(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        Number.isSafeInteger(r.tabId) &&
        isPlatform(r.platform) &&
        isAIState(r.state) &&
        isNum(r.confidence) &&
        isNum(r.stateSince) &&
        isNum(r.lastSeen) &&
        isNum(r.seq) &&
        Array.isArray(r.signals),
    )
    .map((r) => ({ ...r, signals: r.signals.filter(isSignalName) }));
  const focusOrder = snap.registry.focusOrder.filter((id) => Number.isSafeInteger(id)).slice(0, 64);
  const believed = isAnimation(snap.queue.believed) ? snap.queue.believed : null;
  return {
    ...snap,
    registry: { records, focusOrder },
    queue: { believed, believedAt: isNum(snap.queue.believedAt) ? snap.queue.believedAt : 0 },
  };
}

/** Defensive check for data read back from storage.session. */
export function isBridgeSnapshot(v: unknown): v is BridgeSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  const reg = s.registry as Record<string, unknown> | undefined;
  return (
    typeof reg === 'object' &&
    reg !== null &&
    Array.isArray(reg.records) &&
    Array.isArray(reg.focusOrder) &&
    typeof s.state === 'object' &&
    s.state !== null &&
    typeof s.queue === 'object' &&
    s.queue !== null &&
    typeof s.status === 'object' &&
    s.status !== null
  );
}

