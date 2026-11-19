import {
  cloneDefaultConfig,
  DEFAULT_MAPPING,
  DEFAULT_TIMING,
  deviceMatchPattern,
  normalizeOrigin,
  originToMatchPattern,
  sanitizeMappingTarget,
  TIMING_BOUNDS,
  validateHost,
  validatePort,
  validateToken,
  type Config,
  type TimingConfig,
} from '../shared/config';
import type { AnimationTestResult, ConnectionTestResult, StatusSnapshot } from '../shared/messaging';
import { loadConfig, saveConfig } from '../shared/storage';
import { TARGET } from '../shared/target';
import { AI_STATES, ANIMATIONS, DISABLED, isAnimation, type Platform } from '../shared/types';
import { $, $input, CONNECTION_LABELS, connectionTone, formatAgo, platformLabel, sendToBackground, setText, STATE_LABELS, toast } from '../shared/ui';

const POLL_MS = 1500;
let config: Config = cloneDefaultConfig();

async function update(mutate: (c: Config) => void, message = 'Saved'): Promise<void> {
  const next = structuredClone(config);
  mutate(next);
  config = await saveConfig(next);
  if (message) toast(message);
}

async function withBusy<T>(button: HTMLButtonElement, task: () => Promise<T>): Promise<T> {
  button.disabled = true;
  button.classList.add('busy');
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
  }
}

// --------------------------------------------------------------- connection

interface WebSerialLike {
  requestPort(options?: { filters?: { usbVendorId: number }[] }): Promise<{ getInfo(): { usbVendorId?: number; usbProductId?: number } }>;
  getPorts?(): Promise<unknown[]>;
}

/** USB diagnostics: what this page and the background can see. Shown under the USB section. */
async function renderSerialDiagnostics(): Promise<void> {
  const browserVersion = /(Firefox|Chrome)\/([\d.]+)/.exec(navigator.userAgent)?.slice(1).join(' ') ?? 'unknown';
  const page = webSerial();
  let pagePorts = '–';
  try {
    if (page?.getPorts) pagePorts = String((await page.getPorts()).length);
  } catch (err) {
    pagePorts = err instanceof Error ? err.name : 'error';
  }
  let bg: string;
  let usbTab = false;
  try {
    const info = await sendToBackground<{ available: boolean; ports: number; error: string; usbTab?: boolean }>({ kind: 'getSerialInfo' });
    usbTab = info.usbTab === true;
    if (TARGET === 'chrome') bg = usbTab ? `USB tab open, ${info.ports} granted port(s)` : 'USB tab not open';
    else bg = info.available ? `available, ${info.ports} granted port(s)${info.error ? ` (${info.error})` : ''}` : 'NOT available';
  } catch {
    bg = 'not reachable';
  }
  if (TARGET === 'chrome') $('#open-usb-tab').textContent = usbTab ? 'Show USB tab' : 'Open USB tab';
  setText(
    $('#serial-diag'),
    `Diagnostics — ${browserVersion} · Web Serial on this page: ${page ? `yes, ${pagePorts} granted port(s)` : 'no'} · ${TARGET === 'chrome' ? 'connection' : 'in the background'}: ${bg}`,
  );
}

function webSerial(): WebSerialLike | null {
  const s = (navigator as unknown as { serial?: WebSerialLike }).serial;
  return s && typeof s.requestPort === 'function' ? s : null;
}

const hex = (n: number | null) => (n === null ? '?' : `0x${n.toString(16).padStart(4, '0')}`);

/** Chrome: make sure the USB connection tab exists (and show it). */
async function ensureUsbTab(focus: boolean): Promise<void> {
  let tabId: number | null;
  try {
    const ping = (await browser.runtime.sendMessage({ kind: 'usbPing', v: 1 })) as { tabId: number | null } | undefined;
    tabId = ping?.tabId ?? null;
  } catch {
    tabId = null;
  }
  if (tabId !== null) {
    if (focus) await browser.tabs.update(tabId, { active: true });
    return;
  }
  await browser.tabs.create({ url: browser.runtime.getURL('usb/index.html'), pinned: true, active: focus });
  await new Promise((resolve) => setTimeout(resolve, 800)); // let it take the USB lock
}

