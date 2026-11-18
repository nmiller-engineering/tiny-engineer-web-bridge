import type { ConnectionTestResult, StatusSnapshot } from '../shared/messaging';
import { loadConfig, saveConfig } from '../shared/storage';
import { $, $input, CONNECTION_LABELS, formatAgo, platformLabel, sendToBackground, setText, STATE_LABELS } from '../shared/ui';

const POLL_MS = 1500;

async function refresh(): Promise<void> {
  let status: StatusSnapshot;
  try {
    status = await sendToBackground<StatusSnapshot>({ kind: 'getStatus' });
  } catch {
    return;
  }
  $input('#enabled').checked = status.enabled;

  const conn = $('#connection');
  conn.dataset.state = status.connection;
  setText(conn, CONNECTION_LABELS[status.connection] ?? status.connection);
  conn.title = status.connectionDetail;
  setText($('#firmware'), status.firmwareVersion ? `firmware ${status.firmwareVersion}` : '');

  setText($('#robot-animation'), status.robotAnimation ?? '–');
  setText(
    $('#last-sent'),
    status.lastSent
      ? `${status.lastSent.animation}${status.lastSent.state ? ` (${STATE_LABELS[status.lastSent.state]})` : ''} · ${formatAgo(status.lastSent.at)}`
      : '–',
  );
  setText(
    $('#source'),
    status.controller
      ? `${platformLabel(status.controller.platform)} · ${STATE_LABELS[status.controller.state]} · ${Math.round(status.controller.confidence * 100)}%`
      : status.enabled
        ? 'No supported AI tab'
        : 'Bridge disabled',
  );

  const notice = $('#notice');
  let text = '';
  if (status.connection === 'unconfigured') text = 'Enter your Tiny Engineer address in Settings.';
  else if (status.connection === 'no-permission')
    text = status.connectionDetail || 'Firefox needs your permission to contact the robot. Open Settings → “Save & allow access”.';
  else if (status.connection === 'error' || status.connection === 'disconnected') text = status.connectionDetail;
  notice.hidden = text === '';
  setText(notice, text);
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
  setText($('#result'), 'Testing…');
  try {
    const res = await sendToBackground<ConnectionTestResult>({ kind: 'testConnection' });
    setText($('#result'), res.message);
  } catch {
    setText($('#result'), 'Background script not reachable.');
  } finally {
    button.disabled = false;
    void refresh();
  }
});

$('#settings').addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
  window.close();
});

void refresh();
setInterval(() => void refresh(), POLL_MS);
