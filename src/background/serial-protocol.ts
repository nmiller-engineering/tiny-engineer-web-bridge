/**
 * Tiny Engineer USB serial protocol (pure functions, no I/O).
 *
 * Ported from upstream docs/serial.md, packages/tiny-engineer-cli/src/robot/serial/
 * {cobs,protocol}.js and firmware src/serial/{frame,link,protocol}.cpp:
 *
 *   frame   = COBS(message) 0x00
 *   message = type:u8 ver:u8 id:u16le flags:u8 len:u16le payload[len]
 *   types   = 1 req, 2 res, 3 log, 4 evt, 5 stream, 6 sync
 *   payload = UTF-8 JSON; requests are {"op": "...", ...fields}
 *   responses carry {"ok": bool, "code": number, "error"?: string, ...}
 *
 * 115200 baud. Serial has no Bearer auth (physical access = authorization).
 */

export const SERIAL_BAUD_RATE = 115_200;
export const SERIAL_PROTO_VERSION = 1;
export const SERIAL_HEADER_SIZE = 7;
/** Firmware kSerialMaxPayload. */
export const SERIAL_MAX_PAYLOAD = 2048;
/** Espressif USB vendor id (ESP32-C3 USB-Serial-JTAG). */
export const ESPRESSIF_VID = 0x303a;

export const SerialMsgType = {
  Req: 1,
  Res: 2,
  Log: 3,
  Evt: 4,
  Stream: 5,
  Sync: 6,
} as const;

/** Only these ops are ever sent by the extension. */
export type SerialOp = 'sync' | 'health' | 'anim';

export interface SerialMessage {
  type: number;
  ver: number;
  id: number;
  flags: number;
  payload: Uint8Array;
}

/** COBS-encode and append the 0x00 delimiter. */
export function cobsEncodeFrame(payload: Uint8Array): Uint8Array {
  const out: number[] = [0];
  let codeIndex = 0;
  let code = 1;
  const finishBlock = () => {
    out[codeIndex] = code;
    codeIndex = out.length;
    out.push(0);
    code = 1;
  };
  for (const byte of payload) {
    if (byte === 0) {
      finishBlock();
    } else {
      out.push(byte);
      code++;
      if (code === 0xff) finishBlock();
    }
  }
  out[codeIndex] = code;
  out.push(0);
  return Uint8Array.from(out);
}

/** Decode one COBS frame (without its trailing delimiter). Null if malformed. */
export function cobsDecode(encoded: Uint8Array): Uint8Array | null {
  const out: number[] = [];
  let i = 0;
  while (i < encoded.length) {
    const code = encoded[i++]!;
    if (code === 0) return null;
    for (let j = 1; j < code; j++) {
      if (i >= encoded.length) return null;
      const byte = encoded[i++]!;
      if (byte === 0) return null;
      out.push(byte);
    }
    if (code < 0xff && i < encoded.length) out.push(0);
  }
  return Uint8Array.from(out);
}

/** Incremental decoder: feed raw bytes, receive decoded frames. Resyncs on the next 0x00 after garbage. */
export class CobsFrameDecoder {
  private buf: number[] = [];
  private overflow = false;
  private static readonly MAX_ENCODED = 1 + SERIAL_HEADER_SIZE + SERIAL_MAX_PAYLOAD + Math.ceil((SERIAL_HEADER_SIZE + SERIAL_MAX_PAYLOAD) / 254) + 1;

  constructor(private readonly onFrame: (payload: Uint8Array) => void) {}

  feed(data: Uint8Array): void {
    for (const byte of data) {
      if (byte === 0) {
        if (!this.overflow && this.buf.length > 0) {
          const decoded = cobsDecode(Uint8Array.from(this.buf));
          if (decoded) this.onFrame(decoded);
        }
        this.buf = [];
        this.overflow = false;
        continue;
      }
      if (this.overflow) continue;
      if (this.buf.length >= CobsFrameDecoder.MAX_ENCODED) {
        this.overflow = true;
        continue;
      }
      this.buf.push(byte);
    }
  }

  reset(): void {
    this.buf = [];
    this.overflow = false;
  }
}

export function packMessage(type: number, id: number, payload: Uint8Array, flags = 0): Uint8Array {
  if (payload.length > SERIAL_MAX_PAYLOAD) throw new Error('serial payload too large');
  const out = new Uint8Array(SERIAL_HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  out[0] = type;
  out[1] = SERIAL_PROTO_VERSION;
  view.setUint16(2, id & 0xffff, true);
  out[4] = flags;
  view.setUint16(5, payload.length, true);
  out.set(payload, SERIAL_HEADER_SIZE);
  return out;
}

export function parseMessage(data: Uint8Array): SerialMessage | null {
  if (data.length < SERIAL_HEADER_SIZE) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = view.getUint16(5, true);
  if (data.length < SERIAL_HEADER_SIZE + len) return null;
  return {
    type: data[0]!,
    ver: data[1]!,
    id: view.getUint16(2, true),
    flags: data[4]!,
    payload: data.subarray(SERIAL_HEADER_SIZE, SERIAL_HEADER_SIZE + len),
  };
}

/** Build a complete wire frame for a request. */
export function encodeRequest(id: number, op: SerialOp, fields: Record<string, string> = {}): Uint8Array {
  const json = JSON.stringify({ op, ...fields });
  return cobsEncodeFrame(packMessage(SerialMsgType.Req, id, new TextEncoder().encode(json)));
}
