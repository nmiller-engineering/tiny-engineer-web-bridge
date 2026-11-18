/**
 * Tiny Engineer HTTP client.
 *
 * The only code in the extension that performs network requests. It can
 * reach exactly four endpoints of the configured robot (see upstream
 * docs/api.md):
 *
 *   GET  /auth                  public; reports whether a token is required
 *   GET  /health                connection + firmware version
 *   GET  /anim                  current animation
 *   POST /anim?name=<animation> switch animation (name from a fixed allowlist)
 *
 * Callers cannot supply URLs, methods, headers or bodies. Requests are
 * serialized because the firmware's WebServer handles one request at a time.
 */
import { validateHost, validatePort, validateToken } from '../shared/config';
import { isAnimation, type Animation } from '../shared/types';

export interface DeviceTarget {
  host: string;
  port: number;
  token: string;
}

export type Endpoint = 'auth' | 'health' | 'anim-get' | 'anim-post';

export type DeviceErrorKind =
  | 'not-configured'
  | 'invalid-target'
  | 'no-permission'
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'unauthorized'
  | 'not-provisioned'
  | 'http'
  | 'bad-response'
  | 'unavailable'
  | 'rejected';

export type DeviceResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; error: DeviceErrorKind; status?: number; message: string };

export interface AuthInfo {
  version: string | null;
  required: boolean | null;
}
export interface HealthInfo {
  version: string | null;
}
export interface AnimInfo {
  animation: string | null;
}

/** Common interface of the Wi-Fi (HTTP) and USB (Web Serial) clients. */
export interface RobotClient {
  getAuth(): Promise<DeviceResult<AuthInfo>>;
  getHealth(): Promise<DeviceResult<HealthInfo>>;
  getAnimation(): Promise<DeviceResult<AnimInfo>>;
  setAnimation(animation: Animation): Promise<DeviceResult<AnimInfo>>;
  close?(): Promise<void>;
}

export interface RequestSpec {
  url: string;
  init: RequestInit;
}

const MAX_RESPONSE_BYTES = 16 * 1024;

/** Validate the target and return its base URL, or an error message. */
export function buildBaseUrl(target: DeviceTarget): { url: URL } | { error: string } {
  const hostErr = validateHost(target.host);
  if (hostErr) return { error: hostErr };
  const portErr = validatePort(target.port);
  if (portErr) return { error: portErr };
  const url = new URL(`http://${target.host}:${target.port}/`);
  // Defense in depth: URL parsing must not have smuggled anything in.
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return { error: 'Invalid robot address.' };
  }
  return { url };
}

/**
 * Build the exact request for an endpoint. Pure; exported for tests.
 * The token goes only into the Authorization header, never the URL.
 */
