/**
 * Background entry point: Firefox MV3 non-persistent background script,
 * or the Chrome MV3 service worker (same code).
 *
 * All listeners are registered synchronously at top level so the browser can
 * wake the script for them. Runtime state survives suspension via
 * `storage.session`; timers that may not survive are backed by an alarm.
 */
import { deviceMatchPattern, type Config } from '../shared/config';
import { parseContentMessage, parsePageRequest, type PageRequest } from '../shared/messaging';
import { CONFIG_KEY, loadConfig, saveConfig } from '../shared/storage';
import { actionUiFor, MENU_POPUP_MODE, MENU_SETTINGS, MENU_TOGGLE, TOGGLE_COMMAND } from './action-ui';
import { isPlatform } from '../shared/types';
import { Bridge, isBridgeSnapshot } from './bridge';
import { expectedOrigin, injectIntoOpenTabs, syncContentScripts } from './content-scripts';
import { DebugLog } from './logger';
import { RemoteSerialClient, type UsbPingReply } from './remote-serial-client';
import { webSerialProvider } from './serial-client';
import { TARGET } from '../shared/target';

const FIREFOX_USB_MESSAGE =
  'USB is not available in Firefox: Firefox only grants Web Serial to websites (through a site-permission add-on), not to extensions. Please use Wi-Fi.';

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
    if (currentConfig) void applyActionUi(currentConfig); // connection changes → "!" badge
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

// ------------------------------------------------------------ toolbar icon

async function shortcutText(): Promise<string> {
  try {
    const commands = await browser.commands.getAll();
    return commands.find((c) => c.name === TOGGLE_COMMAND)?.shortcut ?? '';
  } catch {
    return '';
  }
}

let lastActionKey = '';

/** Icon, badge, tooltip, click behaviour and menu titles for the current config and connection. */
async function applyActionUi(config: Config): Promise<void> {
  const connection = bridge?.getStatus().connection ?? 'unknown';
  const ui = actionUiFor(config, await shortcutText(), connection);
  const key = JSON.stringify([ui, config.toolbarClick]);
  if (key === lastActionKey) return;
  lastActionKey = key;
  const action = browser.action as typeof browser.action & { setBadgeTextColor?: (d: { color: string }) => Promise<void> };
  await Promise.all([
    action.setIcon({ path: ui.icon }),
    action.setBadgeText({ text: ui.badgeText }),
    action.setBadgeBackgroundColor({ color: ui.badgeColor }),
    action.setBadgeTextColor?.({ color: '#ffffff' }),
    action.setTitle({ title: ui.title }),
    action.setPopup({ popup: ui.popup }),
  ]).catch(() => undefined);
  await browser.contextMenus.update(MENU_TOGGLE, { title: ui.toggleMenuTitle }).catch(() => undefined);
  await browser.contextMenus.update(MENU_POPUP_MODE, { checked: config.toolbarClick === 'toggle' }).catch(() => undefined);
}

/** (Re)create the icon's right-click menu. Idempotent. */
async function createMenus(config: Config): Promise<void> {
  const ui = actionUiFor(config, await shortcutText());
  const contexts = ['action'] as unknown as browser.contextMenus.ContextType[];
  try {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({ id: MENU_TOGGLE, title: ui.toggleMenuTitle, contexts });
    browser.contextMenus.create({ id: MENU_POPUP_MODE, title: 'One click on the icon turns on/off', type: 'checkbox', checked: config.toolbarClick === 'toggle', contexts });
    browser.contextMenus.create({ id: MENU_SETTINGS, title: 'Open dashboard', contexts });
  } catch {
    /* menus unavailable — the icon still works */
  }
}

async function toggleBridge(): Promise<void> {
  const config = await loadConfig();
  config.enabled = !config.enabled;
  await saveConfig(config); // storage.onChanged applies it everywhere
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
    // Firefox: no Web Serial for extensions. Chrome: the worker has none, the USB page does.
    serialUnavailableMessage: FIREFOX_USB_MESSAGE,
    serialClient:
      TARGET === 'chrome'
        ? new RemoteSerialClient({
            send: (m) => browser.runtime.sendMessage(m),
            timeoutMs: () => currentConfig?.timing.requestTimeoutMs ?? 2000,
          })
        : undefined,
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
  void createMenus(config).then(() => applyActionUi(config));
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
    case 'getSerialInfo': {
      if (TARGET === 'chrome') {
        // Chrome: ask the USB connection page.
        try {
          const ping = (await browser.runtime.sendMessage({ kind: 'usbPing', v: 1 })) as UsbPingReply | undefined;
          return ping ? { available: true, ports: ping.ports, error: '', usbTab: true } : { available: false, ports: 0, error: '', usbTab: false };
        } catch {
          return { available: false, ports: 0, error: '', usbTab: false };
        }
      }
      // Firefox: whether the background (which talks to the robot) can use Web Serial.
      const provider = webSerialProvider();
      if (!provider) return { available: false, ports: 0, error: '' };
      try {
        const ports = await provider.getPorts();
        return { available: true, ports: ports.length, error: '' };
      } catch (err) {
        return { available: true, ports: 0, error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 160) : 'error' };
      }
    }
    case 'clearDebugLog':
      debugLog.clear();
      b.clearDetectionReports();
      return true;
  }
}

/**
 * Answer asynchronously via sendResponse + `return true`. Works in Firefox
 * and in every Chrome version (older Chrome ignores Promise return values).
 */
function reply(work: Promise<unknown>, sendResponse: (response?: unknown) => void): true {
  work.then(
    (value) => sendResponse(value),
    () => sendResponse(undefined),
  );
  return true;
}

browser.runtime.onMessage.addListener(((raw: unknown, sender: browser.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
  if (sender.id !== browser.runtime.id) return false;

  if (isOwnExtensionPage(sender)) {
    const req = parsePageRequest(raw);
    if (!req) return false; // e.g. replies meant for the USB page
    return reply(
      ready.then((b) => handlePageRequest(req, b)),
      sendResponse,
    );
  }

  // Everything else must be a top-frame content script in a tab.
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0) return false;
  const msg = parseContentMessage(raw);
  if (!msg) return false;
  const origin = senderOrigin(sender);
  return reply(
    ready.then((b) => {
      const expected = expectedOrigin(msg.platform, b.currentConfig);
      return b.handleContent(msg, tabId, expected !== null && origin === expected);
    }),
    sendResponse,
  );
}) as Parameters<typeof browser.runtime.onMessage.addListener>[0]);

// One-click mode: the popup is disabled, so clicks arrive here.
browser.action.onClicked.addListener(() => {
  void ready.then(() => toggleBridge());
});

browser.commands.onCommand.addListener((command) => {
  if (command === TOGGLE_COMMAND) void ready.then(() => toggleBridge());
});

browser.contextMenus.onClicked.addListener((info) => {
  void ready.then(async () => {
    if (info.menuItemId === MENU_TOGGLE) await toggleBridge();
    else if (info.menuItemId === MENU_SETTINGS) await browser.runtime.openOptionsPage();
    else if (info.menuItemId === MENU_POPUP_MODE) {
      const config = await loadConfig();
      config.toolbarClick = info.checked ? 'toggle' : 'popup';
      await saveConfig(config);
    }
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
    await applyActionUi(next);
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
