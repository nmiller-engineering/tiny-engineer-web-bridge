/**
 * Configuration model, defaults and validation.
 *
 * Pure functions only: no browser APIs. Content scripts never import this
 * module (enforced by tests/architecture.test.ts), so the robot address and
 * token are never part of a content-script bundle.
 */
import {
  AI_STATES,
  DISABLED,
  isAnimation,
  type AIState,
  type AnimationMapping,
  type ArbitrationMode,
  type MappingTarget,
} from './types';

export type Transport = 'http' | 'serial';

export interface DeviceConfig {
  /** How to reach the robot: Wi-Fi (HTTP) or USB (Web Serial). */
  transport: Transport;
  /** USB ids of the granted serial port (Web Serial); null = any granted port. */
  usbVendorId: number | null;
  usbProductId: number | null;
  /** IPv4 address or DNS hostname, without scheme/port/path. Empty = not configured. */
  host: string;
  port: number;
  /** Optional Bearer token. Empty = no auth. */
  token: string;
  /** Periodically re-check the robot after a failure. */
  autoReconnect: boolean;
}

export interface PlatformConfig {
  chatgpt: boolean;
  claude: boolean;
  openwebui: boolean;
  /** Exact origin of a self-hosted Open WebUI instance, e.g. http://192.168.1.20:3000. */
  openwebuiOrigin: string;
}

export interface TimingConfig {
  /** Content-side: a detected state must persist this long before it is reported. */
  debounceMs: number;
  /** Background-side: the arbitrated state must persist this long before a command is sent. */
  minStableMs: number;
  /** How long `completed` is shown before falling back to idle. */
  completionMs: number;
  /** HTTP timeout for each robot request. */
  requestTimeoutMs: number;
  /** A busy tab that has not reported for this long is treated as `unknown`. */
  staleMs: number;
  /** Re-post a continuous animation this often so the firmware's continuous_timeout does not fire mid-response. 0 = off. */
  keepaliveMs: number;
  /** User-typing state ends after this much keyboard inactivity. */
  typingIdleMs: number;
}

export interface Config {
  enabled: boolean;
  device: DeviceConfig;
  platforms: PlatformConfig;
  mapping: AnimationMapping;
  timing: TimingConfig;
  arbitration: ArbitrationMode;
  debugLogging: boolean;
}

/**
 * Default state → animation mapping.
 *
 * Deviation from the suggested table: `user_typing` defaults to
 * "disabled" instead of `attention`. Upstream `attention` plays a ~3 s voice
 * clip ("psst… human…") followed by a one-minute waiting loop, which would
 * fire every time the user starts typing. It can still be selected.
 */
export const DEFAULT_MAPPING: AnimationMapping = {
  idle: 'none',
  user_typing: DISABLED,
  thinking: 'thinking',
  responding: 'typing',
  tool_use: 'reading',
  completed: 'ring',
  error: 'error',
  unknown: 'none',
};

export const DEFAULT_TIMING: TimingConfig = {
  debounceMs: 300,
  minStableMs: 500,
  completionMs: 2000,
  requestTimeoutMs: 2000,
  staleMs: 30_000,
  keepaliveMs: 60_000,
  typingIdleMs: 4000,
};

/** Inclusive bounds for every timing value (ms). */
export const TIMING_BOUNDS: Record<keyof TimingConfig, readonly [number, number]> = {
  debounceMs: [0, 5000],
  minStableMs: [0, 10_000],
  completionMs: [500, 30_000],
  requestTimeoutMs: [500, 10_000],
  staleMs: [5000, 600_000],
  keepaliveMs: [0, 600_000],
  typingIdleMs: [1000, 60_000],
};

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  device: { transport: 'http', usbVendorId: null, usbProductId: null, host: '', port: 80, token: '', autoReconnect: true },
  platforms: { chatgpt: true, claude: true, openwebui: false, openwebuiOrigin: '' },
  mapping: { ...DEFAULT_MAPPING },
  timing: { ...DEFAULT_TIMING },
  arbitration: 'active-tab',
  debugLogging: false,
};

export function cloneDefaultConfig(): Config {
  return structuredClone(DEFAULT_CONFIG);
}

// ---------------------------------------------------------------------------
// Field validators. Each returns an error message, or null when valid.
// ---------------------------------------------------------------------------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;

/** Validate a robot host: IPv4 or DNS hostname, nothing else. */
export function validateHost(host: string): string | null {
  if (host.length === 0) return 'Enter the robot IP address or hostname.';
  if (host.length > 253) return 'Hostname is too long.';
  if (/[\s/?#@:\\[\]%]/.test(host)) {
    return 'Enter only an IPv4 address or hostname (no scheme, port, path, credentials or IPv6).';
  }
  const ipv4 = IPV4.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return 'Invalid IPv4 address.';
    const [a] = octets as [number, number, number, number];
    if (a === 0) return 'Address 0.x.x.x is not a valid destination.';
    if (a >= 224) return 'Multicast/broadcast/reserved addresses are not allowed.';
    return null;
  }
  // Purely numeric labels that are not a valid dotted quad (e.g. "1.2.3") are ambiguous.
  if (/^[\d.]+$/.test(host)) return 'Invalid IPv4 address.';
  const labels = host.replace(/\.$/, '').split('.');
  if (labels.some((l) => !HOST_LABEL.test(l))) return 'Invalid hostname.';
  return null;
}