$('#open-usb-tab').addEventListener('click', () => void ensureUsbTab(true).then(renderSerialDiagnostics));

function fillTransport(): void {
  const firefox = TARGET === 'firefox';
  // Firefox cannot do USB for extensions; keep the option only to switch back from an old setting.
  const usbRadio = document.querySelector<HTMLInputElement>('input[name="transport"][value="serial"]')!;
  usbRadio.disabled = firefox && config.device.transport !== 'serial';
  $('#usb-option').title = firefox ? 'Not available in Firefox' : '';
  $('#usb-firefox').hidden = !firefox;
  $('#open-usb-tab').hidden = firefox;
  $('#usb-tab-hint').hidden = firefox;
  const serial = config.device.transport === 'serial';
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="transport"]')) radio.checked = radio.value === config.device.transport;
  $('#serial-section').hidden = !serial;
  $('#device-form').hidden = serial;
  $('#serial-unavailable').hidden = webSerial() !== null;
  ($('#choose-serial') as HTMLButtonElement).disabled = webSerial() === null;
  setText(
    $('#serial-device'),
    config.device.usbVendorId === null ? 'none chosen yet' : `USB ${hex(config.device.usbVendorId)}:${hex(config.device.usbProductId)}`,
  );
  if (serial) void renderSerialDiagnostics();
}

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="transport"]')) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    void update((c) => (c.device.transport = radio.value === 'serial' ? 'serial' : 'http'), radio.value === 'serial' ? 'Using USB' : 'Using Wi-Fi').then(fillTransport);
  });
}

$('#choose-serial').addEventListener('click', () => {
  const serial = webSerial();
  if (!serial) return;
  const filters = $input('#serial-all').checked ? undefined : [{ usbVendorId: 0x303a }]; // Espressif
  // requestPort must be called directly in the user gesture.
  const asked = performance.now();
  void serial
    .requestPort(filters ? { filters } : {})
    .then(async (port) => {
      const info = port.getInfo();
      await update((c) => {
        c.device.transport = 'serial';
        c.device.usbVendorId = info.usbVendorId ?? null;
        c.device.usbProductId = info.usbProductId ?? null;
      }, 'USB device saved');
      setText($('#serial-error'), '');
      fillTransport();
      if (TARGET === 'chrome') await ensureUsbTab(false);
      await runConnectionTest();
    })
    .catch((err: unknown) => {
      const name = err instanceof Error ? err.name : 'Error';
      const detail = err instanceof Error && err.message ? `${name}: ${err.message}` : name;
      // A picker the user closed takes a while; an instant rejection means Firefox never showed one.
      const instant = performance.now() - asked < 400;
      let hint: string;
      if (name === 'NotFoundError' && instant && TARGET === 'firefox') {
        hint = 'Firefox does not allow extensions to use USB serial ports. Please use Wi-Fi.';
      } else if (name === 'NotFoundError' && instant) {
        hint = 'The browser returned no device without showing a picker. Try “Show all serial devices”.';
      } else if (name === 'NotFoundError') {
        hint = 'No device was selected. If the list was empty, tick “Show all serial devices” and try again.';
      } else {
        hint = 'The browser refused the request.';
      }
      setText($('#serial-error'), `${hint} [${detail}]`);
      void renderSerialDiagnostics();
    });
});

function fillDevice(): void {
  fillTransport();
  $input('#host').value = config.device.host;
  $input('#port').value = String(config.device.port);
  $input('#token').value = config.device.token;
  $input('#auto-reconnect').checked = config.device.autoReconnect;
}

$('#toggle-token').addEventListener('click', () => {
  const input = $input('#token');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  setText($('#toggle-token'), show ? 'Hide' : 'Show');
  $('#toggle-token').setAttribute('aria-pressed', String(show));
});

for (const id of ['#host', '#port', '#token']) {
  $input(id).addEventListener('input', () => {
    $input(id).removeAttribute('aria-invalid');
    setText($('#device-error'), '');
  });
}

