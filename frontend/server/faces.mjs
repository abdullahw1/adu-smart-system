// The face library written by the face-watch service (../face-watch): browse,
// name, merge, delete and find duplicate identities.
//
// Shares face-watch's SQLite file (WAL, so both can use it at once) and its
// thumbnail folder. Every change bumps meta.version, which face-watch checks
// every 2 s to reload, so names and merges show in the live view right away.
// The schema belongs to face-watch/store.py; this module never creates it.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, renameSync, mkdirSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const ID_RE = /^face_\d{4,}$/;
export const KEY_RE = /^[\w.-]{1,80}$/;
export const NAME_MAX = 40;
// Same scoring as face-watch's Gallery.scores; 0.36 is the threshold it uses to
// call a face a known identity, so pairs above it would already be confusable.
export const DUPLICATE_THRESHOLD = 0.36;

export function facesDir() {
  return path.resolve(/* turbopackIgnore: true */ process.env.FACES_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), '..', 'runtime', 'faces'));
}

let database, openedFile;
function db() {
  const file = path.join(/* turbopackIgnore: true */ facesDir(), 'faces.sqlite');
  if (database && openedFile === file) return database;
  if (!existsSync(file)) return null; // face-watch hasn't run yet
  database = new DatabaseSync(file);
  openedFile = file;
  database.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  return database;
}

function bump(d) {
  d.prepare("INSERT INTO meta(k, v) VALUES('version', '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1").run();
}

function thumbsOf(id) { return path.join(/* turbopackIgnore: true */ facesDir(), 'thumbs', id); }

// ---- reads -----------------------------------------------------------------
export function listIdentities() {
  const d = db();
  if (!d) return null;
  const rows = d.prepare(`SELECT i.id, i.name, i.created, i.last_seen AS lastSeen, i.last_camera AS lastCamera,
      i.sightings, COUNT(s.key) AS samples FROM identities i LEFT JOIN samples s ON s.identity = i.id
      GROUP BY i.id ORDER BY i.last_seen DESC`).all();
  const keys = d.prepare('SELECT key FROM samples WHERE identity = ? ORDER BY t DESC');
  return rows.map(r => ({
    id: r.id, name: r.name || null, created: r.created * 1000, lastSeen: r.lastSeen * 1000, lastCamera: r.lastCamera || null,
    sightings: Number(r.sightings), samples: Number(r.samples),
    keys: keys.all(r.id).map(k => k.key).filter(k => existsSync(path.join(thumbsOf(r.id), k + '.jpg'))),
  }));
}

export function thumbnail(id, key) {
  if (!ID_RE.test(id) || !KEY_RE.test(key)) return null;
  try { return readFileSync(path.join(thumbsOf(id), key + '.jpg')); } catch { return null; }
}

// Pairs of identities that look like the same person, most alike first.
export function duplicates(threshold = DUPLICATE_THRESHOLD, dismissed = new Set()) {
  const d = db();
  if (!d) return [];
  const byId = new Map();
  for (const row of d.prepare('SELECT identity, embedding FROM samples').all()) {
    const bytes = row.embedding;
    const vector = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4).slice();
    (byId.get(row.identity) || byId.set(row.identity, []).get(row.identity)).push(vector);
  }
  const ids = [...byId.keys()];
  // Cheap filter first: identity centroids. Full scoring only for plausible pairs.
  const centroid = new Map(ids.map(id => [id, normalise(mean(byId.get(id)))]));
  const pairs = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i], ids[j]];
      if (dismissed.has(pairKey(a, b)) || dot(centroid.get(a), centroid.get(b)) < threshold - 0.15) continue;
      const score = (gallerySimilarity(byId.get(a), byId.get(b)) + gallerySimilarity(byId.get(b), byId.get(a))) / 2;
      if (score >= threshold) pairs.push({ a, b, score: Math.round(score * 1000) / 1000 });
    }
  }
  return pairs.sort((x, y) => y.score - x.score);
}

export function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

