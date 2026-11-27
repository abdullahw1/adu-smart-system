import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A face library as face-watch/store.py writes it (same schema).
function library() {
  const dir = mkdtempSync(path.join(tmpdir(), 'faces-'));
  const db = new DatabaseSync(path.join(dir, 'faces.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE identities (id TEXT PRIMARY KEY, name TEXT, created REAL NOT NULL, last_seen REAL NOT NULL, last_camera TEXT, sightings INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE samples (key TEXT PRIMARY KEY, identity TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE, t REAL NOT NULL, camera TEXT, score REAL, embedding BLOB NOT NULL, source TEXT);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);`);
  let seed = 1;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const person = () => normalise(Float32Array.from({ length: 128 }, rand));
  const view = (base: Float32Array) => normalise(base.map(v => v + rand() * 0.12));
  const add = (id: string, base: Float32Array, n: number, t: number, name: string | null = null) => {
    db.prepare('INSERT INTO identities VALUES (?, ?, ?, ?, ?, ?)').run(id, name, t, t, 'cam_01', n);
    mkdirSync(path.join(dir, 'thumbs', id), { recursive: true });
    for (let i = 0; i < n; i++) {
      const key = `${t}-${id}-${i}`;
      db.prepare('INSERT INTO samples VALUES (?, ?, ?, ?, ?, ?, ?)').run(key, id, t + i, 'cam_01', 0.95, Buffer.from(view(base).buffer), 'camera');
      writeFileSync(path.join(dir, 'thumbs', id, key + '.jpg'), 'jpg');
    }
  };
  const version = () => Number((db.prepare("SELECT v FROM meta WHERE k='version'").get() as { v: string } | undefined)?.v ?? 0);
  return { dir, db, person, add, version };
}
function normalise(v: Float32Array) { const n = Math.hypot(...v); return v.map(x => x / n); }

test('lists, names, merges and finds duplicate faces', async () => {
  const lib = library();
  process.env.FACES_DIR = lib.dir;
  const faces = await import('../server/faces.mjs');
  const alice = lib.person(), bob = lib.person();
  lib.add('face_0001', alice, 5, 100);
  lib.add('face_0002', bob, 4, 200);
  lib.add('face_0003', alice, 3, 300); // Alice again, split into a second id

  const list = faces.listIdentities()!;
  assert.deepEqual(list.map(f => f.id), ['face_0003', 'face_0002', 'face_0001']); // most recent first
  assert.equal(list[2].keys.length, 5);
  assert.ok(faces.thumbnail('face_0001', list[2].keys[0]));
  assert.equal(faces.thumbnail('face_0001', '../../etc/passwd'), null);
  assert.equal(faces.thumbnail('../face_0001', 'x'), null);

  const pairs = faces.duplicates();
  assert.deepEqual(pairs.map(p => [p.a, p.b]), [['face_0001', 'face_0003']]); // only Alice's two ids
  assert.deepEqual(faces.duplicates(undefined, new Set([faces.pairKey('face_0003', 'face_0001')])), []);

  const before = lib.version();
  assert.equal(faces.setName('face_0003', '  Alice '), true);
  assert.ok(lib.version() > before, 'face-watch is told to reload');
  assert.equal(faces.setName('face_0003', 'x'.repeat(41)), false);

  assert.equal(faces.merge(['face_0003'], 'face_0001'), true);
  const merged = faces.listIdentities()!.find(f => f.id === 'face_0001')!;
  assert.equal(merged.name, 'Alice'); // the merged-in name is kept
  assert.equal(merged.samples, 8);
  assert.equal(merged.sightings, 8);
  assert.equal(merged.keys.length, 8); // photos moved too
  assert.equal(existsSync(path.join(lib.dir, 'thumbs', 'face_0003')), false);
  assert.equal(faces.merge(['face_0009'], 'face_0001'), false);
});

test('deletes photos, one face, several faces or all of them', async () => {
  const lib = library();
  process.env.FACES_DIR = lib.dir;
  const faces = await import('../server/faces.mjs');
  for (const [n, id] of ['face_0001', 'face_0002', 'face_0003', 'face_0004'].entries()) lib.add(id, lib.person(), 3, 100 + n);

  const key = faces.listIdentities()!.find(f => f.id === 'face_0004')!.keys[0];
  assert.equal(faces.forgetSamples('face_0004', [key, '../x']), 1);
  assert.equal(faces.listIdentities()!.find(f => f.id === 'face_0004')!.samples, 2);

  assert.equal(faces.forget(['face_0001']), 1);
  assert.equal(faces.forget(['face_0002', 'face_0003', 'bogus']), 2);
  assert.deepEqual(faces.listIdentities()!.map(f => f.id), ['face_0004']);
  assert.equal(faces.forget('all'), 1);
  assert.deepEqual(faces.listIdentities(), []);
  assert.deepEqual(readdirSync(path.join(lib.dir, 'thumbs')), []);
  assert.equal((lib.db.prepare('SELECT COUNT(*) AS n FROM samples').get() as { n: number }).n, 0);
});

test('reports no library before face-watch has run', async () => {
  process.env.FACES_DIR = mkdtempSync(path.join(tmpdir(), 'faces-none-'));
  const faces = await import('../server/faces.mjs');
  assert.equal(faces.listIdentities(), null);
  assert.deepEqual(faces.duplicates(), []);
  assert.equal(faces.forget('all'), 0);
});