$('#device-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const host = $input('#host').value.trim().toLowerCase();
  const port = Number($input('#port').value);
  const token = $input('#token').value;
  const hostErr = validateHost(host);
  const portErr = validatePort(port);
  const tokenErr = validateToken(token);
  for (const [id, e] of [['#host', hostErr], ['#port', portErr], ['#token', tokenErr]] as const) {
    if (e) $input(id).setAttribute('aria-invalid', 'true');
    else $input(id).removeAttribute('aria-invalid');
  }
  const err = hostErr ?? portErr ?? tokenErr;
  setText($('#device-error'), err ?? '');
  if (err) return;

  const oldPattern = config.device.host ? deviceMatchPattern(config.device.host) : null;
  const pattern = deviceMatchPattern(host);
  // permissions.request must be the first await inside the user gesture.
  void browser.permissions.request({ origins: [pattern] }).then(async (granted) => {
    await update((c) => {
      c.device = { ...c.device, transport: 'http', host, port, token, autoReconnect: $input('#auto-reconnect').checked };
    }, 'Connection saved');
    fillDevice();
    if (oldPattern && oldPattern !== pattern && !isPatternInUse(oldPattern)) {
      await browser.permissions.remove({ origins: [oldPattern] }).catch(() => undefined);
    }
    if (!granted) {
      setText($('#device-error'), 'Saved, but the browser did not grant access to the robot. Press the button again and choose “Allow”.');
      return;
    }
    setText($('#device-error'), '');
    await runConnectionTest();
  });
});

function isPatternInUse(pattern: string): boolean {
  return config.platforms.openwebuiOrigin !== '' && originToMatchPattern(config.platforms.openwebuiOrigin) === pattern;
}

$input('#auto-reconnect').addEventListener('change', (ev) => {
  void update((c) => {
    c.device.autoReconnect = (ev.target as HTMLInputElement).checked;
  });
});

async function runConnectionTest(): Promise<void> {
  const button = $(config.device.transport === 'serial' ? '#test-serial' : '#test-connection') as HTMLButtonElement;
  await withBusy(button, async () => {
    const res = await sendToBackground<ConnectionTestResult>({ kind: 'testConnection' });
    setText($('#connection-detail'), res.message);
    toast(res.ok ? 'Robot connected' : 'Connection failed');
  });
  void refreshStatus();
}
$('#test-connection').addEventListener('click', () => void runConnectionTest());
$('#test-serial').addEventListener('click', () => void runConnectionTest());

// ---------------------------------------------------------------- platforms

const REQUIRED_ORIGINS: Record<'chatgpt' | 'claude', string> = {
  chatgpt: 'https://chatgpt.com/*',
  claude: 'https://claude.ai/*',
};

async function renderPermission(platform: Platform): Promise<void> {
  const el = $(`#perm-${platform}`);
  el.replaceChildren();
  let pattern: string | null = null;
  if (platform === 'openwebui') {
    pattern = config.platforms.openwebuiOrigin ? originToMatchPattern(config.platforms.openwebuiOrigin) : null;
  } else {
    pattern = REQUIRED_ORIGINS[platform];
  }
  if (!pattern || !config.platforms[platform]) return;
  const granted = await browser.permissions.contains({ origins: [pattern] });
  const tag = document.createElement('span');
  tag.className = `tag ${granted ? 'ok' : 'bad'}`;
  tag.textContent = granted ? 'Access granted' : 'No site access';
  el.append(tag);
  if (granted) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn secondary sm';
  btn.textContent = 'Grant';
  btn.addEventListener('click', () => {
    void browser.permissions.request({ origins: [pattern] }).then(() => renderPermissions());
  });
  el.append(btn);
}

function renderPermissions(): Promise<void> {
  return Promise.all((['chatgpt', 'claude', 'openwebui'] as const).map(renderPermission)).then(() => undefined);
}

function fillPlatforms(): void {
  $input('#pf-chatgpt').checked = config.platforms.chatgpt;
  $input('#pf-claude').checked = config.platforms.claude;
  $input('#pf-openwebui').checked = config.platforms.openwebui;
  $input('#openwebui-origin').value = config.platforms.openwebuiOrigin;
  void renderPermissions();
}

for (const p of ['chatgpt', 'claude'] as const) {
  $input(`#pf-${p}`).addEventListener('change', (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    const pattern = REQUIRED_ORIGINS[p];
    // Request site access in the same gesture if it was revoked.
    const ask = on ? browser.permissions.request({ origins: [pattern] }).catch(() => false) : Promise.resolve(true);
    void ask.then(async () => {
      await update((c) => {
        c.platforms[p] = on;
      }, `${platformLabel(p)} ${on ? 'on' : 'off'}`);
      await renderPermissions();
    });
  });
}

