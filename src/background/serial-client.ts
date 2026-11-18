/**
 * Tiny Engineer client over Web Serial (USB CDC), an optional alternative to
 * the Wi-Fi HTTP client. Same RobotClient interface, same fixed set of
 * operations: `sync`, `health` and `anim` (name from the allowlist).
 *
 * The port must have been granted to the extension by the user via
 * `navigator.serial.requestPort()` on the options page; this client only
 * uses `getPorts()` and never prompts.
 *
 * Firefox support for Web Serial (and its availability in the background
 * context) is version dependent; when `navigator.serial` is missing the
 * client reports `unavailable`. See README "USB / Web Serial".
 */
import { isAnimation, type Animation } from '../shared/types';
import type { AnimInfo, AuthInfo, DeviceResult, HealthInfo, RobotClient } from './device-client';
import {
  CobsFrameDecoder,
  encodeRequest,
  ESPRESSIF_VID,
  parseMessage,
  SERIAL_BAUD_RATE,
  SerialMsgType,
  type SerialOp,
} from './serial-protocol';

/** The subset of the Web Serial API used here (also implemented by test fakes). */
export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

export interface SerialProvider {
  getPorts(): Promise<SerialPortLike[]>;
}

export interface SerialSelection {
  usbVendorId: number | null;
  usbProductId: number | null;
}

export interface SerialClientDeps {
  /** navigator.serial, or null when the API is not available. */
  provider: () => SerialProvider | null;
  selection: () => SerialSelection;
  timeoutMs: () => number;
}

/** Retry schedule for the first `sync` after opening (the chip may reboot on open). */
const SYNC_ATTEMPTS = [
  { waitMs: 0, timeoutMs: 400 },
  { waitMs: 250, timeoutMs: 700 },
  { waitMs: 600, timeoutMs: 1000 },
];

type Json = Record<string, unknown>;

interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class SerialError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'no-permission' | 'timeout' | 'network',
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pick the granted port that matches the saved USB ids (or the only/Espressif one). */
export function choosePort(ports: SerialPortLike[], sel: SerialSelection): SerialPortLike | null {
  if (sel.usbVendorId !== null) {
    // A device was chosen explicitly: never send frames to any other device.
    return (
      ports.find(
        (p) => p.getInfo().usbVendorId === sel.usbVendorId && (sel.usbProductId === null || p.getInfo().usbProductId === sel.usbProductId),
      ) ?? null
    );
  }
  if (ports.length === 1) return ports[0]!;
  return ports.find((p) => p.getInfo().usbVendorId === ESPRESSIF_VID) ?? null;
}

export class SerialClient implements RobotClient {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private opening: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly decoder = new CobsFrameDecoder((frame) => this.onFrame(frame));

  constructor(private readonly deps: SerialClientDeps) {}

  get isOpen(): boolean {
    return this.port !== null;
  }

  getAuth(): Promise<DeviceResult<AuthInfo>> {
    // No Bearer auth over serial; `sync` proves the link works.
    return this.run('sync', {}, () => ({ version: null, required: false }));
  }

  getHealth(): Promise<DeviceResult<HealthInfo>> {
    return this.run('health', {}, (j) => ({ version: typeof j.version === 'string' ? j.version.slice(0, 64) : null }));
  }

  /** The serial protocol has no read-only "current animation" op. */
  async getAnimation(): Promise<DeviceResult<AnimInfo>> {
    return { ok: true, status: 200, data: { animation: null } };
  }

  setAnimation(animation: Animation): Promise<DeviceResult<AnimInfo>> {
    if (!isAnimation(animation)) return Promise.resolve({ ok: false, error: 'invalid-target', message: 'Unknown animation.' });
    return this.run('anim', { name: animation }, (j) => ({ animation: typeof j.animation === 'string' ? j.animation.slice(0, 32) : null }));
  }

