import type { ConnectionTestResult, StatusSnapshot } from '../shared/messaging';
import { loadConfig, saveConfig } from '../shared/storage';
import { $, CONNECTION_LABELS, connectionTone, formatAgo, platformLabel, sendToBackground, setText, STATE_LABELS } from '../shared/ui';

const POLL_MS = 1500;
let transport: 'http' | 'serial' = 'http';
let shortcut = '';
let enabled = true;

function show(el: HTMLElement, text: string, tone: string): void {
  el.dataset.tone = tone;
  setText(el, text);
  el.hidden = text === '';
}

function renderPower(): void {
  const power = $('#power');
  power.setAttribute('aria-pressed', String(enabled));
  setText($('#power-label'), enabled ? 'Robot link on' : 'Robot link off');
  const keys = shortcut ? ` · ${shortcut}` : '';
  setText($('#power-hint'), (enabled ? 'Click to turn off' : 'Click to turn on') + keys);
  document.body.classList.toggle('off', !enabled);
}

async function refresh(): Promise<void> {
  let s: StatusSnapshot;
  try {
    s = await sendToBackground<StatusSnapshot>({ kind: 'getStatus' });
  } catch {
    show($('#notice'), 'The extension background is not reachable. Try reopening the popup.', 'bad');
    return;
  }
  enabled = s.enabled;
  renderPower();

  const conn = $('#connection');
  conn.dataset.tone = connectionTone(s.connection);
  conn.dataset.live = String(s.connection === 'connected' && s.enabled);
  setText(conn, CONNECTION_LABELS[s.connection] ?? s.connection);
  conn.title = s.connectionDetail;
  const via = transport === 'serial' ? 'USB' : 'Wi-Fi';
  setText($('#link'), s.connection === 'unconfigured' ? '' : `${via}${s.firmwareVersion ? ` · ${s.firmwareVersion}` : ''}`);

  const unconfigured = s.connection === 'unconfigured';
  $('#welcome').hidden = !unconfigured;
  $('#activity').hidden = unconfigured;
  ($('#test') as HTMLButtonElement).disabled = unconfigured;
  setText($('#dashboard'), unconfigured ? 'Set up robot in the dashboard' : 'Open dashboard');

  const state = s.controller?.state ?? 'idle';
  $('#state').dataset.state = state;
  setText($('#state-label'), STATE_LABELS[state] ?? state);
  setText(
    $('#source'),
    s.controller ? `${platformLabel(s.controller.platform)} · ${Math.round(s.controller.confidence * 100)} % confidence` : 'No supported AI tab open',
  );
  setText($('#robot-animation'), s.robotAnimation ?? s.lastSent?.animation ?? '–');
  setText($('#last-sent'), s.lastSent ? `sent ${formatAgo(s.lastSent.at)}` : '');

  let notice = '';
  if (s.connection === 'no-permission') notice = s.connectionDetail || 'The browser needs your permission to reach the robot. Open the dashboard → “Save & allow access”.';
  else if ((s.connection === 'error' || s.connection === 'disconnected') && s.enabled) notice = s.connectionDetail;
  show($('#notice'), notice, s.connection === 'disconnected' ? 'warn' : 'bad');
}

$('#power').addEventListener('click', async () => {
  enabled = !enabled;
  renderPower(); // instant feedback
  const config = await loadConfig();
  config.enabled = enabled;
  await saveConfig(config);
  void refresh();
});

$('#test').addEventListener('click', async () => {
  const button = $('#test') as HTMLButtonElement;
  button.disabled = true;
  setText(button, 'Testing…');
  try {
    const res = await sendToBackground<ConnectionTestResult>({ kind: 'testConnection' });
    show($('#result'), res.message, res.ok ? 'ok' : 'bad');
  } catch {
    show($('#result'), 'Background script not reachable.', 'bad');
  } finally {
    button.disabled = false;
    setText(button, 'Test connection');
    void refresh();
  }
});

$('#dashboard').addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
  window.close();
});

async function init(): Promise<void> {
  const config = await loadConfig();
  transport = config.device.transport;
  enabled = config.enabled;
  try {
    shortcut = (await browser.commands.getAll()).find((c) => c.name === 'toggle-bridge')?.shortcut ?? '';
  } catch {
    shortcut = '';
  }
  renderPower();
  void refresh();
  setInterval(() => void refresh(), POLL_MS);
}

void init();
