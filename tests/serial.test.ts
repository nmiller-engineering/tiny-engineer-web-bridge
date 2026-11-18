import { describe, expect, it } from 'vitest';
import { choosePort, SerialClient } from '../src/background/serial-client';
import {
  cobsDecode,
  cobsEncodeFrame,
  CobsFrameDecoder,
  encodeRequest,
  packMessage,
  parseMessage,
  SerialMsgType,
} from '../src/background/serial-protocol';
import { FakeFirmwarePort, fakeProvider } from './helpers/fake-serial';

describe('COBS framing', () => {
  it('matches known vectors', () => {
    // Classic COBS examples (Cheshire & Baker), plus trailing delimiter.
    expect([...cobsEncodeFrame(Uint8Array.from([0x00]))]).toEqual([0x01, 0x01, 0x00]);
    expect([...cobsEncodeFrame(Uint8Array.from([0x00, 0x00]))]).toEqual([0x01, 0x01, 0x01, 0x00]);
    expect([...cobsEncodeFrame(Uint8Array.from([0x11, 0x22, 0x00, 0x33]))]).toEqual([0x03, 0x11, 0x22, 0x02, 0x33, 0x00]);
    expect([...cobsEncodeFrame(Uint8Array.from([0x11, 0x00, 0x00, 0x00]))]).toEqual([0x02, 0x11, 0x01, 0x01, 0x01, 0x00]);
  });

  it('round-trips arbitrary payloads, including 254+ byte runs', () => {
    for (const len of [0, 1, 253, 254, 255, 600, 2048]) {
      const data = Uint8Array.from({ length: len }, (_, i) => (i * 7) % 256);
      const frame = cobsEncodeFrame(data);
      expect(frame.at(-1)).toBe(0);
      expect(frame.subarray(0, -1).includes(0)).toBe(false);
      expect([...cobsDecode(frame.subarray(0, -1))!]).toEqual([...data]);
    }
  });

  it('decodes a stream incrementally and resyncs after garbage', () => {
    const got: number[][] = [];
    const dec = new CobsFrameDecoder((f) => got.push([...f]));
    const a = cobsEncodeFrame(Uint8Array.from([1, 0, 2]));
    const b = cobsEncodeFrame(Uint8Array.from([3]));
    const stream = Uint8Array.from([0x05, 0x01, 0x00, ...a, ...b]); // malformed frame first
    for (const byte of stream) dec.feed(Uint8Array.of(byte));
    expect(got).toEqual([[1, 0, 2], [3]]);
  });

  it('packs the 7-byte header like upstream', () => {
    const msg = packMessage(SerialMsgType.Req, 0x1234, new TextEncoder().encode('{}'));
    expect([...msg.subarray(0, 7)]).toEqual([1, 1, 0x34, 0x12, 0, 2, 0]);
    expect(parseMessage(msg)).toMatchObject({ type: 1, ver: 1, id: 0x1234, flags: 0 });
    expect(parseMessage(msg.subarray(0, 8))).toBeNull(); // truncated
  });

  it('encodes only the requested op and fields', () => {
    const frame = encodeRequest(7, 'anim', { name: 'ring' });
    const msg = parseMessage(cobsDecode(frame.subarray(0, -1))!)!;
    expect(JSON.parse(new TextDecoder().decode(msg.payload))).toEqual({ op: 'anim', name: 'ring' });
  });
});

describe('SerialClient (fake firmware)', () => {
  const make = (ports: FakeFirmwarePort[] | null, sel = { usbVendorId: null as number | null, usbProductId: null as number | null }) =>
    new SerialClient({ provider: () => (ports ? fakeProvider(ports) : null), selection: () => sel, timeoutMs: () => 300 });

  it('opens at 115200, syncs, and sends animations', async () => {
    const port = new FakeFirmwarePort();
    const client = make([port]);
    expect(await client.setAnimation('thinking')).toEqual({ ok: true, status: 200, data: { animation: 'thinking' } });
    expect(await client.getHealth()).toMatchObject({ ok: true, data: { version: 'v0.3.0-serial' } });
    expect(port.received.map((r) => r.op)).toEqual(['sync', 'anim', 'health']);
    expect(port.opens).toBe(1); // stays open between commands
    expect(port.animation).toBe('thinking');
    await client.close();
    expect(port.isOpen).toBe(false);
  });

  it('ignores log frames and garbage on the line', async () => {
    const port = new FakeFirmwarePort({ noisy: true });
    expect((await make([port]).setAnimation('ring')).ok).toBe(true);
  });

  it('retries sync while the chip reboots after open', async () => {
    const port = new FakeFirmwarePort({ dropFirst: 1 });
    expect((await make([port]).setAnimation('typing')).ok).toBe(true);
    expect(port.received.filter((r) => r.op === 'sync').length).toBe(2);
  });

  it('reports unavailable Web Serial, missing grant and busy ports', async () => {
    expect(await make(null).getHealth()).toMatchObject({ ok: false, error: 'unavailable' });
    expect(await make([]).getHealth()).toMatchObject({ ok: false, error: 'no-permission' });
    expect(await make([new FakeFirmwarePort({ failOpen: true })]).getHealth()).toMatchObject({ ok: false, error: 'network' });
  });

  it('times out when the device does not speak the protocol', async () => {
    const port = new FakeFirmwarePort({ silent: true });
    expect(await make([port]).getHealth()).toMatchObject({ ok: false, error: 'timeout' });
    expect(port.isOpen).toBe(false);
  });

  it('maps firmware errors (not provisioned)', async () => {
    expect(await make([new FakeFirmwarePort({ provisioned: false })]).setAnimation('ring')).toMatchObject({ ok: false, error: 'not-provisioned' });
  });

  it('recovers after the cable is unplugged and replugged', async () => {
    const port = new FakeFirmwarePort();
    const client = make([port]);
    expect((await client.setAnimation('typing')).ok).toBe(true);
    port.unplug();
    await new Promise((r) => setTimeout(r, 10));
    expect((await client.setAnimation('ring')).ok).toBe(true);
    expect(port.opens).toBe(2);
  });

  it('serializes concurrent requests', async () => {
    const port = new FakeFirmwarePort();
    const client = make([port]);
    const results = await Promise.all([client.setAnimation('thinking'), client.setAnimation('typing'), client.getHealth()]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(port.received.map((r) => r.name ?? r.op)).toEqual(['sync', 'thinking', 'typing', 'health']);
  });

  it('getAnimation needs no I/O (no serial op exists for it)', async () => {
    const port = new FakeFirmwarePort();
    expect(await make([port]).getAnimation()).toEqual({ ok: true, status: 200, data: { animation: null } });
    expect(port.received).toEqual([]);
  });

  it('chooses the saved device, else the only one, else an Espressif one', () => {
    const a = new FakeFirmwarePort({ usbVendorId: 0x1a86, usbProductId: 0x7523 });
    const b = new FakeFirmwarePort({ usbVendorId: 0x303a, usbProductId: 0x1001 });
    expect(choosePort([a, b], { usbVendorId: 0x1a86, usbProductId: 0x7523 })).toBe(a);
    expect(choosePort([a, b], { usbVendorId: null, usbProductId: null })).toBe(b);
    expect(choosePort([a], { usbVendorId: null, usbProductId: null })).toBe(a);
    expect(choosePort([a], { usbVendorId: 0x303a, usbProductId: null })).toBe(a); // fall back to the only port
    expect(choosePort([], { usbVendorId: null, usbProductId: null })).toBeNull();
  });
});