export function validatePort(port: number): string | null {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'Port must be 1–65535.';
  return null;
}

/**
 * Tokens are sent as an HTTP header value, so only visible ASCII is allowed.
 * This also rules out header injection via CR/LF.
 */
export function validateToken(token: string): string | null {
  if (token.length > 512) return 'Token is too long.';
  if (!/^[\x21-\x7e]*$/.test(token)) return 'Token may only contain visible ASCII characters (no spaces).';
  return null;
}

export const RESERVED_ORIGINS = new Set(['https://chatgpt.com', 'https://claude.ai']);

/**
 * Validate and normalize the Open WebUI origin. Returns the canonical
 * origin (scheme://host[:port]) or an error.
 */
export function normalizeOrigin(input: string): { origin: string } | { error: string } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { error: 'Enter the Open WebUI address, e.g. http://192.168.1.20:3000' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: 'Not a valid URL. Include the scheme, e.g. http://192.168.1.20:3000' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Only http:// and https:// are supported.' };
  if (url.username || url.password) return { error: 'URLs with embedded credentials are not allowed.' };
  if (url.hash || url.search) return { error: 'Enter only the origin (no query or fragment).' };
  if (url.pathname !== '/' && url.pathname !== '') return { error: 'Enter only the origin (no path).' };
  if (url.hostname.startsWith('[')) return { error: 'IPv6 literals are not supported; use a hostname.' };
  if (RESERVED_ORIGINS.has(url.origin)) return { error: 'That origin is already supported natively.' };
  return { origin: url.origin };
}

/**
 * Host match pattern for an origin. WebExtension match patterns cannot
 * contain a port, so the pattern covers all ports of the host; the exact
 * origin (including port) is re-checked at runtime.
 */
export function originToMatchPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

/** Host permission pattern for the robot. */
export function deviceMatchPattern(host: string): string {
  return `http://${host.replace(/\.$/, '').toLowerCase()}/*`;
}

// ---------------------------------------------------------------------------
// Whole-config sanitizer: tolerates partial/old/corrupt stored data.
// ---------------------------------------------------------------------------

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clampInt(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function usbId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff ? value : null;
}

export function sanitizeMappingTarget(value: unknown, fallback: MappingTarget): MappingTarget {
  if (value === DISABLED || isAnimation(value)) return value;
  return fallback;
}

/**
 * Turn arbitrary stored data into a valid Config. Invalid fields fall back
 * to defaults; an invalid robot host/token/origin is cleared rather than kept.
 */
export function sanitizeConfig(raw: unknown): Config {
  const input = obj(raw);
  const d = DEFAULT_CONFIG;

  const dev = obj(input.device);
  const host = typeof dev.host === 'string' ? dev.host.trim().toLowerCase() : '';
  const token = typeof dev.token === 'string' ? dev.token : '';
  const port = typeof dev.port === 'number' && validatePort(dev.port) === null ? dev.port : d.device.port;

  const plat = obj(input.platforms);
  let openwebuiOrigin = '';
  if (typeof plat.openwebuiOrigin === 'string' && plat.openwebuiOrigin !== '') {
    const n = normalizeOrigin(plat.openwebuiOrigin);
    if ('origin' in n) openwebuiOrigin = n.origin;
  }

  const map = obj(input.mapping);
  const mapping = {} as AnimationMapping;
  for (const state of AI_STATES) {
    mapping[state] = sanitizeMappingTarget(map[state], d.mapping[state]);
  }

  const tim = obj(input.timing);
  const timing = {} as TimingConfig;
  for (const key of Object.keys(DEFAULT_TIMING) as (keyof TimingConfig)[]) {
    timing[key] = clampInt(tim[key], TIMING_BOUNDS[key], d.timing[key]);
  }

  return {
    enabled: bool(input.enabled, d.enabled),
    device: {
      transport: dev.transport === 'serial' ? 'serial' : 'http',
      usbVendorId: usbId(dev.usbVendorId),
      usbProductId: usbId(dev.usbProductId),
      host: host !== '' && validateHost(host) === null ? host : '',
      port,
      token: validateToken(token) === null ? token : '',
      autoReconnect: bool(dev.autoReconnect, d.device.autoReconnect),
    },
    platforms: {
      chatgpt: bool(plat.chatgpt, d.platforms.chatgpt),
      claude: bool(plat.claude, d.platforms.claude),
      openwebui: bool(plat.openwebui, d.platforms.openwebui) && openwebuiOrigin !== '',
      openwebuiOrigin,
    },
    mapping,
    timing,
    arbitration: input.arbitration === 'activity-priority' ? 'activity-priority' : 'active-tab',
    debugLogging: bool(input.debugLogging, d.debugLogging),
  };
}

/** Wi-Fi needs a host; USB needs nothing up front (the granted port is checked at runtime). */
export function isDeviceConfigured(config: Config): boolean {
  return config.device.transport === 'serial' || config.device.host !== '';
}

/** Map a state to its configured animation (or DISABLED). */
export function animationFor(mapping: AnimationMapping, state: AIState): MappingTarget {
  return mapping[state];
}