function saveOpenWebUI(enable: boolean): void {
  const result = normalizeOrigin($input('#openwebui-origin').value);
  if ('error' in result) {
    setText($('#openwebui-error'), result.error);
    if (!enable) void update((c) => (c.platforms.openwebui = false)).then(fillPlatforms);
    else $input('#pf-openwebui').checked = config.platforms.openwebui;
    return;
  }
  setText($('#openwebui-error'), '');
  const pattern = originToMatchPattern(result.origin);
  const oldOrigin = config.platforms.openwebuiOrigin;
  const ask = enable ? browser.permissions.request({ origins: [pattern] }) : Promise.resolve(true);
  void ask.then(async (granted) => {
    await update((c) => {
      c.platforms.openwebuiOrigin = result.origin;
      c.platforms.openwebui = enable && granted;
    });
    if (oldOrigin && oldOrigin !== result.origin) {
      const oldPattern = originToMatchPattern(oldOrigin);
      const robotPattern = config.device.host ? deviceMatchPattern(config.device.host) : null;
      if (oldPattern !== pattern && oldPattern !== robotPattern) {
        await browser.permissions.remove({ origins: [oldPattern] }).catch(() => undefined);
      }
    }
    if (enable && !granted) setText($('#openwebui-error'), 'The browser did not grant access to this address. Press “Save & allow access” and choose “Allow”.');
    fillPlatforms();
  });
}

$('#save-openwebui').addEventListener('click', () => saveOpenWebUI(true));
$input('#pf-openwebui').addEventListener('change', (ev) => {
  const on = (ev.target as HTMLInputElement).checked;
  if (on) {
    saveOpenWebUI(true);
    return;
  }
  void update((c) => (c.platforms.openwebui = false)).then(async () => {
    // Least privilege: give back site access that is no longer needed.
    if (config.platforms.openwebuiOrigin) {
      const pattern = originToMatchPattern(config.platforms.openwebuiOrigin);
      const robotPattern = config.device.host ? deviceMatchPattern(config.device.host) : null;
      if (pattern !== robotPattern) await browser.permissions.remove({ origins: [pattern] }).catch(() => undefined);
    }
    fillPlatforms();
  });
});

// ------------------------------------------------------------------ mapping

const STATE_HINTS: Record<string, string> = {
  idle: 'Nothing is happening',
  user_typing: 'You are writing a prompt',
  thinking: 'Request sent, no answer visible yet',
  responding: 'The answer is being written',
  tool_use: 'A tool or web search is running',
  completed: 'The answer just finished',
  error: 'Something went wrong',
  unknown: 'The page layout is not recognized',
};

function buildMapping(): void {
  const body = $('#mapping-body');
  body.replaceChildren();
  for (const state of AI_STATES) {
    const row = document.createElement('div');
    row.className = 'map-row';

    const name = document.createElement('div');
    name.className = 'map-state';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.dataset.state = state;
    const text = document.createElement('p');
    const title = document.createElement('strong');
    title.textContent = STATE_LABELS[state] ?? state;
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = STATE_HINTS[state] ?? '';
    text.append(title, document.createElement('br'), desc);
    name.append(dot, text);

    const select = document.createElement('select');
    select.setAttribute('aria-label', `Animation for ${STATE_LABELS[state]}`);
    for (const value of [DISABLED, ...ANIMATIONS]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value === DISABLED ? 'Do nothing' : value;
      select.append(opt);
    }
    select.value = config.mapping[state];
    select.addEventListener('change', () => {
      void update((c) => (c.mapping[state] = sanitizeMappingTarget(select.value, c.mapping[state])));
    });

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn secondary sm';
    btn.textContent = 'Test';
    btn.setAttribute('aria-label', `Test animation for ${STATE_LABELS[state]}`);
    btn.addEventListener('click', async () => {
      const value = select.value;
      if (!isAnimation(value)) {
        toast('Nothing to play for “Do nothing”');
        return;
      }
      const res = await withBusy(btn, () => sendToBackground<AnimationTestResult>({ kind: 'testAnimation', animation: value }));
      toast(res.ok ? `Playing “${value}”` : res.message);
    });
    row.append(name, select, btn);
    body.append(row);
  }
}

