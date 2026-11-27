import os
import tempfile
import unittest

import numpy as np

from identity import Face, Gallery, Identifier, Settings, is_quality
from store import Store

RNG = np.random.default_rng(7)


def person():
    v = RNG.normal(size=128)
    return v / np.linalg.norm(v)


def view(base, noise=0.6):
    """Another photo of the same person: similarity to base about 0.6-0.7."""
    v = base + RNG.normal(size=128) * noise / np.sqrt(128) * 1.6
    return v / np.linalg.norm(v)


def face(vec, score=0.95, box=(0.4, 0.2, 0.5, 0.4)):
    return Face(box, score, vec, None, f'k{RNG.integers(1e9)}')


def run(identifier, frames, camera='cam_03', fps=3, start=0.0):
    out = []
    for n, faces in enumerate(frames):
        out = identifier.update(camera, start + n / fps, faces)
    return out


class Quality(unittest.TestCase):
    def test_clear_vs_poor_faces(self):
        s = Settings()
        self.assertTrue(is_quality(face(person()), s))
        self.assertFalse(is_quality(face(person(), score=0.85), s))                    # unsure detection
        self.assertFalse(is_quality(face(person(), box=(0.4, 0.0, 0.5, 0.2)), s))     # cut off at the top
        self.assertFalse(is_quality(face(person(), box=(0.4, 0.2, 0.42, 0.25)), s))   # tiny


class NewFaces(unittest.TestCase):
    def test_unknown_face_gets_one_id_after_a_few_clear_views(self):
        ident, alice = Identifier(), person()
        out = run(ident, [[face(view(alice))]] * 2)
        self.assertEqual(out[0]['caption'], 'Face')  # not yet
        out = run(ident, [[face(view(alice))]] * 10, start=1)
        self.assertEqual(out[0]['caption'], 'face_0001')
        self.assertEqual(list(ident.gallery.samples), ['face_0001'])
        self.assertEqual([e[0] for e in ident.events if e[0] == 'new'], ['new'])

    def test_glimpse_or_poor_faces_create_nothing(self):
        ident = Identifier()
        run(ident, [[face(view(person()))]] * 2)                     # seen twice, then gone
        run(ident, [[face(view(person()), score=0.85)]] * 20, start=5)  # never clear
        self.assertEqual(ident.gallery.samples, {})

    def test_detections_below_min_face_are_ignored(self):
        # Recorded case: a hand, a phone and a hoodie logo scored 0.71-0.77.
        self.assertEqual(run(Identifier(), [[face(person(), score=0.75)]] * 10), [])

    def test_returning_person_is_recognised_at_once_even_from_a_poor_view(self):
        ident, alice = Identifier(), person()
        run(ident, [[face(view(alice))]] * 10)
        out = run(ident, [[face(view(alice), score=0.82)]], start=60)  # new track, unclear face
        self.assertEqual(out[0]['caption'], 'face_0001')

    def test_two_people_get_two_ids(self):
        ident, alice, bob = Identifier(), person(), person()
        a, b = (0.1, 0.2, 0.2, 0.4), (0.6, 0.2, 0.7, 0.4)
        out = run(ident, [[face(view(alice), box=a), face(view(bob), box=b)]] * 10)
        self.assertEqual(sorted(o['caption'] for o in out), ['face_0001', 'face_0002'])

    def test_stranger_is_not_given_a_known_name(self):
        gallery = Gallery()
        alice = person()
        gallery.load('face_0001', [view(alice) for _ in range(5)], 'Alice')
        out = run(Identifier(gallery), [[face(view(person()))]] * 10)
        self.assertNotIn('Alice', {o['caption'] for o in out})


class Tracks(unittest.TestCase):
    def test_one_bad_frame_does_not_relabel(self):
        gallery = Gallery()
        alice, bob = person(), person()
        gallery.load('face_0001', [view(alice) for _ in range(5)], 'Alice')
        gallery.load('face_0002', [view(bob) for _ in range(5)], 'Bob')
        ident = Identifier(gallery)
        frames = [[face(view(alice))]] * 6 + [[face(view(bob))]] + [[face(view(alice))]] * 2
        for n, faces in enumerate(frames):
            out = ident.update('cam_01', n / 3, faces)
            if n >= 1:
                self.assertEqual(out[0]['caption'], 'Alice', n)

    def test_gallery_is_capped_and_keeps_variety(self):
        g, alice = Gallery(), person()
        dropped = [g.add('face_0001', view(alice), 5, f'k{n}') for n in range(8)]
        self.assertEqual(len(g.samples['face_0001']), 5)
        self.assertEqual(len(g.keys['face_0001']), 5)
        self.assertEqual(sum(d is not None for d in dropped), 3)


class Library(unittest.TestCase):
    def test_store_round_trip_name_merge_forget_expire(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(folder)
            for identity in ('face_0001', 'face_0002', 'face_0003'):
                store.add_identity(identity, 100.0)
                store.add_sample(identity, identity + '-a', 100.0, 'cam_01', 0.95, person())
            v = store.version()
            self.assertTrue(store.name('face_0001', 'Alice'))
            self.assertGreater(store.version(), v)
            self.assertTrue(store.merge('face_0002', 'face_0001'))
            g = Gallery()
            store.load_into(g)
            self.assertEqual(g.label('face_0001'), 'Alice')
            self.assertEqual(len(g.samples['face_0001']), 2)
            self.assertNotIn('face_0002', g.samples)
            self.assertEqual(g.new_id(), 'face_0004')  # ids are never reused
            self.assertEqual(store.expire(days=1, now=100.0 + 2 * 86400), ['face_0003'])  # named ones stay
            self.assertEqual([r['id'] for r in store.identities()], ['face_0001'])
            self.assertTrue(store.forget('face_0001'))
            self.assertFalse(os.path.exists(os.path.join(folder, 'thumbs', 'face_0001')))
            g = Gallery()
            store.load_into(g)
            self.assertEqual(g.new_id(), 'face_0004')  # still not reused with every id deleted
            store.add_sample('face_0001', 'late', 200.0, 'cam_01', 0.95, person())  # deleted meanwhile: ignored
            self.assertEqual(store.db.execute('SELECT COUNT(*) FROM samples').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
