import { createServer } from 'node:http';
import next from 'next';
import { WebSocket, WebSocketServer } from 'ws';
import { configured, createUser, login, session, logout, sameOrigin, cookie } from './server/security.mjs';
import { db } from './server/store.mjs';
import { allowedStream, upstreamBase } from './server/cameras.mjs';

const dev = process.env.NODE_ENV !== 'production';
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || '127.0.0.1';
const app = next({ dev, hostname, port, conf: { distDir: process.env.NEXT_DIST_DIR || '.next' } });
await app.prepare();
const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();
const attempts = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

function localSetup(req) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const host = new URL('http://' + req.headers.host).hostname;
  return local && ['localhost', '127.0.0.1', '[::1]'].includes(host)
    && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] && !req.headers['tailscale-user-login'];
}
function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 8192) throw new Error('Request too large'); }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected an object');
  return parsed;
}
async function auth(req, res, pathname) {
  if (pathname === '/api/auth/session' && req.method === 'GET') return json(res, 200, { user: session(req.headers), configured: configured() });
  if (!sameOrigin(req.headers) && req.method !== 'GET' && !(pathname === '/api/auth/setup' && !configured() && localSetup(req) && req.headers.origin === 'http://' + req.headers.host)) return json(res, 403, { error: 'Invalid request origin' });
  if (pathname === '/api/auth/setup' && req.method === 'POST') {
    if (configured() || !localSetup(req)) return json(res, 403, { error: 'Owner setup is available only on this computer before an account exists.' });
    const { name, password } = await body(req);
    await createUser(name, password, 'admin', true);
    res.setHeader('Set-Cookie', cookie(await login(name, password)));
    return json(res, 201, { ok: true });
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const key = req.socket.remoteAddress;
    if (attempts.size > 1024) for (const [k, value] of attempts) if (value.until < Date.now()) attempts.delete(k);
    const previous = attempts.get(key);
    const attempt = previous?.until > Date.now() ? previous : { count: 0, until: Date.now() + 600_000 };
    if (attempt.count >= 10 || attempts.size > 1024) return json(res, 429, { error: 'Too many sign-in attempts. Try again in ten minutes.' });
    attempt.count++;
    attempts.set(key, attempt);
    const { name, password } = await body(req);
    const token = await login(name, password);
    if (!token) return json(res, 401, { error: 'Incorrect username or password' });
    attempts.delete(key);
    res.setHeader('Set-Cookie', cookie(token));
    return json(res, 200, { ok: true });
  }
  const user = session(req.headers);
  if (!user) return json(res, 401, { error: 'Sign in to continue' });
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    logout(req.headers);
    res.setHeader('Set-Cookie', cookie('', true));
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/auth/users' && user.role === 'admin') {
    if (req.method === 'GET') return json(res, 200, db().prepare('SELECT name,role FROM users ORDER BY name').all());
    if (req.method === 'POST') {
      const { name, password, role } = await body(req);
      await createUser(name, password, role);
      return json(res, 201, { ok: true });
    }
  }
  return json(res, 403, { error: 'Administrator access required' });
}

const server = createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/auth/')) return await auth(req, res, url.pathname);
    const publicPage = ['/login', '/setup'].includes(url.pathname) || url.pathname.startsWith('/_next/static/');
    if (!publicPage && !session(req.headers)) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/live/')) return json(res, 401, { error: 'Sign in to continue' });
      res.writeHead(303, { Location: configured() ? '/login' : '/setup', 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req.headers)) return json(res, 403, { error: 'Invalid request origin' });
    return await handle(req, res);
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: 'Request could not be completed. Check the input and try again.' });
    else res.end();
    console.error('Request failed:', error.code || error.name);
  }
});

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (dev && url.pathname.startsWith('/_next/') && sameOrigin(req.headers) && (session(req.headers) || localSetup(req))) return upgrade(req, socket, head);
    const user = session(req.headers);
    const src = url.searchParams.get('src') || '';
    if (!user || !sameOrigin(req.headers) || url.pathname !== '/live/ws' || !await allowedStream(src)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, client => {
      const target = new URL('/api/ws', upstreamBase());
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      target.searchParams.set('src', src);
      const upstream = new WebSocket(target, { handshakeTimeout: 5000 });
      const pending = [];
      let closed = false;
      const close = () => { if (closed) return; closed = true; clearInterval(expiry); client.close(); upstream.close(); };
      const expiry = setInterval(() => { if (!session(req.headers)) close(); }, 30_000);
      upstream.on('open', () => { for (const data of pending) upstream.send(data); pending.length = 0; });
      client.on('message', (data, binary) => {
        if (binary || !session(req.headers)) return close();
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type !== 'mse' || typeof msg.value !== 'string' || msg.value.length > 1024 || !/^[A-Za-z0-9.,]+$/.test(msg.value)) return close();
          const safe = JSON.stringify({ type: 'mse', value: msg.value });
          if (upstream.readyState === WebSocket.OPEN) upstream.send(safe);
          else if (pending.length < 2) pending.push(safe);
          else close();
        } catch { close(); }
      });
      upstream.on('message', (data, binary) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > 4 * 1024 * 1024) return close();
        if (!binary) {
          // Never pass upstream diagnostics containing camera URLs to a browser.
          try { const msg = JSON.parse(data.toString()); if (msg.type !== 'mse') return client.send(JSON.stringify({ type: 'error', value: 'Stream unavailable' })); }
          catch { return close(); }
        }
        client.send(data, { binary });
      });
      client.on('close', close); client.on('error', close);
      upstream.on('close', close); upstream.on('error', close);
    });
  } catch { socket.destroy(); }
});
server.listen(port, hostname, () => console.log(`ADU Cameras: http://${hostname}:${port}${configured() ? '' : '/setup'}`));
async function shutdown() { await globalThis.__aduRecorder?.shutdown(); wss.clients.forEach(client => client.terminate()); server.close(); await app.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