$('#reset-mapping').addEventListener('click', () => {
  void update((c) => (c.mapping = { ...DEFAULT_MAPPING }), 'Animations restored').then(buildMapping);
});

// ------------------------------------------------------- behaviour / timing

const TIMING_LABELS: Record<keyof TimingConfig, [string, string]> = {
  debounceMs: ['Page debounce', 'Ignore UI flicker shorter than this'],
  minStableMs: ['Minimum stable state', 'A state must last this long before the robot reacts'],
  completionMs: ['Completion time', 'How long “Completed” is shown'],
  requestTimeoutMs: ['Robot timeout', 'Give up on a robot request after'],
  staleMs: ['Lost-signal timeout', 'Back to rest if a busy tab goes silent'],
  keepaliveMs: ['Long-answer keepalive', 'Refresh long animations (0 = off)'],
  typingIdleMs: ['Typing ends after', 'Keyboard pause that ends “User typing”'],
  taskEndMs: ['Wait before “completed”', 'Pauses between agent steps shorter than this keep the task running'],
};

function buildTiming(): void {
  const host = $('#timing');
  host.replaceChildren();
  for (const key of Object.keys(DEFAULT_TIMING) as (keyof TimingConfig)[]) {
    const label = document.createElement('label');
    label.className = 'field';
    const [title, hint] = TIMING_LABELS[key];
    const t = document.createElement('span');
    t.className = 'label';
    t.textContent = title;
    const h = document.createElement('span');
    h.className = 'hint';
    h.textContent = hint;
    const wrap = document.createElement('span');
    wrap.className = 'unit';
    const unit = document.createElement('span');
    unit.textContent = 'ms';
    const input = document.createElement('input');
    input.className = 'input';
    input.type = 'number';
    const [min, max] = TIMING_BOUNDS[key];
    input.min = String(min);
    input.max = String(max);
    input.step = '100';
    input.value = String(config.timing[key]);
    input.addEventListener('change', () => {
      void update((c) => (c.timing[key] = Number(input.value))).then(() => {
        input.value = String(config.timing[key]); // show clamped value
      });
    });
    wrap.append(input, unit);
    label.append(t, wrap, h);
    host.append(label);
  }
}

$('#reset-timing').addEventListener('click', () => {
  void update((c) => (c.timing = { ...DEFAULT_TIMING }), 'Timing restored').then(buildTiming);
});

for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="arbitration"]')) {
  radio.addEventListener('change', () => {
    if (radio.checked) void update((c) => (c.arbitration = radio.value === 'activity-priority' ? 'activity-priority' : 'active-tab'));
  });
}

function fillBehaviour(): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="arbitration"]')) {
    radio.checked = radio.value === config.arbitration;
  }
  buildTiming();
}

// -------------------------------------------------------------- diagnostics

$input('#debug').addEventListener('change', (ev) => {
  void update((c) => (c.debugLogging = (ev.target as HTMLInputElement).checked), (ev.target as HTMLInputElement).checked ? 'Debug log on' : 'Debug log off');
});

$('#refresh-log').addEventListener('click', async () => {
  const lines = await sendToBackground<string[]>({ kind: 'getDebugLog' });
  const pre = $('#log');
  pre.hidden = false;
  pre.textContent = lines.length ? lines.join('\n') : config.debugLogging ? '(log is empty)' : '(debug logging is off)';
});

$('#copy-report').addEventListener('click', async () => {
  const pre = $('#log');
  pre.hidden = false;
  if (!config.debugLogging) {
    pre.textContent = 'Switch on “Debug log” first, then send one prompt in the AI tab and press this button again.';
    return;
  }
  const reports = await sendToBackground<{ tabId: number; platform: string; at: number; report: unknown }[]>({ kind: 'getDetectionReports' });
  if (reports.length === 0) {
    pre.textContent = 'No report yet. Reload the AI tab, send one prompt, wait until the answer is finished, then press this button again.';
    return;
  }
  const text = JSON.stringify(
    { extension: browser.runtime.getManifest().version, generated: new Date().toISOString(), reports: reports.map(({ platform, at, report }) => ({ platform, at: new Date(at).toISOString(), report })) },
    null,
    1,
  );
  pre.textContent = text;
  try {
    await navigator.clipboard.writeText(text);
    toast('Detection report copied');
  } catch {
    toast('Select the text below and copy it');
  }
});

