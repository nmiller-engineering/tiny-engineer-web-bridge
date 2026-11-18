/**
 * In-memory Web Serial port that behaves like the Tiny Engineer firmware's
 * serial link (src/serial/link.cpp): answers sync/health/anim with framed
 * JSON responses.
 */
import {
  cobsEncodeFrame,
  CobsFrameDecoder,
  packMessage,
  parseMessage,
  SerialMsgType,
} from '../../src/background/serial-protocol';
import type { SerialPortLike, SerialProvider } from '../../src/background/serial-client';

export interface FakeFirmwareOptions {
  usbVendorId?: number;
  usbProductId?: number;
  provisioned?: boolean;
  /** Drop the first N requests (simulates the chip rebooting on open). */
  dropFirst?: number;
  /** Never answer. */
  silent?: boolean;
  /** Emit LOG frames and garbage bytes before each reply. */
  noisy?: boolean;
  failOpen?: boolean;
}

export class FakeFirmwarePort implements SerialPortLike {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  isOpen = false;
  opens = 0;
  animation = 'none';
  received: { op: string; name?: string }[] = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private dropped = 0;

  constructor(private readonly opts: FakeFirmwareOptions = {}) {}

  getInfo() {
    return { usbVendorId: this.opts.usbVendorId ?? 0x303a, usbProductId: this.opts.usbProductId ?? 0x1001 };
  }

  async open(options: { baudRate: number }): Promise<void> {
    if (this.opts.failOpen) throw new DOMException('busy', 'NetworkError');
    if (this.isOpen) throw new DOMException('already open', 'InvalidStateError');
    if (options.baudRate !== 115200) throw new Error('wrong baud rate');
    this.isOpen = true;
    this.opens++;
    const decoder = new CobsFrameDecoder((frame) => this.onRequest(frame));
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => void (this.controller = c) });
    this.writable = new WritableStream<Uint8Array>({ write: (chunk) => decoder.feed(chunk) });
  }

  async close(): Promise<void> {
    this.isOpen = false;
    try {
      this.controller?.close();
    } catch {
      /* already closed */
    }
    this.controller = null;
    this.readable = null;
    this.writable = null;
  }

  /** Simulate unplugging the cable. */
  unplug(): void {
    this.controller?.error(new DOMException('device lost', 'NetworkError'));
    this.isOpen = false;
    this.readable = null;
    this.writable = null;
  }

  private send(type: number, id: number, body: Record<string, unknown>): void {
    if (this.opts.noisy) {
      this.controller?.enqueue(cobsEncodeFrame(packMessage(SerialMsgType.Log, 0, new TextEncoder().encode('log line'))));
      this.controller?.enqueue(Uint8Array.from([0x13, 0x37, 0x00])); // garbage + delimiter
    }
    const frame = cobsEncodeFrame(packMessage(type, id, new TextEncoder().encode(JSON.stringify(body))));
    // Deliver in two chunks to exercise incremental decoding.
    const mid = Math.floor(frame.length / 2);
    this.controller?.enqueue(frame.subarray(0, mid));
    this.controller?.enqueue(frame.subarray(mid));
  }

  private onRequest(frame: Uint8Array): void {
    const msg = parseMessage(frame);
    if (!msg || msg.type !== SerialMsgType.Req) return;
    const req = JSON.parse(new TextDecoder().decode(msg.payload)) as { op: string; name?: string };
    this.received.push(req);
    if (this.opts.silent) return;
    if (this.dropped < (this.opts.dropFirst ?? 0)) {
      this.dropped++;
      return;
    }
    const provisioned = this.opts.provisioned ?? true;
    queueMicrotask(() => {
      if (req.op === 'sync' || req.op === 'ping') {
        this.send(SerialMsgType.Sync, msg.id, { proto: 1, provisioning: !provisioned, link_mode: 'usb' });
      } else if (!provisioned) {
        this.send(SerialMsgType.Res, msg.id, { ok: false, error: 'provisioning', code: 503 });
      } else if (req.op === 'health') {
        this.send(SerialMsgType.Res, msg.id, { version: 'v0.3.0-serial', uptime_ms: 1, ok: true, code: 200 });
      } else if (req.op === 'anim') {
        const valid = ['none', 'typing', 'reading', 'thinking', 'talking', 'ring', 'welcome', 'attention', 'error', 'abort', 'dead', 'wakeup', 'sleep'];
        if (!req.name || !valid.includes(req.name)) this.send(SerialMsgType.Res, msg.id, { ok: false, error: 'unknown animation', code: 400 });
        else {
          this.animation = req.name;
          this.send(SerialMsgType.Res, msg.id, { animation: req.name, ok: true, code: 200 });
        }
      } else {
        this.send(SerialMsgType.Res, msg.id, { ok: false, error: 'unknown op', code: 400 });
      }
    });
  }
}

export function fakeProvider(ports: SerialPortLike[]): SerialProvider {
  return { getPorts: async () => ports };
}
