/**
 * Toolbar icon appearance and behaviour (pure; applied by background/index.ts).
 *
 * - Off: grey icon + "OFF" badge, so the state is visible without a click.
 * - One-click mode: no popup; a click toggles the bridge (settings via the
 *   icon's context menu).
 */
import type { Config } from '../shared/config';

export const TOGGLE_COMMAND = 'toggle-bridge';
export const MENU_TOGGLE = 'te-toggle';
export const MENU_SETTINGS = 'te-settings';
export const MENU_POPUP_MODE = 'te-popup-mode';

export interface ActionUi {
  icon: Record<string, string>;
  badgeText: string;
  badgeColor: string;
  title: string;
  /** '' disables the popup so that clicks reach action.onClicked. */
  popup: string;
  toggleMenuTitle: string;
}

export function actionUiFor(config: Pick<Config, 'enabled' | 'toolbarClick'>, shortcut = ''): ActionUi {
  const on = config.enabled;
  const hint = shortcut ? ` (${shortcut})` : '';
  const click = config.toolbarClick === 'toggle' ? (on ? ' — click to turn off' : ' — click to turn on') : '';
  return {
    icon: on ? { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png' } : { '16': 'icons/icon-off-16.png', '32': 'icons/icon-off-32.png' },
    badgeText: on ? '' : 'OFF',
    badgeColor: '#6b7280',
    title: `Tiny Engineer: ${on ? 'on' : 'off'}${click}${hint}`,
    popup: config.toolbarClick === 'toggle' ? '' : 'popup/index.html',
    toggleMenuTitle: on ? `Turn robot bridge off${hint}` : `Turn robot bridge on${hint}`,
  };
}
