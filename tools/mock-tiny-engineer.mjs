#!/usr/bin/env node
/**
 * Mock Tiny Engineer HTTP server, modelled on upstream docs/api.md.
 *
 * Implements the endpoints the extension uses: GET /auth, GET /health,
 * GET /anim, POST /anim?name=…, including optional Bearer auth, 503 when not
 * provisioned, 400 for unknown animations, 404/405 and CORS headers.
 *
 * Used by the integration tests and for manual testing without hardware:
 *
 *   npm run mock-robot -- --port 8080 [--token secret] [--delay 0]
 *
 * then configure host 127.0.0.1, port 8080 in the extension.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const ANIMATIONS = ['none', 'typing', 'reading', 'thinking', 'talking', 'ring', 'welcome', 'attention', 'error', 'abort', 'dead', 'wakeup', 'sleep'];
const ONESHOT = new Set(['ring', 'welcome', 'abort', 'wakeup']);

/**
 * @param {{ token?: string, delayMs?: number, provisioned?: boolean, version?: string, oneshotMs?: number, quiet?: boolean }} [opts]
 */
export function createMockRobot(opts = {}) {
  const state = {
    token: opts.token ?? '',
    delayMs: opts.delayMs ?? 0,
    provisioned: opts.provisioned ?? true,
    version: opts.version ?? 'v0.3.0-mock',
    animation: 'none',
    /** @type {{ method: string, path: string, name: string | null, auth: 'none' | 'valid' | 'invalid', status: number, at: number }[]} */
    requests: [],
  };
  let oneshotTimer = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://robot.local');
    const header = req.headers.authorization;
    const auth = header === undefined ? 'none' : header === `Bearer ${state.token}` ? 'valid' : 'invalid';
    const send = (status, body) => {
      state.requests.push({ method: req.method ?? '', path: url.pathname, name: url.searchParams.get('name'), auth, status, at: Date.now() });
      if (!opts.quiet && opts.log) opts.log(`${req.method} ${url.pathname}${url.search} → ${status}`);
      const headers = { 'Content-Type': 'application/json' };
      if (req.headers.origin) {
        headers['Access-Control-Allow-Origin'] = '*';
        headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
        headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
      }
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    const respond = (status, body) => {
      if (state.delayMs > 0) setTimeout(() => send(status, body), state.delayMs);
      else send(status, body);
    };
    const tokenOk = state.token === '' || auth === 'valid';

    if (req.method === 'OPTIONS') return respond(200, { ok: true });

    switch (url.pathname) {
      case '/auth':
        if (req.method !== 'GET') return respond(405, { ok: false, error: 'method not allowed' });
        return respond(200, { ok: true, version: state.version, required: state.token !== '', wifi_configured: true, link_mode: 'wifi', provisioning: false });
      case '/health':
        if (req.method !== 'GET') return respond(405, { ok: false, error: 'method not allowed' });
        if (!tokenOk) return respond(401, { ok: false, error: 'unauthorized' });
        return respond(200, { ok: true, version: state.version, uptime_ms: 1234, wifi: { connected: true, ip: '127.0.0.1', rssi: -40, hostname: 'tiny-engineer.local' } });
      case '/anim': {
        if (req.method !== 'GET' && req.method !== 'POST') return respond(405, { ok: false, error: 'method not allowed' });
        if (!state.provisioned) return respond(503, { ok: false, error: 'not provisioned' });
        if (!tokenOk) return respond(401, { ok: false, error: 'unauthorized' });
        if (req.method === 'GET') return respond(200, { ok: true, animation: state.animation });
        const name = url.searchParams.get('name');
        if (name === null) return respond(400, { ok: false, error: 'missing name' });
        if (!ANIMATIONS.includes(name)) return respond(400, { ok: false, error: 'unknown animation' });
        state.animation = name;
        clearTimeout(oneshotTimer);
        if (ONESHOT.has(name)) oneshotTimer = setTimeout(() => (state.animation = 'none'), opts.oneshotMs ?? 2500);
        return respond(200, { ok: true, animation: name });
      }
      default:
        return respond(404, { ok: false, error: 'not found' });
    }
  });

  return {
    state,
    server,
    /** @param {number} [port] @param {string} [host] */
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() {
      clearTimeout(oneshotTimer);
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    /** POST /anim requests only. */
    animPosts() {
      return state.requests.filter((r) => r.method === 'POST' && r.path === '/anim');
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const robot = createMockRobot({ token: arg('token', ''), delayMs: Number(arg('delay', '0')), log: (l) => console.log(l) });
  const host = arg('host', '127.0.0.1');
  robot.listen(Number(arg('port', '8080')), host).then((port) => {
    console.log(`Mock Tiny Engineer listening on http://${host}:${port}/ ${robot.state.token ? '(token required)' : '(no auth)'}`);
  });
}
