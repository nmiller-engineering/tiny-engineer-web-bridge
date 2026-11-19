/**
 * Dynamic content-script registration.
 *
 * Detectors are registered only for enabled platforms, so nothing runs on a
 * disabled AI site. The custom Open WebUI origin is registered only after the
 * user granted host permission for it.
 */
import { originToMatchPattern, type Config } from '../shared/config';
import type { Platform } from '../shared/types';

export const SCRIPT_FILES: Record<Platform, string> = {
  chatgpt: 'content/chatgpt.js',
  claude: 'content/claude.js',
  openwebui: 'content/openwebui.js',
};

const ID_PREFIX = 'te-';

export interface Registration {
  id: string;
  platform: Platform;
  matches: string[];
  js: string[];
}

/** Origins each platform's messages must come from (exact match incl. port). */
export function expectedOrigin(platform: Platform, config: Config): string | null {
  switch (platform) {
    case 'chatgpt':
      return 'https://chatgpt.com';
    case 'claude':
      return 'https://claude.ai';
    case 'openwebui':
      return config.platforms.openwebuiOrigin || null;
  }
}

export function platformMatches(platform: Platform, config: Config): string[] {
  const origin = expectedOrigin(platform, config);
  return origin ? [originToMatchPattern(origin)] : [];
}

/** Registrations wanted for this config (pure; exported for tests). */
export function desiredRegistrations(config: Config, openwebuiGranted: boolean): Registration[] {
  if (!config.enabled) return [];
  const out: Registration[] = [];
  for (const platform of ['chatgpt', 'claude', 'openwebui'] as const) {
    if (!config.platforms[platform]) continue;
    if (platform === 'openwebui' && !openwebuiGranted) continue;
    const matches = platformMatches(platform, config);
    if (matches.length === 0) continue;
    out.push({ id: ID_PREFIX + platform, platform, matches, js: [SCRIPT_FILES[platform]] });
  }
  return out;
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Bring registered content scripts in line with the config. Serialized, and
 * returns the platforms that were newly registered (to inject into open tabs).
 */
export function syncContentScripts(config: Config): Promise<Platform[]> {
  const run = async (): Promise<Platform[]> => {
    let openwebuiGranted = false;
    if (config.platforms.openwebui && config.platforms.openwebuiOrigin) {
      openwebuiGranted = await browser.permissions.contains({ origins: platformMatches('openwebui', config) });
    }
    const desired = desiredRegistrations(config, openwebuiGranted);
    const existing = (await browser.scripting.getRegisteredContentScripts()).filter((s) => s.id.startsWith(ID_PREFIX));

    const same = (a: Registration, b: { matches?: string[]; js?: string[] }) =>
      JSON.stringify(a.matches) === JSON.stringify(b.matches ?? []) && JSON.stringify(a.js) === JSON.stringify(b.js ?? []);

    const toRemove = existing.filter((e) => {
      const d = desired.find((r) => r.id === e.id);
      return !d || !same(d, e);
    });
    if (toRemove.length > 0) await browser.scripting.unregisterContentScripts({ ids: toRemove.map((e) => e.id) });

    const keep = new Set(existing.filter((e) => !toRemove.includes(e)).map((e) => e.id));
    const toAdd = desired.filter((d) => !keep.has(d.id));
    if (toAdd.length > 0) {
      await browser.scripting.registerContentScripts(
        toAdd.map((d) => ({
          id: d.id,
          matches: d.matches,
          js: d.js,
          runAt: 'document_idle' as const,
          allFrames: false,
          persistAcrossSessions: false,
        })),
      );
    }
    return toAdd.map((d) => d.platform);
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

/** Inject a platform's detector into tabs that were already open. */
export async function injectIntoOpenTabs(platform: Platform, config: Config): Promise<void> {
  const matches = platformMatches(platform, config);
  if (matches.length === 0) return;
  const tabs = await browser.tabs.query({ url: matches });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.discarded) return;
      try {
        await browser.scripting.executeScript({ target: { tabId: tab.id }, files: [SCRIPT_FILES[platform]] });
      } catch {
        // Tab not injectable (e.g. about: page, permission missing) — ignore.
      }
    }),
  );
}