  async close(): Promise<void> {
    const port = this.port;
    const reader = this.reader;
    this.port = null;
    this.reader = null;
    this.failPending(new Error('serial port closed'));
    try {
      await reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      await port?.close();
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------------

  private run<T>(op: SerialOp, fields: Record<string, string>, pick: (json: Json) => T): Promise<DeviceResult<T>> {
    const task = async (): Promise<DeviceResult<T>> => {
      try {
        await this.ensureOpen();
        const res = await this.request(op, fields, this.deps.timeoutMs());
        return this.toResult(res, pick);
      } catch (err) {
        if (err instanceof SerialError) {
          if (err.kind === 'timeout' || err.kind === 'network') await this.close();
          return { ok: false, error: err.kind, message: err.message };
        }
        await this.close();
        return { ok: false, error: 'network', message: `Serial link failed (${err instanceof Error ? err.name : 'error'}).` };
      }
    };
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private toResult<T>(json: Json, pick: (json: Json) => T): DeviceResult<T> {
    const code = typeof json.code === 'number' ? json.code : json.ok === false ? 400 : 200;
    if (json.ok === false) {
      const detail = typeof json.error === 'string' ? json.error.slice(0, 80) : 'error';
      if (code === 503) return { ok: false, error: 'not-provisioned', status: 503, message: 'Robot is not provisioned yet. Finish the setup wizard first.' };
      return { ok: false, error: 'rejected', status: code, message: `Robot rejected the request (${code}: ${detail}).` };
    }
    return { ok: true, status: code, data: pick(json) };
  }

  private ensureOpen(): Promise<void> {
    if (this.port) return Promise.resolve();
    this.opening ??= this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(): Promise<void> {
    const provider = this.deps.provider();
    if (!provider) throw new SerialError('unavailable', 'Web Serial is not available in this Firefox (see README: USB / Web Serial).');
    const port = choosePort(await provider.getPorts(), this.deps.selection());
    if (!port) throw new SerialError('no-permission', 'No USB port has been granted yet. Open the settings and press “Choose USB device”.');
    try {
      await port.open({ baudRate: SERIAL_BAUD_RATE });
    } catch (err) {
      throw new SerialError('network', `Cannot open the USB port (${err instanceof Error ? err.name : 'error'}) — is another program (e.g. the tiny-engineer daemon) using it?`);
    }
    if (!port.readable || !port.writable) {
      await port.close().catch(() => undefined);
      throw new SerialError('network', 'USB port opened without streams.');
    }
    this.port = port;
    this.decoder.reset();
    this.reader = port.readable.getReader();
    void this.readLoop(port, this.reader);

    // Opening may reboot the ESP32-C3; wait for the protocol to answer.
    let lastError: unknown = null;
    for (const step of SYNC_ATTEMPTS) {
      if (step.waitMs) await sleep(step.waitMs);
      try {
        await this.request('sync', {}, step.timeoutMs);
        return;
      } catch (err) {
        lastError = err;
        if (!this.port) break;
      }
    }
    await this.close();
    throw lastError instanceof SerialError ? lastError : new SerialError('timeout', 'The USB device did not answer the Tiny Engineer protocol.');
  }

  private async readLoop(port: SerialPortLike, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.decoder.feed(value);
      }
    } catch {
      /* unplugged or cancelled */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
      if (this.port === port) {
        // Device disappeared: drop the session; the next request reopens.
        this.port = null;
        this.reader = null;
        this.failPending(new SerialError('network', 'USB device disconnected.'));
        await port.close().catch(() => undefined);
      }
    }
  }

  private async request(op: SerialOp, fields: Record<string, string>, timeoutMs: number): Promise<Json> {
    const port = this.port;
    if (!port?.writable) throw new SerialError('network', 'USB port is not open.');
    const id = this.nextId;
    this.nextId = this.nextId >= 0xffff ? 1 : this.nextId + 1;

    const response = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SerialError('timeout', `No answer from the robot over USB within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    const writer = port.writable.getWriter();
    try {
      await writer.write(encodeRequest(id, op, fields));
    } catch {
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
      }
      throw new SerialError('network', 'Writing to the USB port failed.');
    } finally {
      writer.releaseLock();
    }
    return response;
  }

  private onFrame(frame: Uint8Array): void {
    const msg = parseMessage(frame);
    if (!msg || (msg.type !== SerialMsgType.Res && msg.type !== SerialMsgType.Sync)) return; // logs/events ignored
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    try {
      const text = new TextDecoder().decode(msg.payload);
      const json: unknown = text ? JSON.parse(text) : {};
      p.resolve(typeof json === 'object' && json !== null ? (json as Json) : {});
    } catch {
      p.reject(new SerialError('network', 'Malformed response from the USB device.'));
    }
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** navigator.serial if this context exposes Web Serial. */
export function webSerialProvider(): SerialProvider | null {
  const nav = (globalThis as { navigator?: { serial?: SerialProvider } }).navigator;
  return nav?.serial && typeof nav.serial.getPorts === 'function' ? nav.serial : null;
}
