import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const dir = await mkdtemp(path.join(os.tmpdir(), 'adu-security-'));
process.env.APP_DATA_DIR = dir;
await writeFile(path.join(dir, 'camera-names.json'), JSON.stringify({ cam_01: 'Existing name' }));
const { db, readSetting, writeSetting } = await import('../server/store.mjs');
const security = await import('../server/security.mjs');
after(async () => { db().close(); await rm(dir, { recursive: true, force: true }); });

test('legacy data is imported once and concurrent camera updates survive', async () => {
  assert.equal(readSetting('name:cam_01', ''), 'Existing name');
  await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => writeSetting('prefs:cam_' + i, { zone: 'UTC' }, true))));
  assert.equal(db().prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'prefs:%'").get()!.n, 50);
  writeSetting('prefs:cam_1', { flip: true }, true);
  assert.deepEqual(readSetting('prefs:cam_1'), { zone: 'UTC', flip: true });
  assert.equal((await stat(path.join(dir, 'app.sqlite'))).mode & 0o777, 0o600);
});
test('passwords are hashed, sessions revoke, roles and mutation origins are enforced', async () => {
  await security.createUser('owner', 'a-test-password-with-length', 'admin', true);
  await assert.rejects(security.createUser('another', 'a-test-password-with-length', 'admin', true));
  assert.equal(await security.login('owner', 'wrong'), null);
  const token = await security.login('owner', 'a-test-password-with-length');
  const headers = { cookie: 'adu_session=' + token };
  assert.equal(security.session(headers)?.role, 'admin');
  assert.ok(!String(db().prepare('SELECT hash FROM users WHERE name=?').get('owner')!.hash).includes('a-test-password'));
  assert.equal((await security.authorize(new Request('http://localhost/api/recordings')))?.status, 401);
  await security.createUser('guest', 'another-test-password', 'viewer');
  const viewer = await security.login('guest', 'another-test-password');
  const request = new Request('http://localhost/api/recordings', { method: 'POST', headers: { cookie: 'adu_session=' + viewer, host: 'localhost', origin: 'http://localhost' } });
  assert.equal((await security.authorize(request, 'admin'))?.status, 403);
  const forged = new Request('http://localhost/api/recordings', { method: 'POST', headers: { ...headers, host: 'localhost', origin: 'https://attacker.example' } });
  assert.equal((await security.authorize(forged, 'admin'))?.status, 403);
  security.logout(headers); assert.equal(security.session(headers), null);
});
