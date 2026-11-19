/**
 * Chrome only: USB via the "USB connection" extension page.
 *
 * Chrome's extension service worker has no Web Serial API (verified in
 * Chromium 153), but extension pages do. The worker therefore forwards the
 * same fixed operations (sync/health/anim) to src/usb/usb.ts, which owns the
 * port. Only operation names and an allowlisted animation are sent; answers
 * are validated like any other device response.
 */
import { isAnimation, type Animation } from '../shared/types';
import type { AnimInfo, AuthInfo, DeviceErrorKind, DeviceResult, HealthInfo, RobotClient } from './device-client';

export type UsbOp = 'auth' | 'health' | 'anim-get' | 'anim';

export interface UsbRequest {
  kind: 'usbRequest';
  v: 1;
  op: UsbOp;
  animation?: Animation;
}

export interface UsbPing {
  kind: 'usbPing';
  v: 1;
}

export interface UsbPingReply {
  tabId: number | null;
  portOpen: boolean;
  ports: number;
}

const ERROR_KINDS: ReadonlySet<DeviceErrorKind> = new Set([
  'not-configured',
  'invalid-target',
  'no-permission',
  'timeout',
  'network',
  'redirect',
  'unauthorized',
  'not-provisioned',
  'http',
  'bad-response',
  'unavailable',
  'rejected',
]);

export const USB_TAB_MISSING =
  'The USB connection tab is not open. Open Settings → Robot connection → USB and press “Open USB tab” (Chrome needs an open tab to use USB).';

/** Extra time on top of the request timeout: opening the port waits for the robot to sync. */
const OPEN_ALLOWANCE_MS = 4000;

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** Validate a DeviceResult coming back from the USB page. Exported for tests. */
export function parseUsbResult<T>(raw: unknown, pick: (data: Record<string, unknown>) => T): DeviceResult<T> {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'unavailable', message: USB_TAB_MISSING };
  const r = raw as Record<string, unknown>;
  if (r.ok === true && typeof r.status === 'number' && typeof r.data === 'object' && r.data !== null) {
    return { ok: true, status: r.status, data: pick(r.data as Record<string, unknown>) };
  }
  if (r.ok === false && typeof r.error === 'string' && ERROR_KINDS.has(r.error as DeviceErrorKind)) {
    return {
      ok: false,
      error: r.error as DeviceErrorKind,
      status: typeof r.status === 'number' ? r.status : undefined,
      message: str(r.message, 300) ?? 'USB error',
    };
  }
  return { ok: false, error: 'bad-response', message: 'Unexpected answer from the USB connection tab.' };
}

export class RemoteSerialClient implements RobotClient {
  constructor(
    private readonly deps: {
      send: (message: UsbRequest) => Promise<unknown>;
      timeoutMs: () => number;
    },
  ) {}

  getAuth(): Promise<DeviceResult<AuthInfo>> {
    return this.call('auth', undefined, (d) => ({ version: str(d.version, 64), required: typeof d.required === 'boolean' ? d.required : null }));
  }

  getHealth(): Promise<DeviceResult<HealthInfo>> {
    return this.call('health', undefined, (d) => ({ version: str(d.version, 64) }));
  }

  getAnimation(): Promise<DeviceResult<AnimInfo>> {
    return this.call('anim-get', undefined, (d) => ({ animation: str(d.animation, 32) }));
  }

  setAnimation(animation: Animation): Promise<DeviceResult<AnimInfo>> {
    if (!isAnimation(animation)) return Promise.resolve({ ok: false, error: 'invalid-target', message: 'Unknown animation.' });
    return this.call('anim', animation, (d) => ({ animation: str(d.animation, 32) }));
  }

  private async call<T>(op: UsbOp, animation: Animation | undefined, pick: (d: Record<string, unknown>) => T): Promise<DeviceResult<T>> {
    const message: UsbRequest = animation ? { kind: 'usbRequest', v: 1, op, animation } : { kind: 'usbRequest', v: 1, op };
    const timeout = this.deps.timeoutMs() + OPEN_ALLOWANCE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        this.deps.send(message),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('usb-timeout')), timeout);
        }),
      ]);
      return parseUsbResult(raw, pick);
    } catch (err) {
      const text = err instanceof Error ? err.message : '';
      if (text === 'usb-timeout') return { ok: false, error: 'timeout', message: `No answer from the USB connection tab within ${timeout} ms.` };
      // "Could not establish connection. Receiving end does not exist." → no USB tab.
      return { ok: false, error: 'unavailable', message: USB_TAB_MISSING };
    } finally {
      clearTimeout(timer);
    }
  }
}
