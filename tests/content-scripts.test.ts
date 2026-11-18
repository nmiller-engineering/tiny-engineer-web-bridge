import { describe, expect, it } from 'vitest';
import { desiredRegistrations, expectedOrigin } from '../src/background/content-scripts';
import { cloneDefaultConfig } from '../src/shared/config';

describe('content-script registration', () => {
  it('registers only enabled platforms', () => {
    const c = cloneDefaultConfig();
    expect(desiredRegistrations(c, false).map((r) => r.platform)).toEqual(['chatgpt', 'claude']);
    c.platforms.claude = false;
    expect(desiredRegistrations(c, false).map((r) => r.platform)).toEqual(['chatgpt']);
    c.enabled = false;
    expect(desiredRegistrations(c, false)).toEqual([]);
  });

  it('registers Open WebUI only for its configured origin and after permission', () => {
    const c = cloneDefaultConfig();
    c.platforms.openwebui = true;
    c.platforms.openwebuiOrigin = 'http://192.168.1.20:3000';
    expect(desiredRegistrations(c, false).find((r) => r.platform === 'openwebui')).toBeUndefined();
    expect(desiredRegistrations(c, true).find((r) => r.platform === 'openwebui')).toMatchObject({ matches: ['http://192.168.1.20/*'], js: ['content/openwebui.js'] });
    expect(expectedOrigin('openwebui', c)).toBe('http://192.168.1.20:3000'); // exact, port included
    c.platforms.openwebuiOrigin = '';
    expect(expectedOrigin('openwebui', c)).toBeNull();
  });
});
