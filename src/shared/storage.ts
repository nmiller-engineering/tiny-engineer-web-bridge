/**
 * Config persistence for privileged extension contexts (background, popup,
 * options). Content scripts must never import this module.
 *
 * Stored in `browser.storage.local` (not `sync`, so the robot address and
 * token never leave this Firefox profile). Extension storage is NOT
 * encrypted — see SECURITY.md.
 */
import { sanitizeConfig, type Config } from './config';

export const CONFIG_KEY = 'config';

export async function loadConfig(): Promise<Config> {
  const stored = await browser.storage.local.get(CONFIG_KEY);
  return sanitizeConfig(stored[CONFIG_KEY]);
}

export async function saveConfig(config: Config): Promise<Config> {
  const clean = sanitizeConfig(config);
  await browser.storage.local.set({ [CONFIG_KEY]: clean });
  return clean;
}
