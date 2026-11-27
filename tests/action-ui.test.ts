import { describe, expect, it } from 'vitest';
import { actionUiFor } from '../src/background/action-ui';
import { sanitizeConfig } from '../src/shared/config';

describe('toolbar icon', () => {
  it('shows a coloured icon and no badge while on', () => {
    const ui = actionUiFor({ enabled: true, toolbarClick: 'popup' }, 'Alt+Shift+R');
    expect(ui.badgeText).toBe('');
    expect(ui.icon['16']).toBe('icons/icon-16.png');
    expect(ui.popup).toBe('popup/index.html');
    expect(ui.title).toBe('Tiny Engineer: on (Alt+Shift+R)');
    expect(ui.toggleMenuTitle).toBe('Turn robot bridge off (Alt+Shift+R)');
  });

  it('shows a grey icon with an OFF badge while off', () => {
    const ui = actionUiFor({ enabled: false, toolbarClick: 'popup' });
    expect(ui.badgeText).toBe('OFF');
    expect(ui.icon['32']).toBe('icons/icon-off-32.png');
    expect(ui.toggleMenuTitle).toBe('Turn robot bridge on');
  });

  it('disables the popup in one-click mode and says what a click does', () => {
    expect(actionUiFor({ enabled: true, toolbarClick: 'toggle' }).popup).toBe('');
    expect(actionUiFor({ enabled: true, toolbarClick: 'toggle' }).title).toContain('click to turn off');
    expect(actionUiFor({ enabled: false, toolbarClick: 'toggle' }).title).toContain('click to turn on');
  });

  it('shows an orange "!" when the robot is unreachable while on', () => {
    for (const c of ['disconnected', 'error', 'no-permission'] as const) {
      const ui = actionUiFor({ enabled: true, toolbarClick: 'popup' }, '', c);
      expect(ui.badgeText).toBe('!');
      expect(ui.title).toContain('unreachable');
    }
    expect(actionUiFor({ enabled: true, toolbarClick: 'popup' }, '', 'connected').badgeText).toBe('');
    expect(actionUiFor({ enabled: false, toolbarClick: 'popup' }, '', 'disconnected').badgeText).toBe('OFF'); // off wins
    expect(actionUiFor({ enabled: false, toolbarClick: 'popup' }).title).toContain('robot sleeping');
  });

  it('sanitizes the click setting', () => {
    expect(sanitizeConfig({ toolbarClick: 'toggle' }).toolbarClick).toBe('toggle');
    expect(sanitizeConfig({ toolbarClick: 'launch-missiles' }).toolbarClick).toBe('popup');
    expect(sanitizeConfig({}).toolbarClick).toBe('popup');
  });
});
