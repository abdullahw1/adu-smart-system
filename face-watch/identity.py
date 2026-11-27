"""Face identity rules: per-camera face tracks -> known or new identities.

Pure logic (numpy only, no camera, model or database code) so it can be unit
tested and replayed. Faces arrive per frame as Face(box, score, embedding);
boxes are 0..1 fractions of the frame, embeddings are L2-normalised SFace
vectors (cosine similarity = dot product).

How a face gets a label:
  * Faces are tracked per camera by box overlap, and a track is judged on
    several frames together, never on one frame: one bad frame (hand over the
    face, looking down, motion blur) must not relabel a person.
  * A track is matched against every identity's gallery of samples. Matching
    may use any detected face; poor faces simply score low.
  * Only clear faces (high detector score, not cut off by the frame edge) are
    "quality" samples. Only they can create an identity or join a gallery, so
    galleries stay clean.
  * An unknown face gets a new id (face_0001, ...) once its track has
    new_min_samples quality samples that agree with each other. A face seen
    for a moment stays "Face" and creates nothing.

Tuned on the cam_03 recording (Nov 2026, one person, backlit, 640x360): the
same person's samples scored a median similarity of 0.45 overall but 0.59
when the detector score was >= 0.9 (1st percentile 0.28). OpenCV's published
SFace same-person threshold is 0.363.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Settings:
    min_face: float = 0.8           # faces scoring below this are ignored: on the recording, hands,
                                    # a phone and a hoodie logo scored 0.71-0.77, real faces 0.82+
    min_score: float = 0.9          # detector score for a quality sample
    edge_margin: float = 0.01       # quality faces lie this far (frame fraction) inside the frame
    min_width: float = 0.05         # ... and are at least this wide (32 px on a 640 px stream)
    match: float = 0.36             # track similarity to call it a known identity
    switch_margin: float = 0.08     # a labelled track changes identity only if another beats it by this
    new_min_samples: int = 3        # quality samples before an unknown face gets its own id
    new_consistency: float = 0.40   # median similarity among those samples
    grow_every: float = 2.0         # seconds between gallery additions from one track
    max_gallery: int = 40           # samples kept per identity (most redundant dropped first)
    track_iou: float = 0.2
    track_timeout: float = 1.5      # a track ends after this long unseen
    window: int = 6                 # recent samples a track is judged on


@dataclass
class Face:
    box: tuple[float, float, float, float]  # x1, y1, x2, y2 (fractions)
    score: float
    embedding: np.ndarray                    # normalised
    crop: object = None                      # aligned face image, kept for thumbnails
    key: str = ''                            # storage key for this sample, set by the caller


def is_quality(face: Face, s: Settings) -> bool:
    x1, y1, x2, y2 = face.box
    m = s.edge_margin
    return (face.score >= s.min_score and x2 - x1 >= s.min_width
            and x1 >= m and y1 >= m and x2 <= 1 - m and y2 <= 1 - m)


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def median_pairwise(vectors: list[np.ndarray]) -> float:
    m = np.array(vectors)
    sim = m @ m.T
    return float(np.median(sim[np.triu_indices(len(m), 1)])) if len(m) > 1 else 1.0


class Gallery:
    """Identities and their sample embeddings. Ids look like face_0001."""

    def __init__(self):
        self.samples: dict[str, np.ndarray] = {}  # id -> (n, d)
        self.keys: dict[str, list[str]] = {}      # id -> storage key of each row
        self.names: dict[str, str] = {}
        self.next_number = 1

    def load(self, identity: str, vectors: list[np.ndarray], name: str | None = None, keys: list[str] | None = None) -> None:
        if len(vectors):
            self.samples[identity] = np.array(vectors, dtype=np.float32)
            self.keys[identity] = list(keys or [''] * len(vectors))
        if name:
            self.names[identity] = name
        if identity.startswith('face_') and identity[5:].isdigit():
            self.next_number = max(self.next_number, int(identity[5:]) + 1)

    def new_id(self) -> str:
        identity = f'face_{self.next_number:04d}'
        self.next_number += 1
        return identity

    def label(self, identity: str) -> str:
        return self.names.get(identity) or identity

    def scores(self, probes: list[np.ndarray]) -> dict[str, float]:
        """Similarity of a set of probe faces to each identity: per probe the
        mean of its 3 best gallery matches, averaged over probes."""
        if not probes or not self.samples:
            return {}
        p = np.array(probes, dtype=np.float32)
        out = {}
        for identity, g in self.samples.items():
            sim = p @ g.T
            k = min(3, sim.shape[1])
            out[identity] = float(np.sort(sim, axis=1)[:, -k:].mean(axis=1).mean())
        return out

    def add(self, identity: str, vector: np.ndarray, max_size: int, key: str = '') -> str | None:
        """Adds a sample; when the gallery is full, drops the most redundant one
        and returns its key."""
        g = self.samples.get(identity)
        g = vector[None, :].astype(np.float32) if g is None else np.vstack([g, vector[None, :]])
        keys = self.keys.setdefault(identity, []) + [key]
        dropped = None
        if len(g) > max_size:  # drop the sample most similar to the others: keeps variety
            sim = g @ g.T
            np.fill_diagonal(sim, 0)
            index = int(np.argmax(sim.sum(axis=1)))
            g, dropped = np.delete(g, index, axis=0), keys.pop(index)
        self.samples[identity], self.keys[identity] = g, keys
        return dropped

    def remove(self, identity: str) -> None:
        self.samples.pop(identity, None)
        self.keys.pop(identity, None)
        self.names.pop(identity, None)


@dataclass
class Track:
    id: int
    box: tuple
    seen: float
    recent: list = field(default_factory=list)   # recent embeddings (any quality)
    quality: list = field(default_factory=list)  # recent quality Faces
    identity: str | None = None
    last_grow: float = -1e9


class Identifier:
    """Per-camera face tracks + the shared gallery. update() returns display
    objects; storage side effects are reported through `events`:
      ('new', identity, [Face, ...])  a new identity with its first samples
      ('add', identity, Face)         a sample joined an identity's gallery
      ('drop', identity, key)         a stored sample left a full gallery
      ('seen', identity, camera)      an identity was (re)confirmed on a camera
    """

    def __init__(self, gallery: Gallery | None = None, settings: Settings | None = None):
        self.gallery = gallery or Gallery()
        self.settings = settings or Settings()
        self.tracks: dict[str, list[Track]] = {}
        self.next_track = 1
        self.events: list[tuple] = []

    def update(self, camera: str, t: float, faces: list[Face]) -> list[dict]:
        s = self.settings
        tracks = [tr for tr in self.tracks.get(camera, []) if t - tr.seen <= s.track_timeout]
        free = list(tracks)
        objects = []
        for face in (f for f in faces if f.score >= s.min_face):
            best = max(free, key=lambda tr: iou(tr.box, face.box), default=None)
            if best is None or iou(best.box, face.box) < s.track_iou:
                best = Track(self.next_track, face.box, t)
                self.next_track += 1
                tracks.append(best)
            else:
                free.remove(best)
            best.box, best.seen = face.box, t
            best.recent = (best.recent + [face.embedding])[-s.window:]
            if is_quality(face, s):
                best.quality = (best.quality + [face])[-s.window:]
            self._decide(camera, t, best, face)
            objects.append(self._object(best))
        self.tracks[camera] = tracks
        return objects

    def _decide(self, camera: str, t: float, track: Track, face: Face) -> None:
        s = self.settings
        scores = self.gallery.scores(track.recent)
        if scores:
            best = max(scores, key=scores.get)
            current = scores.get(track.identity, -1.0) if track.identity else -1.0
            if scores[best] >= s.match and (track.identity is None or
                                            (best != track.identity and scores[best] >= current + s.switch_margin)):
                if track.identity != best:
                    self.events.append(('seen', best, camera))
                track.identity = best
        if track.identity is None and len(track.quality) >= s.new_min_samples:
            vectors = [f.embedding for f in track.quality]
            if median_pairwise(vectors) >= s.new_consistency:
                identity = self.gallery.new_id()
                for f in track.quality:
                    self.gallery.add(identity, f.embedding, s.max_gallery, f.key)
                track.identity, track.last_grow = identity, t
                self.events.append(('new', identity, list(track.quality)))
                self.events.append(('seen', identity, camera))
                return
        # Grow a known identity's gallery with this track's clear faces, now and then.
        if track.identity and is_quality(face, s) and t - track.last_grow >= s.grow_every:
            own = self.gallery.scores([face.embedding])
            if own and max(own, key=own.get) == track.identity and own[track.identity] >= s.match:
                dropped = self.gallery.add(track.identity, face.embedding, s.max_gallery, face.key)
                track.last_grow = t
                self.events.append(('add', track.identity, face))
                if dropped:
                    self.events.append(('drop', track.identity, dropped))

    def _object(self, track: Track) -> dict:
        x1, y1, x2, y2 = track.box
        caption = self.gallery.label(track.identity) if track.identity else 'Face'
        box = [round(max(0.0, v), 4) for v in (x1, y1, x2 - x1, y2 - y1)]
        return {'id': f'face-{track.id}', 'label': 'face', 'caption': caption, 'identity': track.identity,
                'score': 1.0, 'box': box}
