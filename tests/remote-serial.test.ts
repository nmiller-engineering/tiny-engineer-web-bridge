import { describe, expect, it } from 'vitest';
import { parseUsbResult, RemoteSerialClient, USB_TAB_MISSING, type UsbRequest } from '../src/background/remote-serial-client';

describe('RemoteSerialClient (Chrome: USB via the USB page)', () => {
  it('forwards only fixed operations and allowlisted animations', async () => {
    const sent: UsbRequest[] = [];
    const client = new RemoteSerialClient({
      send: async (m) => (sent.push(m), { ok: true, status: 200, data: { animation: 'ring', version: 'v1', extra: 'x' } }),
      timeoutMs: () => 100,
    });
    expect(await client.setAnimation('ring')).toEqual({ ok: true, status: 200, data: { animation: 'ring' } });
    expect(await client.getHealth()).toEqual({ ok: true, status: 200, data: { version: 'v1' } });
    // @ts-expect-error runtime guard
    expect((await client.setAnimation('ring&x')).ok).toBe(false);
    expect(sent).toEqual([
      { kind: 'usbRequest', v: 1, op: 'anim', animation: 'ring' },
      { kind: 'usbRequest', v: 1, op: 'health' },
    ]);
  });

  it('explains a missing USB tab', async () => {
    const client = new RemoteSerialClient({
      send: async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      timeoutMs: () => 100,
    });
    expect(await client.getAuth()).toEqual({ ok: false, error: 'unavailable', message: USB_TAB_MISSING });
    const silent = new RemoteSerialClient({ send: async () => undefined, timeoutMs: () => 100 });
    expect((await silent.getAuth()).ok).toBe(false);
  });

  it('times out when the USB tab hangs', async () => {
    const client = new RemoteSerialClient({ send: () => new Promise(() => undefined), timeoutMs: () => 10 });
    const res = await client.getHealth();
    expect(res).toMatchObject({ ok: false, error: 'timeout' });
  }, 10_000);

  it('validates answers from the page', () => {
    const pick = (d: Record<string, unknown>) => d;
    expect(parseUsbResult({ ok: false, error: 'no-permission', message: 'x'.repeat(999) }, pick)).toMatchObject({ ok: false, error: 'no-permission' });
    expect((parseUsbResult({ ok: false, error: 'no-permission', message: 'x'.repeat(999) }, pick) as { message: string }).message).toHaveLength(300);
    expect(parseUsbResult({ ok: false, error: 'rm -rf', message: 'x' }, pick)).toMatchObject({ error: 'bad-response' });
    expect(parseUsbResult({ ok: true, status: '200', data: {} }, pick)).toMatchObject({ error: 'bad-response' });
    expect(parseUsbResult('nope', pick)).toMatchObject({ error: 'unavailable' });
  });
});
