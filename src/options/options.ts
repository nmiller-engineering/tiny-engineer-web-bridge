import {
  cloneDefaultConfig,
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
import { AI_STATES, ANIMATIONS, DISABLED, isAnimation, type Platform } from '../shared/types';
import { $, $input, CONNECTION_LABELS, formatAgo, platformLabel, sendToBackground, setText, STATE_LABELS } from '../shared/ui';

const POLL_MS = 1500;
let config: Config = cloneDefaultConfig();

async function update(mutate: (c: Config) => void): Promise<void> {
  const next = structuredClone(config);
  mutate(next);
  config = await saveConfig(next);
}

// --------------------------------------------------------------- connection

function fillDevice(): void {
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

$('#device-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const host = $input('#host').value.trim().toLowerCase();
  const port = Number($input('#port').value);
  const token = $input('#token').value;
  const err = validateHost(host) ?? validatePort(port) ?? validateToken(token);
  setText($('#device-error'), err ?? '');
  if (err) return;

  const oldPattern = config.device.host ? deviceMatchPattern(config.device.host) : null;
  const pattern = deviceMatchPattern(host);
  // permissions.request must be the first await inside the user gesture.
  void browser.permissions.request({ origins: [pattern] }).then(async (granted) => {
    await update((c) => {
      c.device = { host, port, token, autoReconnect: $input('#auto-reconnect').checked };
    });
    fillDevice();
    if (oldPattern && oldPattern !== pattern && !isPatternInUse(oldPattern)) {
      await browser.permissions.remove({ origins: [oldPattern] }).catch(() => undefined);
    }
    if (!granted) {
      setText($('#device-error'), 'Saved, but Firefox access to the robot was not granted. Press the button again and choose “Allow”.');
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
  const button = $('#test-connection') as HTMLButtonElement;
  button.disabled = true;
  setText($('#connection-detail'), 'Testing…');
  try {
    const res = await sendToBackground<ConnectionTestResult>({ kind: 'testConnection' });
    setText($('#connection-detail'), res.message);
  } finally {
    button.disabled = false;
    void refreshStatus();
  }
}
$('#test-connection').addEventListener('click', () => void runConnectionTest());

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
  if (granted) {
    el.append(document.createTextNode('✓ site access granted'));
    el.className = 'perm muted';
    return;
  }
  el.className = 'perm error';
  el.append(document.createTextNode('Site access not granted'));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'small';
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
      });
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
    if (enable && !granted) setText($('#openwebui-error'), 'Firefox access to this origin was not granted.');
    fillPlatforms();
  });
}

$('#save-openwebui').addEventListener('click', () => saveOpenWebUI(true));
$input('#pf-openwebui').addEventListener('change', (ev) => {
  const on = (ev.target as HTMLInputElement).checked;
  if (on) saveOpenWebUI(true);
  else void update((c) => (c.platforms.openwebui = false)).then(fillPlatforms);
});

// ------------------------------------------------------------------ mapping

function buildMapping(): void {
  const body = $('#mapping-body');
  body.replaceChildren();
  for (const state of AI_STATES) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = STATE_LABELS[state] ?? state;
    const pick = document.createElement('td');
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
    pick.append(select);
    const test = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary small';
    btn.textContent = 'Test';
    btn.addEventListener('click', async () => {
      const value = select.value;
      if (!isAnimation(value)) {
        setText($('#anim-result'), 'Nothing to test for “Do nothing”.');
        return;
      }
      const res = await sendToBackground<AnimationTestResult>({ kind: 'testAnimation', animation: value });
      setText($('#anim-result'), res.message);
    });
    test.append(btn);
    tr.append(name, pick, test);
    body.append(tr);
  }
}

// ------------------------------------------------------- behaviour / timing

const TIMING_LABELS: Record<keyof TimingConfig, string> = {
  debounceMs: 'UI debounce (ms)',
  minStableMs: 'Minimum stable state (ms)',
  completionMs: 'Completion animation time (ms)',
  requestTimeoutMs: 'Robot request timeout (ms)',
  staleMs: 'Lost-signal timeout (ms)',
  keepaliveMs: 'Continuous-animation keepalive (ms, 0 = off)',
  typingIdleMs: 'Typing ends after (ms)',
};

function buildTiming(): void {
  const host = $('#timing');
  host.replaceChildren();
  for (const key of Object.keys(DEFAULT_TIMING) as (keyof TimingConfig)[]) {
    const label = document.createElement('label');
    label.textContent = TIMING_LABELS[key];
    const input = document.createElement('input');
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
    label.append(input);
    host.append(label);
  }
}

$('#reset-timing').addEventListener('click', () => {
  void update((c) => (c.timing = { ...DEFAULT_TIMING })).then(buildTiming);
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
  void update((c) => (c.debugLogging = (ev.target as HTMLInputElement).checked));
});

$('#refresh-log').addEventListener('click', async () => {
  const lines = await sendToBackground<string[]>({ kind: 'getDebugLog' });
  const pre = $('#log');
  pre.hidden = false;
  pre.textContent = lines.length ? lines.join('\n') : config.debugLogging ? '(log is empty)' : '(debug logging is off)';
});

$('#clear-log').addEventListener('click', async () => {
  await sendToBackground({ kind: 'clearDebugLog' });
  $('#log').textContent = '';
});

$input('#enabled').addEventListener('change', (ev) => {
  void update((c) => (c.enabled = (ev.target as HTMLInputElement).checked));
});

async function refreshStatus(): Promise<void> {
  let s: StatusSnapshot;
  try {
    s = await sendToBackground<StatusSnapshot>({ kind: 'getStatus' });
  } catch {
    return;
  }
  $input('#enabled').checked = s.enabled;
  const pill = $('#connection');
  pill.dataset.state = s.connection;
  setText(pill, CONNECTION_LABELS[s.connection] ?? s.connection);
  if (s.connectionDetail) setText($('#connection-detail'), s.connectionDetail);
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
    s.lastCommand ? `POST /anim?name=${s.lastCommand.animation} → ${s.lastCommand.ok ? 'ok' : 'failed'} (${s.lastCommand.detail}) · ${formatAgo(s.lastCommand.at)}` : '–',
  );
  setText($('#diag-error'), s.lastError ? `${s.lastError.message} · ${formatAgo(s.lastError.at)}` : '–');

  const body = $('#diag-tabs');
  body.replaceChildren();
  if (s.tabs.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'muted';
    td.textContent = 'No supported AI tab is reporting.';
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
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    body.append(tr);
  }
}

// --------------------------------------------------------------------- init

async function init(): Promise<void> {
  config = await loadConfig();
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