$('#clear-log').addEventListener('click', async () => {
  await sendToBackground({ kind: 'clearDebugLog' });
  $('#log').textContent = '';
});

$input('#enabled').addEventListener('change', (ev) => {
  const on = (ev.target as HTMLInputElement).checked;
  void update((c) => (c.enabled = on), on ? 'Bridge on' : 'Bridge paused');
});

async function refreshStatus(): Promise<void> {
  let s: StatusSnapshot;
  try {
    s = await sendToBackground<StatusSnapshot>({ kind: 'getStatus' });
  } catch {
    return;
  }
  $input('#enabled').checked = s.enabled;
  document.body.classList.toggle('off', !s.enabled);
  $('#getting-started').hidden = s.connection !== 'unconfigured' && s.connection !== 'unknown' && s.connection !== 'no-permission';
  const pill = $('#connection');
  pill.dataset.tone = connectionTone(s.connection);
  pill.dataset.live = String(s.connection === 'connected' && s.enabled);
  setText(pill, `Robot: ${CONNECTION_LABELS[s.connection] ?? s.connection}`);
  setText($('#connection-detail'), s.connectionDetail || (CONNECTION_LABELS[s.connection] ?? s.connection));
  setText($('#firmware'), s.firmwareVersion ?? '–');
  setText($('#auth-required'), s.authRequired === null ? '–' : s.authRequired ? 'yes' : 'no');
  setText($('#robot-animation'), s.robotAnimation ?? '–');
  setText(
    $('#last-sent'),
    s.lastSent ? `${s.lastSent.animation}${s.lastSent.state ? ` for “${STATE_LABELS[s.lastSent.state]}”` : ''} · ${formatAgo(s.lastSent.at)}` : '–',
  );
  setText(
    $('#diag-controller'),
    s.controller
      ? `${platformLabel(s.controller.platform)} (tab ${s.controller.tabId}) · ${STATE_LABELS[s.controller.state]} · ${Math.round(s.controller.confidence * 100)}% · mode: ${s.arbitration}`
      : `none · mode: ${s.arbitration}`,
  );
  setText(
    $('#diag-command'),
    s.lastCommand ? `anim “${s.lastCommand.animation}” → ${s.lastCommand.ok ? 'ok' : 'failed'} (${s.lastCommand.detail}) · ${formatAgo(s.lastCommand.at)}` : '–',
  );
  setText($('#diag-error'), s.lastError ? `${s.lastError.message} · ${formatAgo(s.lastError.at)}` : '–');

  const body = $('#diag-tabs');
  body.replaceChildren();
  if (s.tabs.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'empty';
    td.textContent = 'No AI tab is reporting yet — open ChatGPT, Claude or your Open WebUI.';
    tr.append(td);
    body.append(tr);
  }
  for (const t of s.tabs) {
    const tr = document.createElement('tr');
    const cells = [
      String(t.tabId),
      platformLabel(t.platform),
      STATE_LABELS[t.state] ?? t.state,
      STATE_LABELS[t.effectiveState] ?? t.effectiveState,
      `${Math.round(t.confidence * 100)}%`,
      t.signals.join(', ') || '–',
      formatAgo(Date.now() - t.ageMs),
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = c;
      if (i === 5) td.className = 'signals';
      tr.append(td);
    });
    body.append(tr);
  }
}

// --------------------------------------------------------------------- init

async function init(): Promise<void> {
  config = await loadConfig();
  setText($('#version'), `v${browser.runtime.getManifest().version}`);
  $input('#enabled').checked = config.enabled;
  $input('#debug').checked = config.debugLogging;
  fillDevice();
  fillPlatforms();
  buildMapping();
  fillBehaviour();
  await refreshStatus();
  setInterval(() => void refreshStatus(), POLL_MS);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'config' in changes) {
    void loadConfig().then((c) => {
      config = c;
      $input('#enabled').checked = c.enabled;
    });
  }
});

browser.permissions.onAdded.addListener(() => void renderPermissions());
browser.permissions.onRemoved.addListener(() => void renderPermissions());

void init();
