/**
 * Chrome only: the page that owns the USB (Web Serial) connection.
 *
 * Answers `usbRequest` messages from this extension's service worker with
 * the same three operations the Firefox build performs directly
 * (sync/health/anim). A Web Lock makes sure only one such tab is active.
 */
import { SerialClient, webSerialProvider } from '../background/serial-client';
import type { DeviceResult } from '../background/device-client';
import type { UsbPingReply, UsbRequest } from '../background/remote-serial-client';
import { cloneDefaultConfig, type Config } from '../shared/config';
import { loadConfig } from '../shared/storage';
import { isAnimation } from '../shared/types';
import { $, setText, toast } from '../shared/ui';

let config: Config = cloneDefaultConfig();
let active = false;
let myTabId: number | null = null;

const client = new SerialClient({
  provider: webSerialProvider,
  selection: () => ({ usbVendorId: config.device.usbVendorId, usbProductId: config.device.usbProductId }),
  timeoutMs: () => config.timing.requestTimeoutMs,
  unavailableMessage: 'This Chrome does not offer Web Serial on extension pages.',
});

const hex = (n: number | null) => (n === null ? '?' : `0x${n.toString(16).padStart(4, '0')}`);

function setStatus(text: string, tone: 'ok' | 'warn' | 'bad' | 'info'): void {
  const pill = $('#status');
  pill.dataset.tone = tone;
  pill.dataset.live = String(tone === 'ok');
  setText(pill, text);
}

function render(): void {
  setText($('#device'), config.device.usbVendorId === null ? 'none chosen yet' : `USB ${hex(config.device.usbVendorId)}:${hex(config.device.usbProductId)}`);
}

function isUsbRequest(m: unknown): m is UsbRequest {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  if (r.kind !== 'usbRequest' || r.v !== 1) return false;
  if (r.op === 'anim') return isAnimation(r.animation);
  return r.op === 'auth' || r.op === 'health' || r.op === 'anim-get';
}

async function perform(req: UsbRequest): Promise<DeviceResult<unknown>> {
  let res: DeviceResult<unknown>;
  switch (req.op) {
    case 'auth':
      res = await client.getAuth();
      break;
    case 'health':
      res = await client.getHealth();
      break;
    case 'anim-get':
      res = await client.getAnimation();
      break;
    case 'anim':
      res = await client.setAnimation(req.animation!);
      break;
  }
  const label = req.op === 'anim' ? `anim “${req.animation}”` : req.op;
  setText($('#last'), `${label} → ${res.ok ? 'ok' : res.error} · ${new Date().toLocaleTimeString()}`);
  setText($('#error'), res.ok ? '' : res.message);
  if (res.ok) setStatus('Connected', 'ok');
  else setStatus(res.error === 'no-permission' ? 'No device' : 'Error', res.error === 'no-permission' ? 'warn' : 'bad');
  return res;
}

browser.runtime.onMessage.addListener(((raw: unknown, sender: browser.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
  if (!active || sender.id !== browser.runtime.id) return false;
  const m = raw as { kind?: unknown };
  if (m?.kind === 'usbPing') {
    const reply: UsbPingReply = { tabId: myTabId, portOpen: client.isOpen, ports: 0 };
    const provider = webSerialProvider();
    if (!provider) {
      sendResponse(reply);
      return false;
    }
    provider.getPorts().then(
      (p) => sendResponse({ ...reply, ports: p.length }),
      () => sendResponse(reply),
    );
    return true;
  }
  // Device operations only from the service worker (not from pages or content scripts).
  if (sender.tab || sender.url !== browser.runtime.getURL('background.js')) return false;
  if (!isUsbRequest(raw)) return false;
  void perform(raw).then(sendResponse);
  return true;
}) as Parameters<typeof browser.runtime.onMessage.addListener>[0]);

$('#choose').addEventListener('click', () => {
  const serial = (navigator as unknown as { serial?: { requestPort(o?: object): Promise<{ getInfo(): { usbVendorId?: number; usbProductId?: number } }> } }).serial;
  if (!serial) return;
  void serial
    .requestPort({})
    .then(async (port) => {
      const info = port.getInfo();
      const c = await loadConfig();
      c.device.transport = 'serial';
      c.device.usbVendorId = info.usbVendorId ?? null;
      c.device.usbProductId = info.usbProductId ?? null;
      await browser.storage.local.set({ config: c });
      await client.close();
      toast('USB device saved');
    })
    .catch((err: unknown) => setText($('#error'), `No device selected (${err instanceof Error ? err.name : 'error'}).`));
});

$('#test').addEventListener('click', () => {
  void perform({ kind: 'usbRequest', v: 1, op: 'health' }).then((r) => toast(r.ok ? 'Robot answered over USB' : 'USB test failed'));
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('config' in changes)) return;
  void loadConfig().then(async (c) => {
    const deviceChanged = c.device.usbVendorId !== config.device.usbVendorId || c.device.usbProductId !== config.device.usbProductId;
    config = c;
    render();
    if (deviceChanged) await client.close();
  });
});

window.addEventListener('pagehide', () => void client.close());

async function init(): Promise<void> {
  config = await loadConfig();
  render();
  myTabId = (await browser.tabs.getCurrent())?.id ?? null;
  if (!webSerialProvider()) {
    setStatus('Unavailable', 'bad');
    setText($('#error'), 'This Chrome does not offer Web Serial on extension pages.');
    return;
  }
  const locks = (navigator as unknown as { locks?: { request(name: string, opts: object, cb: (lock: unknown) => Promise<void>): Promise<void> } }).locks;
  const activate = () => {
    active = true;
    setStatus('Ready', 'info');
  };
  if (!locks) {
    activate();
    return;
  }
  void locks.request('tiny-engineer-usb', { ifAvailable: true }, async (lock) => {
    if (!lock) {
      $('#duplicate').hidden = false;
      setStatus('Inactive', 'warn');
      return;
    }
    activate();
    await new Promise<void>(() => undefined); // hold the lock while this tab lives
  });
}

void init();
