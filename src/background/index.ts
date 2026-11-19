/**
 * Background entry point (Firefox MV3 non-persistent background script).
 *
 * All listeners are registered synchronously at top level so Firefox can
 * wake the script for them. Runtime state survives suspension via
 * `storage.session`; timers that may not survive are backed by an alarm.
 */
import { deviceMatchPattern, type Config } from '../shared/config';
import { parseContentMessage, parsePageRequest, type PageRequest } from '../shared/messaging';
import { CONFIG_KEY, loadConfig } from '../shared/storage';
import { isPlatform } from '../shared/types';
import { Bridge, isBridgeSnapshot } from './bridge';
import { expectedOrigin, injectIntoOpenTabs, syncContentScripts } from './content-scripts';
import { DebugLog } from './logger';
import { webSerialProvider } from './serial-client';

const SESSION_KEY = 'runtime';
const WATCHDOG_ALARM = 'te-watchdog';
const PERSIST_DELAY_MS = 250;

let bridge: Bridge | null = null;
let currentConfig: Config | null = null;
const debugLog = new DebugLog(() => currentConfig?.debugLogging === true);

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!bridge) return;
    void browser.storage.session.set({ [SESSION_KEY]: bridge.snapshot() }).catch(() => undefined);
    void updateWatchdog();
  }, PERSIST_DELAY_MS);
}

async function updateWatchdog(): Promise<void> {
  if (!bridge) return;
  const existing = await browser.alarms.get(WATCHDOG_ALARM);
  if (bridge.needsWatchdog()) {
    if (!existing) browser.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  } else if (existing) {
    await browser.alarms.clear(WATCHDOG_ALARM);
  }
}

async function hasDevicePermission(host: string): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: [deviceMatchPattern(host)] });
  } catch {
    return false;
  }
}

async function init(): Promise<Bridge> {
  const config = await loadConfig();
  currentConfig = config;
  const b = new Bridge(config, {
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    hasDevicePermission: (t) => hasDevicePermission(t.host),
    serialProvider: webSerialProvider,
    onChange: schedulePersist,
    log: debugLog,
  });

  // Recover runtime state after the background was suspended/restarted.
  try {
    const stored = (await browser.storage.session.get(SESSION_KEY))[SESSION_KEY];
    if (isBridgeSnapshot(stored)) {
      b.restore(stored);
      // Drop tabs that disappeared while we were not running.
      const open = new Set((await browser.tabs.query({})).map((t) => t.id));
      for (const rec of b.registry.all()) if (!open.has(rec.tabId)) b.registry.remove(rec.tabId);
      debugLog.log(`restored ${b.registry.size} tab(s) after background restart`);
    }
  } catch {
    // storage.session unavailable: start fresh.
  }

  try {
    const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id !== undefined) b.registry.focus(active.id);
  } catch {
    /* ignore */
  }

  bridge = b;
  void syncContentScripts(config).catch((e: unknown) => debugLog.log(`content script sync failed: ${String(e)}`));
  b.tick();
  schedulePersist();
  return b;
}

const ready: Promise<Bridge> = init();

function isOwnExtensionPage(sender: browser.runtime.MessageSender): boolean {
  return sender.id === browser.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(browser.runtime.getURL(''));
}

function senderOrigin(sender: browser.runtime.MessageSender): string | null {
  try {
    return sender.url ? new URL(sender.url).origin : null;
  } catch {
    return null;
  }
}

async function handlePageRequest(req: PageRequest, b: Bridge): Promise<unknown> {
  switch (req.kind) {
    case 'getStatus':
      await b.refreshRobotAnimation().catch(() => undefined);
      return b.getStatus();
    case 'testConnection':
      return b.testConnection();
    case 'testAnimation':
      return b.testAnimation(req.animation);
    case 'getDebugLog':
      return debugLog.entries();
    case 'getDetectionReports':
      return b.detectionReports();
    case 'clearDebugLog':
      debugLog.clear();
      b.clearDetectionReports();
      return true;
  }
}

browser.runtime.onMessage.addListener((raw: unknown, sender: browser.runtime.MessageSender) => {
  if (sender.id !== browser.runtime.id) return undefined;

  if (isOwnExtensionPage(sender)) {
    const req = parsePageRequest(raw);
    if (!req) return undefined;
    return ready.then((b) => handlePageRequest(req, b));
  }

  // Everything else must be a top-frame content script in a tab.
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0) return undefined;
  const msg = parseContentMessage(raw);
  if (!msg) return undefined;
  const origin = senderOrigin(sender);
  return ready.then((b) => {
    const expected = expectedOrigin(msg.platform, b.currentConfig);
    return b.handleContent(msg, tabId, expected !== null && origin === expected);
  });
});

browser.tabs.onRemoved.addListener((tabId) => {
  void ready.then((b) => b.tabRemoved(tabId));
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  void ready.then((b) => b.tabActivated(tabId));
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Full navigation/reload or tab discard: the old detector is gone. A new
  // one (if any) says hello once the page has loaded.
  if (changeInfo.status === 'loading' || changeInfo.discarded === true) {
    void ready.then((b) => b.tabRemoved(tabId));
  }
});

browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  void ready.then(async (b) => {
    const [tab] = await browser.tabs.query({ active: true, windowId });
    if (tab?.id !== undefined) b.tabActivated(tab.id);
  });
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  void ready.then(async (b) => {
    b.tick();
    if (b.currentConfig.device.autoReconnect && b.getStatus().connection === 'disconnected') await b.probe();
    schedulePersist();
  });
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(CONFIG_KEY in changes)) return;
  void ready.then(async (b) => {
    const prev = b.currentConfig;
    const next = await loadConfig();
    currentConfig = next;
    b.setConfig(next);
    const added = await syncContentScripts(next).catch(() => []);
    // Platforms that were just switched on: inject into tabs already open.
    for (const p of added) {
      if (isPlatform(p) && (!prev.enabled || !prev.platforms[p] || p === 'openwebui')) {
        await injectIntoOpenTabs(p, next).catch(() => undefined);
      }
    }
  });
});

browser.permissions.onAdded.addListener(() => {
  void ready.then(async (b) => {
    const added = await syncContentScripts(b.currentConfig).catch(() => []);
    for (const p of added) await injectIntoOpenTabs(p, b.currentConfig).catch(() => undefined);
    b.tick();
  });
});

browser.permissions.onRemoved.addListener(() => {
  void ready.then((b) => syncContentScripts(b.currentConfig).catch(() => []));
});

browser.runtime.onInstalled.addListener(() => {
  void ready.then(async (b) => {
    const added = await syncContentScripts(b.currentConfig).catch(() => []);
    for (const p of added) await injectIntoOpenTabs(p, b.currentConfig).catch(() => undefined);
    if (b.currentConfig.device.host === '') void browser.runtime.openOptionsPage();
  });
});

browser.runtime.onStartup.addListener(() => {
  void ready.then((b) => syncContentScripts(b.currentConfig).catch(() => []));
});
