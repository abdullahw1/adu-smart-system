"""Face library on disk: SQLite (identities + sample embeddings) and thumbnails.

  DATA/faces.sqlite
  DATA/thumbs/<identity>/<key>.jpg   aligned 112x112 face of each stored sample
  DATA/known/<Name>/*.jpg            optional: photos of people to enrol by name

Face data is biometric personal data. It stays on this machine (the data
folder is gitignored); unnamed identities not seen for RETAIN_DAYS are deleted
with their thumbnails, and `manage.py forget` removes one on request.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import time

import numpy as np

SCHEMA = """
CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY, name TEXT, created REAL NOT NULL, last_seen REAL NOT NULL,
  last_camera TEXT, sightings INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS samples (
  key TEXT PRIMARY KEY, identity TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  t REAL NOT NULL, camera TEXT, score REAL, embedding BLOB NOT NULL, source TEXT);
CREATE INDEX IF NOT EXISTS samples_identity ON samples(identity);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
"""


class Store:
    def __init__(self, folder: str):
        self.folder = folder
        os.makedirs(os.path.join(folder, 'thumbs'), exist_ok=True)
        self.db = sqlite3.connect(os.path.join(folder, 'faces.sqlite'), timeout=10, isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript(SCHEMA)

    # ---- change counter: the CLI bumps it, the service reloads -------------
    def version(self) -> int:
        row = self.db.execute("SELECT v FROM meta WHERE k='version'").fetchone()
        return int(row[0]) if row else 0

    def bump(self) -> None:
        self.db.execute("INSERT INTO meta(k, v) VALUES('version', '1') "
                        "ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1")

    # ---- reads ---------------------------------------------------------------
    def identities(self) -> list[dict]:
        rows = self.db.execute('SELECT i.id, i.name, i.created, i.last_seen, i.last_camera, i.sightings, '
                               'COUNT(s.key) FROM identities i LEFT JOIN samples s ON s.identity = i.id '
                               'GROUP BY i.id ORDER BY i.last_seen DESC').fetchall()
        keys = ('id', 'name', 'created', 'last_seen', 'last_camera', 'sightings', 'samples')
        return [dict(zip(keys, r)) for r in rows]

    def load_into(self, gallery) -> None:
        names = dict(self.db.execute('SELECT id, name FROM identities'))
        vectors: dict[str, list] = {i: [] for i in names}
        keys: dict[str, list] = {i: [] for i in names}
        for key, identity, blob in self.db.execute('SELECT key, identity, embedding FROM samples ORDER BY t'):
            vectors[identity].append(np.frombuffer(blob, dtype=np.float32))
            keys[identity].append(key)
        for identity in names:
            gallery.load(identity, vectors[identity], names[identity], keys[identity])
        row = self.db.execute("SELECT v FROM meta WHERE k='last_id'").fetchone()
        if row:
            gallery.next_number = max(gallery.next_number, int(row[0]) + 1)

    def thumb_path(self, identity: str, key: str) -> str:
        return os.path.join(self.folder, 'thumbs', identity, key + '.jpg')

    # ---- writes ----------------------------------------------------------------
    def add_identity(self, identity: str, t: float, name: str | None = None) -> None:
        self.db.execute('INSERT OR IGNORE INTO identities(id, name, created, last_seen) VALUES(?, ?, ?, ?)',
                        (identity, name, t, t))
        if identity.startswith('face_') and identity[5:].isdigit():  # ids are never reused, even after deletion
            self.db.execute("INSERT INTO meta(k, v) VALUES('last_id', ?) ON CONFLICT(k) DO UPDATE "
                            "SET v = MAX(CAST(v AS INTEGER), CAST(excluded.v AS INTEGER))", (int(identity[5:]),))

    def add_sample(self, identity: str, key: str, t: float, camera: str, score: float, embedding: np.ndarray,
                   crop=None, source: str = 'camera') -> None:
        try:
            self.db.execute('INSERT OR REPLACE INTO samples(key, identity, t, camera, score, embedding, source) '
                            'VALUES(?, ?, ?, ?, ?, ?, ?)',
                            (key, identity, t, camera, score, np.asarray(embedding, np.float32).tobytes(), source))
        except sqlite3.IntegrityError:
            return  # identity was just deleted (manage.py or the app); the service reloads within 2 s
        if crop is not None:
            import cv2  # only the service has OpenCV loaded; keeps this module light for tests
            path = self.thumb_path(identity, key)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            cv2.imwrite(path, crop, [cv2.IMWRITE_JPEG_QUALITY, 90])

    def drop_sample(self, identity: str, key: str) -> None:
        self.db.execute('DELETE FROM samples WHERE key = ?', (key,))
        try:
            os.remove(self.thumb_path(identity, key))
        except FileNotFoundError:
            pass

    def seen(self, identity: str, t: float, camera: str) -> None:
        self.db.execute('UPDATE identities SET last_seen = ?, last_camera = ?, sightings = sightings + 1 WHERE id = ?',
                        (t, camera, identity))

    def name(self, identity: str, name: str | None) -> bool:
        changed = self.db.execute('UPDATE identities SET name = ? WHERE id = ?', (name or None, identity)).rowcount
        self.bump()
        return bool(changed)

    def merge(self, source: str, target: str) -> bool:
        if source == target or not self.db.execute('SELECT 1 FROM identities WHERE id = ?', (target,)).fetchone():
            return False
        self.db.execute('BEGIN')
        moved = self.db.execute('UPDATE samples SET identity = ? WHERE identity = ?', (target, source)).rowcount
        self.db.execute('UPDATE identities SET sightings = sightings + COALESCE((SELECT sightings FROM identities WHERE id = ?), 0), '
                        'last_seen = MAX(last_seen, COALESCE((SELECT last_seen FROM identities WHERE id = ?), 0)) WHERE id = ?',
                        (source, source, target))
        self.db.execute('DELETE FROM identities WHERE id = ?', (source,))
        self.db.execute('COMMIT')
        src, dst = os.path.join(self.folder, 'thumbs', source), os.path.join(self.folder, 'thumbs', target)
        if os.path.isdir(src):
            os.makedirs(dst, exist_ok=True)
            for f in os.listdir(src):
                shutil.move(os.path.join(src, f), os.path.join(dst, f))
            os.rmdir(src)
        self.bump()
        return moved > 0

    def forget(self, identity: str) -> bool:
        gone = self.db.execute('DELETE FROM identities WHERE id = ?', (identity,)).rowcount
        shutil.rmtree(os.path.join(self.folder, 'thumbs', identity), ignore_errors=True)
        self.bump()
        return bool(gone)

    def expire(self, days: float, now: float | None = None) -> list[str]:
        """Deletes unnamed identities not seen for `days`. Returns their ids."""
        cutoff = (now or time.time()) - days * 86400
        old = [r[0] for r in self.db.execute('SELECT id FROM identities WHERE name IS NULL AND last_seen < ?', (cutoff,))]
        for identity in old:
            self.forget(identity)
        return old