// Per probe, the mean of its 3 best matches in the gallery; averaged over probes.
export function gallerySimilarity(probes, gallery) {
  if (!probes.length || !gallery.length) return 0;
  const k = Math.min(3, gallery.length);
  let total = 0;
  for (const p of probes) {
    const sims = gallery.map(g => dot(p, g)).sort((x, y) => y - x);
    total += sims.slice(0, k).reduce((s, v) => s + v, 0) / k;
  }
  return total / probes.length;
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function mean(vectors) {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i] / vectors.length;
  return out;
}
function normalise(v) { const n = Math.sqrt(dot(v, v)) || 1; return v.map(x => x / n); }

// ---- writes ----------------------------------------------------------------
function known(d, ids) {
  const exists = d.prepare('SELECT 1 FROM identities WHERE id = ?');
  return ids.every(id => ID_RE.test(id) && exists.get(id));
}

export function setName(id, name) {
  const d = db();
  const clean = String(name ?? '').trim();
  if (!d || !ID_RE.test(id) || clean.length > NAME_MAX) return false;
  const changed = d.prepare('UPDATE identities SET name = ? WHERE id = ?').run(clean || null, id).changes;
  if (changed) bump(d);
  return changed > 0;
}

// Moves every sample of `sources` into `target`. The target keeps its name, or
// takes the first source name if it has none.
export function merge(sources, target) {
  const d = db();
  const from = [...new Set(sources)].filter(id => id !== target);
  if (!d || !from.length || !known(d, [target, ...from])) return false;
  d.exec('BEGIN IMMEDIATE');
  try {
    const names = from.map(id => d.prepare('SELECT name FROM identities WHERE id = ?').get(id)?.name).filter(Boolean);
    for (const id of from) {
      d.prepare('UPDATE samples SET identity = ? WHERE identity = ?').run(target, id);
      d.prepare(`UPDATE identities SET sightings = sightings + (SELECT sightings FROM identities WHERE id = ?),
          last_seen = MAX(last_seen, (SELECT last_seen FROM identities WHERE id = ?)),
          created = MIN(created, (SELECT created FROM identities WHERE id = ?)) WHERE id = ?`).run(id, id, id, target);
      d.prepare('DELETE FROM identities WHERE id = ?').run(id);
    }
    if (names.length) d.prepare('UPDATE identities SET name = COALESCE(name, ?) WHERE id = ?').run(names[0], target);
    bump(d);
    d.exec('COMMIT');
  } catch (error) { d.exec('ROLLBACK'); throw error; }
  const into = thumbsOf(target);
  mkdirSync(into, { recursive: true });
  for (const id of from) {
    const dir = thumbsOf(id);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) renameSync(path.join(dir, file), path.join(into, file));
    rmdirSync(dir);
  }
  return true;
}

// Deletes identities with their samples and photos. ids = 'all' clears the
// whole library (face ids are still never reused: meta.last_id stays).
export function forget(ids) {
  const d = db();
  if (!d) return 0;
  const list = ids === 'all' ? d.prepare('SELECT id FROM identities').all().map(r => r.id) : [...new Set(ids)].filter(id => ID_RE.test(id));
  let gone = 0;
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const id of list) gone += d.prepare('DELETE FROM identities WHERE id = ?').run(id).changes;
    bump(d);
    d.exec('COMMIT');
  } catch (error) { d.exec('ROLLBACK'); throw error; }
  for (const id of list) rmSync(thumbsOf(id), { recursive: true, force: true });
  return gone;
}

// Removes single photos that don't belong to an identity (a wrong match).
export function forgetSamples(id, keys) {
  const d = db();
  if (!d || !ID_RE.test(id)) return 0;
  let gone = 0;
  for (const key of keys) {
    if (!KEY_RE.test(key)) continue;
    gone += d.prepare('DELETE FROM samples WHERE identity = ? AND key = ?').run(id, key).changes;
    try { unlinkSync(path.join(thumbsOf(id), key + '.jpg')); } catch { /* already gone */ }
  }
  if (gone) bump(d);
  return gone;
}
