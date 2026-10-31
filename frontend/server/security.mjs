import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './store.mjs';

const derive = promisify(scrypt);
export const COOKIE = 'adu_session';
const digest = value => createHash('sha256').update(value).digest('hex');
export const header = (headers, name) => typeof headers.get === 'function' ? headers.get(name) : headers[name.toLowerCase()];
export function configured() { return Boolean(db().prepare('SELECT name FROM users LIMIT 1').get()); }
export async function createUser(name, password, role, first = false) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name) || typeof password !== 'string' || password.length < 12 || password.length > 256 || !['admin', 'viewer'].includes(role)) {
    throw new Error('Use a username with letters, numbers, hyphens or underscores and a password of 12–256 characters.');
  }
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt, 64)).toString('hex');
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {
    if (first && configured()) throw new Error('Owner account already exists.');
    database.prepare('INSERT INTO users VALUES (?,?,?)').run(name, salt + ':' + hash, role);
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
export async function login(name, password) {
  if (typeof name !== 'string' || typeof password !== 'string' || password.length > 256) return null;
  const user = db().prepare('SELECT * FROM users WHERE name=?').get(name);
  // Do the expensive work even for unknown usernames.
  const [salt, expected] = (user?.hash || 'unknown:' + '0'.repeat(128)).split(':');
  const actual = await derive(password, salt, 64);
  if (!user || !timingSafeEqual(actual, Buffer.from(expected, 'hex'))) return null;
  const token = randomBytes(32).toString('hex');
  db().prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db().prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token), name, Date.now() + 12 * 3600_000);
  return token;
}
function tokenFrom(headers) {
  const cookie = header(headers, 'cookie') || '';
  return cookie.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
}
export function session(headers) {
  const token = tokenFrom(headers);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db().prepare('SELECT users.name,users.role FROM sessions JOIN users ON users.name=sessions.name WHERE token=? AND expires>?').get(digest(token), Date.now()) || null;
}
export function logout(headers) {
  const token = tokenFrom(headers);
  if (token) db().prepare('DELETE FROM sessions WHERE token=?').run(digest(token));
}
export function sameOrigin(headers) {
  const origin = header(headers, 'origin');
  if (!origin) return false;
  try {
    const expected = process.env.APP_ORIGIN;
    return expected ? new URL(origin).origin === new URL(expected).origin
      : new URL(origin).host === header(headers, 'host') && ['http:', 'https:'].includes(new URL(origin).protocol);
  } catch { return false; }
}
export function cookie(token, clear = false) {
  return `${COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 43200}${process.env.APP_ORIGIN?.startsWith('https:') ? '; Secure' : ''}`;
}
export async function authorize(request, role = 'viewer') {
  const user = session(request.headers);
  if (!user) return Response.json({ error: 'Sign in to continue' }, { status: 401 });
  if (role === 'admin' && user.role !== 'admin') return Response.json({ error: 'Administrator access required' }, { status: 403 });
  if (!['GET', 'HEAD'].includes(request.method) && !sameOrigin(request.headers)) return Response.json({ error: 'Invalid request origin' }, { status: 403 });
  return null;
}
