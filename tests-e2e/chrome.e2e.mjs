#!/usr/bin/env node
/**
 * End-to-end test of the Chrome build in a real Chromium.
 *
 *   npm run test:e2e
 *
 * Starts the mock Tiny Engineer and a local "Open WebUI" (the synthetic
 * fixtures) on 127.0.0.1, loads dist-chrome/ into Chromium and checks the
 * whole chain: settings UI → service worker → HTTP to the robot, and
 * content-script detection in a real page → state machine → robot commands.
 * Also checks that USB requests reach the USB connection page.
 *
 * The test copy of the extension additionally gets host access to
 * http://127.0.0.1/* — granting optional permissions needs a click in a
 * browser prompt, which automation cannot do.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createMockRobot } from '../tools/mock-tiny-engineer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', 'fixtures', 'openwebui');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function waitFor(fn, timeoutMs, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(stepMs);
  }
}

function fixtureServer() {
  const server = http.createServer(async (req, res) => {
    const name = req.url?.startsWith('/fixture/') ? req.url.slice('/fixture/'.length) : 'idle';
    try {
      const html = await readFile(path.join(fixtures, `${name.replace(/[^\w-]/g, '')}.html`), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.url?.startsWith('/fixture/') ? html : `<!doctype html><html><head><title>Open WebUI</title><style>#chat-input{min-height:2em;min-width:20em;border:1px solid #888}</style></head><body>${html}</body></html>`);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function main() {
  const extDir = await mkdtemp(path.join(tmpdir(), 'te-ext-'));
  await cp(path.join(root, 'dist-chrome'), extDir, { recursive: true });
  const manifestPath = path.join(extDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const robot = createMockRobot({ quiet: true });
  const robotPort = await robot.listen(0);
  const site = await fixtureServer();
  const origin = `http://127.0.0.1:${site.port}`;

  const ctx = await chromium.launchPersistentContext('', {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const id = sw.url().split('/')[2];
    check('service worker starts', Boolean(id), sw.url());

    // --- Settings: configure through extension storage (as the options page does) ---
    const options = await ctx.newPage();
    const pageErrors = [];
    options.on('pageerror', (e) => pageErrors.push(String(e)));
    await options.goto(`chrome-extension://${id}/options/index.html`);
    await options.evaluate(
      async ({ robotPort, origin }) => {
        const { config = {} } = await browser.storage.local.get('config');
        await browser.storage.local.set({
          config: {
            ...config,
            device: { transport: 'http', usbVendorId: null, usbProductId: null, host: '127.0.0.1', port: robotPort, token: '', autoReconnect: true },
            platforms: { chatgpt: true, claude: true, openwebui: true, openwebuiOrigin: origin },
            timing: { debounceMs: 150, minStableMs: 150, completionMs: 2000, requestTimeoutMs: 2000, staleMs: 30000, keepaliveMs: 60000, typingIdleMs: 4000 },
          },
        });
      },
      { robotPort, origin },
    );
    await options.reload();

    // --- UI: Test connection button ---
    await options.click('#test-connection');
    const pill = await waitFor(async () => {
      const t = await options.textContent('#connection');
      return t?.includes('Connected') ? t : null;
    }, 8000);
    check('settings: "Test connection" reaches the robot over HTTP', Boolean(pill), pill ?? (await options.textContent('#connection-detail')) ?? '');
    const fw = await waitFor(async () => ((await options.textContent('#firmware'))?.includes('mock') ? await options.textContent('#firmware') : null), 5000);
    check('settings: firmware version shown', Boolean(fw), fw ?? (await options.textContent('#firmware')) ?? '');
    // Saving a new robot address puts it at rest once (`none`); the test itself must not move it.
    const early = robot.animPosts().map((p) => p.name);
    check('connection test causes no robot motion (only the rest pose)', early.every((n) => n === 'none'), early.join(', ') || 'no commands');

    // --- Detection in a real page ---
    const posts = () => robot.animPosts().map((p) => p.name);
    const chat = await ctx.newPage();
    await chat.goto(`${origin}/c/1`);
    const status = () => options.evaluate(() => browser.runtime.sendMessage({ kind: 'getStatus' }));
    const seen = await waitFor(async () => (await status()).tabs.find((t) => t.platform === 'openwebui'), 8000);
    check('content script injected and reporting', Boolean(seen), seen ? `${seen.state}, signals: ${seen.signals.join(',')}` : 'no tab');

    const morph = (name) =>
      chat.evaluate(async (n) => {
        const html = await (await fetch(`/fixture/${n}`)).text();
        document.body.innerHTML = html;
      }, name);

    // Real keystrokes: typing, then Enter → thinking before any answer element exists.
    await chat.click('#chat-input');
    await chat.keyboard.type('Hello robot');
    const sentAt = Date.now();
    await chat.keyboard.press('Enter');
    await waitFor(() => posts().includes('thinking'), 3000, 25);
    const latency = Date.now() - sentAt;
    check('Enter → robot "thinking" within 1 s (before any answer exists)', posts().includes('thinking') && latency < 1000, `${latency} ms`);

    await morph('thinking');
    await sleep(500);
    check('answer starts → still "thinking", no duplicate command', posts().filter((n) => n === 'thinking').length === 1, posts().join(' → '));

    await morph('streaming');
    for (let i = 0; i < 20; i++) {
      await chat.evaluate(() => {
        const all = document.querySelectorAll('[id^="c-"][id$="-content"]');
        all[all.length - 1].append(document.createTextNode(' token'));
      });
      await sleep(150);
    }
    await waitFor(() => posts().includes('typing'), 6000);
    check('streaming → robot "typing"', posts().includes('typing'), posts().join(' → '));

    await morph('completed');
    await waitFor(() => posts().includes('ring'), 8000);
    check('completed → robot "ring"', posts().includes('ring'), posts().join(' → '));
    const order = ['thinking', 'typing', 'ring'].map((n) => posts().indexOf(n));
    check('commands in the right order', order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), posts().join(' → '));

    await sleep(3000);
    const after = posts();
    check('no "none" sent after the one-shot ring', after[after.length - 1] === 'ring', after.join(' → '));

    // --- Toolbar icon: OFF badge, one-click mode, shortcut ---
    const setCfg = (patch) =>
      options.evaluate(async (p) => {
        const { config } = await browser.storage.local.get('config');
        await browser.storage.local.set({ config: { ...config, ...p } });
      }, patch);
    await setCfg({ enabled: false });
    const off = await waitFor(async () => ((await options.evaluate(() => browser.action.getBadgeText({}))) === 'OFF' ? 'OFF' : null), 3000);
    check('bridge off → "OFF" badge on the toolbar icon', off === 'OFF');
    await setCfg({ enabled: true, toolbarClick: 'toggle' });
    const popupOff = await waitFor(async () => ((await options.evaluate(() => browser.action.getPopup({}))) === '' ? 'none' : null), 3000);
    const badgeOn = await options.evaluate(() => browser.action.getBadgeText({}));
    check('one-click mode disables the popup; badge cleared when on', popupOff === 'none' && badgeOn === '', `popup=${popupOff} badge="${badgeOn}"`);
    await setCfg({ toolbarClick: 'popup' });
    const popupBack = await waitFor(async () => ((await options.evaluate(() => browser.action.getPopup({}))).endsWith('popup/index.html') ? 'popup' : null), 3000);
    check('popup mode restores the popup', popupBack === 'popup');
    const cmd = await options.evaluate(async () => (await browser.commands.getAll()).find((c) => c.name === 'toggle-bridge'));
    check('keyboard shortcut command registered', Boolean(cmd), cmd ? `shortcut: ${cmd.shortcut || '(unassigned in headless)'}` : 'missing');

    // --- Popup renders live state ---
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${id}/popup/index.html`);
    const popupConn = await waitFor(async () => {
      const t = await popup.textContent('#connection');
      return t?.includes('Connected') ? t : null;
    }, 5000);
    check('popup shows "Connected"', Boolean(popupConn), (await popup.textContent('#connection')) ?? '');

    // --- USB: requests are routed to the USB connection page ---
    await options.evaluate(async () => {
      const { config } = await browser.storage.local.get('config');
      config.device.transport = 'serial';
      await browser.storage.local.set({ config });
    });
    await sleep(300);
    const noTab = await options.evaluate(() => browser.runtime.sendMessage({ kind: 'testConnection' }));
    check('USB without the USB tab explains what to do', !noTab.ok && /USB connection tab is not open/.test(noTab.message), noTab.message);

    const usb = await ctx.newPage();
    await usb.goto(`chrome-extension://${id}/usb/index.html`);
    const ready = await waitFor(async () => ((await usb.textContent('#status')) === 'Ready' ? 'Ready' : null), 5000);
    check('USB tab starts and has Web Serial', Boolean(ready), (await usb.textContent('#status')) ?? '');
    const viaTab = await options.evaluate(() => browser.runtime.sendMessage({ kind: 'testConnection' }));
    check('USB request answered by the USB tab (no device granted)', !viaTab.ok && /No USB port has been granted/.test(viaTab.message), viaTab.message);

    const usb2 = await ctx.newPage();
    await usb2.goto(`chrome-extension://${id}/usb/index.html`);
    const dup = await waitFor(async () => !(await usb2.isHidden('#duplicate')), 3000);
    check('a second USB tab stays inactive', Boolean(dup));

    check('no errors on extension pages', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await ctx.close();
    await robot.close();
    site.server.close();
    await rm(extDir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll end-to-end checks passed.' : `\n${failures} end-to-end check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
