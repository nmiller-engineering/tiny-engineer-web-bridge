import type { ConnectionTestResult, StatusSnapshot } from '../shared/messaging';
import { loadConfig, saveConfig } from '../shared/storage';
import { $, $input, connectionTone, formatAgo, platformLabel, sendToBackground, setText, STATE_LABELS, CONNECTION_LABELS } from '../shared/ui';

const POLL_MS = 1500;
let transport: 'http' | 'serial' = 'http';

function show(el: HTMLElement, text: string, tone: string): void {
  el.dataset.tone = tone;
  setText(el, text);
  el.hidden = text === '';
}

async function refresh(): Promise<void> {
  let s: StatusSnapshot;
  try {
    s = await sendToBackground<StatusSnapshot>({ kind: 'getStatus' });
  } catch {
    show($('#notice'), 'The extension background is not reachable. Try reopening the popup.', 'bad');
    return;
  }
  document.body.classList.toggle('off', !s.enabled);
  $input('#enabled').checked = s.enabled;

  const conn = $('#connection');
  conn.dataset.tone = connectionTone(s.connection);
  conn.dataset.live = String(s.connection === 'connected' && s.enabled);
  setText(conn, CONNECTION_LABELS[s.connection] ?? s.connection);
  conn.title = s.connectionDetail;
  const via = transport === 'serial' ? 'USB' : 'Wi-Fi';
  setText($('#link'), s.connection === 'unconfigured' ? '' : `${via}${s.firmwareVersion ? ` · ${s.firmwareVersion}` : ''}`);

  const unconfigured = s.connection === 'unconfigured';
  $('#welcome').hidden = !unconfigured;
  $('#paused').hidden = unconfigured || s.enabled;
  $('#activity').hidden = unconfigured || !s.enabled;
  $('#test').hidden = unconfigured;
  document.querySelector('.actions')?.classList.toggle('single', unconfigured);

  const state = s.controller?.state ?? 'idle';
  $('#state').dataset.state = state;
  setText($('#state-label'), STATE_LABELS[state] ?? state);
  setText(
    $('#source'),
    s.controller
      ? `${platformLabel(s.controller.platform)} · ${Math.round(s.controller.confidence * 100)} % confidence`
      : 'No supported AI tab open',
  );
  setText($('#robot-animation'), s.robotAnimation ?? s.lastSent?.animation ?? '–');
  setText($('#last-sent'), s.lastSent ? `sent ${formatAgo(s.lastSent.at)}` : '');

  let notice = '';
  if (s.connection === 'no-permission') notice = s.connectionDetail || 'Firefox needs your permission to reach the robot. Open Settings → “Save & allow access”.';
  else if ((s.connection === 'error' || s.connection === 'disconnected') && s.enabled) notice = s.connectionDetail;
  show($('#notice'), notice, s.connection === 'disconnected' ? 'warn' : 'bad');
}

$input('#enabled').addEventListener('change', async (ev) => {
  const config = await loadConfig();
  config.enabled = (ev.target as HTMLInputElement).checked;
  await saveConfig(config);
  void refresh();
});

$('#test').addEventListener('click', async () => {
  const button = $('#test') as HTMLButtonElement;
  button.disabled = true;
  button.classList.add('busy');
  try {
    const res = await sendToBackground<ConnectionTestResult>({ kind: 'testConnection' });
    show($('#result'), res.message, res.ok ? 'ok' : 'bad');
  } catch {
    show($('#result'), 'Background script not reachable.', 'bad');
  } finally {
    button.disabled = false;
    button.classList.remove('busy');
    void refresh();
  }
});

const openSettings = () => {
  void browser.runtime.openOptionsPage();
  window.close();
};
$('#settings').addEventListener('click', openSettings);
$('#setup').addEventListener('click', openSettings);

void loadConfig().then((c) => {
  transport = c.device.transport;
  void refresh();
});
setInterval(() => void refresh(), POLL_MS);
