import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DEFAULT_MAPPING,
  deviceMatchPattern,
  normalizeOrigin,
  originToMatchPattern,
  sanitizeConfig,
  validateHost,
  validatePort,
  validateToken,
} from '../src/shared/config';

describe('validateHost', () => {
  it.each(['192.168.1.50', '10.0.0.1', '127.0.0.1', 'tiny-engineer.local', 'robot', 'my-robot.home.arpa', 'tiny-engineer.local.'])(
    'accepts %s',
    (h) => expect(validateHost(h)).toBeNull(),
  );

  it.each([
    ['', 'empty'],
    ['http://192.168.1.50', 'scheme'],
    ['192.168.1.50:80', 'port'],
    ['user:pw@192.168.1.50', 'credentials'],
    ['192.168.1.50/anim', 'path'],
    ['192.168.1.50#x', 'fragment'],
    ['192.168.1.50?x', 'query'],
    ['256.1.1.1', 'octet > 255'],
    ['1.2.3', 'ambiguous numeric'],
    ['0.0.0.0', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['[::1]', 'ipv6'],
    ['-bad.local', 'leading hyphen'],
    ['a b', 'whitespace'],
    ['evil.com\\@x', 'backslash'],
    ['x'.repeat(254), 'too long'],
  ])('rejects %s (%s)', (h) => expect(validateHost(h)).not.toBeNull());
});

describe('validatePort / validateToken', () => {
  it('validates ports', () => {
    expect(validatePort(80)).toBeNull();
    expect(validatePort(65535)).toBeNull();
    expect(validatePort(0)).not.toBeNull();
    expect(validatePort(65536)).not.toBeNull();
    expect(validatePort(80.5)).not.toBeNull();
  });

  it('allows visible ASCII tokens only (no header injection)', () => {
    expect(validateToken('')).toBeNull();
    expect(validateToken('abc-DEF_123.~!')).toBeNull();
    expect(validateToken('has space')).not.toBeNull();
    expect(validateToken('line\r\nX-Evil: 1')).not.toBeNull();
    expect(validateToken('ünicode')).not.toBeNull();
    expect(validateToken('x'.repeat(513))).not.toBeNull();
  });
});

describe('normalizeOrigin', () => {
  it('normalizes valid origins', () => {
    expect(normalizeOrigin(' http://192.168.1.20:3000/ ')).toEqual({ origin: 'http://192.168.1.20:3000' });
    expect(normalizeOrigin('https://c3po.home.arpa')).toEqual({ origin: 'https://c3po.home.arpa' });
    expect(normalizeOrigin('HTTP://C3PO.LOCAL:8080')).toEqual({ origin: 'http://c3po.local:8080' });
  });

  it.each([
    'ftp://x.local',
    'javascript:alert(1)',
    'http://user:pw@x.local',
    'http://x.local/path',
    'http://x.local/?q=1',
    'http://x.local/#frag',
    'https://chatgpt.com',
    'https://claude.ai/',
    'not a url',
    '',
    'http://[::1]:3000',
  ])('rejects %s', (o) => expect('error' in normalizeOrigin(o)).toBe(true));

  it('builds port-less match patterns', () => {
    expect(originToMatchPattern('http://192.168.1.20:3000')).toBe('http://192.168.1.20/*');
    expect(deviceMatchPattern('Tiny-Engineer.local.')).toBe('http://tiny-engineer.local/*');
  });
});

describe('sanitizeConfig', () => {
  it('returns defaults for garbage', () => {
    expect(sanitizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(sanitizeConfig('nope')).toEqual(DEFAULT_CONFIG);
    expect(sanitizeConfig([1, 2])).toEqual(DEFAULT_CONFIG);
  });

  it('keeps valid values and fixes invalid ones', () => {
    const cfg = sanitizeConfig({
      enabled: false,
      device: { host: ' 192.168.1.50 ', port: 8080, token: 'bad token', autoReconnect: false },
      platforms: { chatgpt: false, claude: true, openwebui: true, openwebuiOrigin: 'http://x.local:3000/' },
      mapping: { thinking: 'reading', responding: 'nonsense', completed: 'disabled' },
      timing: { debounceMs: 999_999, completionMs: 'x', staleMs: 6000 },
      arbitration: 'activity-priority',
      debugLogging: 'yes',
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.device).toEqual({ host: '192.168.1.50', port: 8080, token: '', autoReconnect: false });
    expect(cfg.platforms).toEqual({ chatgpt: false, claude: true, openwebui: true, openwebuiOrigin: 'http://x.local:3000' });
    expect(cfg.mapping.thinking).toBe('reading');
    expect(cfg.mapping.responding).toBe(DEFAULT_MAPPING.responding);
    expect(cfg.mapping.completed).toBe('disabled');
    expect(cfg.timing.debounceMs).toBe(5000); // clamped
    expect(cfg.timing.completionMs).toBe(2000); // default
    expect(cfg.timing.staleMs).toBe(6000);
    expect(cfg.arbitration).toBe('activity-priority');
    expect(cfg.debugLogging).toBe(false);
  });

  it('drops invalid hosts and disables Open WebUI without a valid origin', () => {
    const cfg = sanitizeConfig({ device: { host: 'http://evil' }, platforms: { openwebui: true, openwebuiOrigin: 'javascript:1' } });
    expect(cfg.device.host).toBe('');
    expect(cfg.platforms.openwebui).toBe(false);
  });

  it('uses the documented default timing and mapping', () => {
    expect(DEFAULT_CONFIG.timing).toMatchObject({ debounceMs: 300, minStableMs: 500, completionMs: 2000, requestTimeoutMs: 2000 });
    expect(DEFAULT_MAPPING).toEqual({
      idle: 'none',
      user_typing: 'disabled',
      thinking: 'thinking',
      responding: 'typing',
      tool_use: 'reading',
      completed: 'ring',
      error: 'error',
      unknown: 'none',
    });
  });
});
