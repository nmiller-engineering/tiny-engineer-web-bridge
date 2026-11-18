import { describe, expect, it, vi } from 'vitest';
import { buildBaseUrl, buildRequest, DeviceClient, type DeviceTarget } from '../src/background/device-client';

const target: DeviceTarget = { host: '192.168.1.50', port: 80, token: '' };

function jsonResponse(status: number, body: unknown, init: Partial<ResponseInit> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' }, ...init });
}

describe('buildRequest', () => {
  it('builds the documented endpoints', () => {
    const post = buildRequest(target, 'anim-post', 'thinking');
    expect('url' in post && post.url).toBe('http://192.168.1.50/anim?name=thinking');
    expect('init' in post && post.init.method).toBe('POST');
    const get = buildRequest({ ...target, port: 8080 }, 'anim-get');
    expect('url' in get && get.url).toBe('http://192.168.1.50:8080/anim');
    expect('url' in get && get.init.method).toBe('GET');
    const health = buildRequest(target, 'health');
    expect('url' in health && health.url).toBe('http://192.168.1.50/health');
    const auth = buildRequest(target, 'auth');
    expect('url' in auth && auth.url).toBe('http://192.168.1.50/auth');
  });

  it('puts the token in the Authorization header only, never the URL, and not on /auth', () => {
    const t = { ...target, token: 's3cret' };
    const post = buildRequest(t, 'anim-post', 'ring');
    if (!('url' in post)) throw new Error('expected request');
    expect(post.url).not.toContain('s3cret');
    expect((post.init.headers as Record<string, string>).Authorization).toBe('Bearer s3cret');
    const auth = buildRequest(t, 'auth');
    if (!('url' in auth)) throw new Error('expected request');
    expect((auth.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('never follows redirects, sends no credentials or referrer', () => {
    const r = buildRequest(target, 'health');
    if (!('init' in r)) throw new Error('expected request');
    expect(r.init).toMatchObject({ redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  });

  it('rejects invalid targets and animations', () => {
    expect('error' in buildRequest({ ...target, host: 'evil.com/x?' }, 'health')).toBe(true);
    expect('error' in buildRequest({ ...target, host: 'a@b' }, 'health')).toBe(true);
    expect('error' in buildRequest({ ...target, port: 0 }, 'health')).toBe(true);
    expect('error' in buildRequest({ ...target, token: 'a\r\nb' }, 'health')).toBe(true);
    // @ts-expect-error — runtime guard against arbitrary names
    expect('error' in buildRequest(target, 'anim-post', 'none&evil=1')).toBe(true);
    expect('error' in buildBaseUrl({ ...target, host: '' })).toBe(true);
  });
});

describe('DeviceClient', () => {
  const make = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof DeviceClient>[0]> = {}) =>
    new DeviceClient({ fetch: fetchImpl, getTarget: () => target, timeoutMs: () => 50, ...extra });

  it('parses successful responses and only picks known fields', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, animation: 'typing', extra: 'x' }));
    const res = await make(fetchMock).setAnimation('typing');
    expect(res).toEqual({ ok: true, status: 200, data: { animation: 'typing' } });
  });

  it('maps HTTP errors', async () => {
    const cases: [number, string][] = [
      [401, 'unauthorized'],
      [503, 'not-provisioned'],
      [400, 'http'],
      [500, 'http'],
    ];
    for (const [status, kind] of cases) {
      const res = await make(async () => jsonResponse(status, { ok: false, error: 'x' })).getHealth();
      expect(res.ok === false && res.error).toBe(kind);
    }
  });

  it('reports redirects instead of following them', async () => {
    const res = await make(async () => new Response(null, { status: 302, headers: { Location: 'http://192.168.4.1/config' } })).getHealth();
    expect(res.ok === false && res.error).toBe('redirect');
  });

  it('rejects non-JSON answers', async () => {
    const res = await make(async () => new Response('<html>router login</html>', { status: 200 })).getHealth();
    expect(res.ok === false && res.error).toBe('bad-response');
  });

  it('times out', async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const res = await make(hang).getHealth();
    expect(res.ok === false && res.error).toBe('timeout');
  });

  it('reports network failures', async () => {
    const res = await make(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    }).getHealth();
    expect(res.ok === false && res.error).toBe('network');
  });

  it('refuses without host permission and without configuration', async () => {
    const fetchMock = vi.fn();
    const noPerm = await make(fetchMock as unknown as typeof fetch, { hasPermission: async () => false }).getHealth();
    expect(noPerm.ok === false && noPerm.error).toBe('no-permission');
    const unconfigured = await make(fetchMock as unknown as typeof fetch, { getTarget: () => null }).getHealth();
    expect(unconfigured.ok === false && unconfigured.error).toBe('not-configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes requests (firmware handles one at a time)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl: typeof fetch = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return jsonResponse(200, { ok: true, animation: 'none' });
    };
    const client = make(fetchImpl);
    await Promise.all([client.getHealth(), client.setAnimation('ring'), client.getAnimation(), client.getAuth()]);
    expect(maxInFlight).toBe(1);
  });
});
