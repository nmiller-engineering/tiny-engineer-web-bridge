/**
 * Toolbar icon appearance and behaviour (pure; applied by background/index.ts).
 *
 * - Off: grey icon + "OFF" badge, so the state is visible without a click.
 * - One-click mode: no popup; a click toggles the bridge (settings via the
 *   icon's context menu).
 */
import type { Config } from '../shared/config';
import type { ConnectionState } from '../shared/messaging';

/** Connection states that mean "the robot does not get our commands". */
const PROBLEM: ReadonlySet<ConnectionState> = new Set(['disconnected', 'error', 'no-permission']);

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

export function actionUiFor(config: Pick<Config, 'enabled' | 'toolbarClick'>, shortcut = '', connection: ConnectionState = 'unknown'): ActionUi {
  const on = config.enabled;
  const hint = shortcut ? ` (${shortcut})` : '';
  const click = config.toolbarClick === 'toggle' ? (on ? ' — click to turn off' : ' — click to turn on') : '';
  // While on but the robot is unreachable: orange "!" so it is noticed at a glance.
  const problem = on && PROBLEM.has(connection);
  return {
    icon: on ? { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png' } : { '16': 'icons/icon-off-16.png', '32': 'icons/icon-off-32.png' },
    badgeText: on ? (problem ? '!' : '') : 'OFF',
    badgeColor: problem ? '#d97706' : '#6b7280',
    title: problem
      ? `Tiny Engineer: robot unreachable — open the dashboard${hint}`
      : `Tiny Engineer: ${on ? 'on' : 'off (robot sleeping)'}${click}${hint}`,
    popup: config.toolbarClick === 'toggle' ? '' : 'popup/index.html',
    toggleMenuTitle: on ? `Turn robot bridge off${hint}` : `Turn robot bridge on${hint}`,
  };
}