export function buildRequest(
  target: DeviceTarget,
  endpoint: Endpoint,
  animation?: Animation,
): RequestSpec | { error: string } {
  const base = buildBaseUrl(target);
  if ('error' in base) return base;
  const tokenErr = validateToken(target.token);
  if (tokenErr) return { error: tokenErr };

  const url = new URL(base.url);
  let method: 'GET' | 'POST' = 'GET';
  switch (endpoint) {
    case 'auth':
      url.pathname = '/auth';
      break;
    case 'health':
      url.pathname = '/health';
      break;
    case 'anim-get':
      url.pathname = '/anim';
      break;
    case 'anim-post':
      if (!isAnimation(animation)) return { error: 'Unknown animation.' };
      url.pathname = '/anim';
      url.searchParams.set('name', animation);
      method = 'POST';
      break;
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  // /auth is always public; never send the secret where it is not needed.
  if (target.token !== '' && endpoint !== 'auth') headers.Authorization = `Bearer ${target.token}`;

  return {
    url: url.toString(),
    init: {
      method,
      headers,
      // Do not follow redirects (the firmware redirects to its setup AP in
      // provisioning mode); surface them as an error instead.
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
    },
  };
}

export interface DeviceClientDeps {
  fetch: typeof fetch;
  getTarget: () => DeviceTarget | null;
  timeoutMs: () => number;
  /** Resolves true if the extension holds host permission for the robot. */
  hasPermission?: (target: DeviceTarget) => Promise<boolean>;
}

function readJsonField<T>(o: unknown, key: string, guard: (v: unknown) => v is T): T | null {
  if (typeof o !== 'object' || o === null) return null;
  const v = (o as Record<string, unknown>)[key];
  return guard(v) ? v : null;
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export class DeviceClient implements RobotClient {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DeviceClientDeps) {}

  getAuth(): Promise<DeviceResult<AuthInfo>> {
    return this.enqueue('auth', undefined, (j) => ({
      version: readJsonField(j, 'version', isString),
      required: readJsonField(j, 'required', isBool),
    }));
  }

  getHealth(): Promise<DeviceResult<HealthInfo>> {
    return this.enqueue('health', undefined, (j) => ({ version: readJsonField(j, 'version', isString) }));
  }

  getAnimation(): Promise<DeviceResult<AnimInfo>> {
    return this.enqueue('anim-get', undefined, (j) => ({ animation: readJsonField(j, 'animation', isString) }));
  }

  setAnimation(animation: Animation): Promise<DeviceResult<AnimInfo>> {
    return this.enqueue('anim-post', animation, (j) => ({ animation: readJsonField(j, 'animation', isString) }));
  }

  /** Run requests strictly one after another. */
  private enqueue<T>(endpoint: Endpoint, animation: Animation | undefined, pick: (json: unknown) => T): Promise<DeviceResult<T>> {
    const run = () => this.perform(endpoint, animation, pick);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async perform<T>(endpoint: Endpoint, animation: Animation | undefined, pick: (json: unknown) => T): Promise<DeviceResult<T>> {
    const target = this.deps.getTarget();
    if (!target || target.host === '') {
      return { ok: false, error: 'not-configured', message: 'Robot address is not configured.' };
    }
    const spec = buildRequest(target, endpoint, animation);
    if ('error' in spec) return { ok: false, error: 'invalid-target', message: spec.error };

    if (this.deps.hasPermission && !(await this.deps.hasPermission(target))) {
      return {
        ok: false,
        error: 'no-permission',
        message: 'Firefox has not granted access to the robot address yet. Open the settings and press “Save & allow access”.',
      };
    }

    const controller = new AbortController();
    const timeout = this.deps.timeoutMs();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await this.deps.fetch(spec.url, { ...spec.init, signal: controller.signal });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        return { ok: false, error: 'redirect', status: res.status, message: 'Robot answered with a redirect (is it in setup/provisioning mode?).' };
      }
      const text = await readLimited(res);
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      if (res.status === 401) {
        return { ok: false, error: 'unauthorized', status: 401, message: 'Robot rejected the access token (401). Check the token in settings.' };
      }
      if (res.status === 503) {
        return { ok: false, error: 'not-provisioned', status: 503, message: 'Robot is not provisioned yet (503). Finish the setup wizard first.' };
      }
      if (!res.ok) {
        const detail = readJsonField(json, 'error', isString);
        return { ok: false, error: 'http', status: res.status, message: `Robot returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 80)}` : ''}.` };
      }
      if (json === null || typeof json !== 'object') {
        return { ok: false, error: 'bad-response', status: res.status, message: 'Robot response was not JSON — is this really a Tiny Engineer?' };
      }
      return { ok: true, status: res.status, data: pick(json) };
    } catch (err) {
      if (controller.signal.aborted) {
        return { ok: false, error: 'timeout', message: `No answer from the robot within ${timeout} ms.` };
      }
      return { ok: false, error: 'network', message: `Cannot reach the robot (${err instanceof Error ? err.name : 'network error'}).` };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readLimited(res: Response): Promise<string> {
  const text = await res.text();
  return text.length > MAX_RESPONSE_BYTES ? '' : text;
}
