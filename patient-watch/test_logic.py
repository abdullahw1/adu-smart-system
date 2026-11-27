import unittest

from logic import (L_ELBOW, L_HIP, L_SHOULDER, L_WRIST, NOSE, R_HIP, R_SHOULDER, RAISED_CAPTION, WAVE_CAPTION,
                   Body, Hand, Settings, Watcher, inside, observe_body, observe_hands, parse_zone, reversals)


def body(cx=0.5, wrist=None, elbow=None, shift=0.0):
    """A seated person centred at cx; wrist/elbow=(x, y) override the left arm."""
    lm = {NOSE: (cx, 0.2), L_SHOULDER: (cx + 0.1, 0.35), R_SHOULDER: (cx - 0.1, 0.35),
          L_ELBOW: elbow or (cx + 0.14, 0.5), L_HIP: (cx + 0.08, 0.7), R_HIP: (cx - 0.08, 0.7),
          L_WRIST: wrist or (cx + 0.12, 0.65)}
    return Body({i: (x + shift, y, 0.9) for i, (x, y) in lm.items()})


def run(watcher, frames, fps=10, start=0.0):
    out = []
    for n, frame in enumerate(frames):  # (body, hands) or (body, hands, person boxes)
        out = watcher.update(start + n / fps, *frame)
    return out


def captions(objects):
    return {o['caption'] for o in objects}


def labels(objects):
    return {o['label'] for o in objects}


class Reversals(unittest.TestCase):
    def test_counts_real_swings_only(self):
        self.assertEqual(reversals([0.4, 0.5, 0.4, 0.5, 0.4], 0.05), 3)
        self.assertEqual(reversals([0.4, 0.41, 0.4, 0.41, 0.4], 0.05), 0)  # jitter
        self.assertEqual(reversals([0.1, 0.2, 0.3, 0.4], 0.05), 0)         # one long move


class Zones(unittest.TestCase):
    def test_parse_fractions_and_pixels(self):
        self.assertEqual(parse_zone('0.1,0.2,0.5,0.2,0.5,0.8'), [(0.1, 0.2), (0.5, 0.2), (0.5, 0.8)])
        self.assertEqual(parse_zone('64,36,320,36,320,180'), [(0.1, 0.1), (0.5, 0.1), (0.5, 0.5)])
        self.assertEqual(parse_zone('1,2'), [])

    def test_inside(self):
        square = [(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8)]
        self.assertTrue(inside((0.5, 0.5), square))
        self.assertFalse(inside((0.9, 0.5), square))


class Observations(unittest.TestCase):
    def raw(self, core_visibility):
        lm = [[0.5, 0.5, 0.9, 0.9] for _ in range(33)]
        for i in (NOSE, L_SHOULDER, R_SHOULDER):
            lm[i][2] = core_visibility
        return [{'lm': lm, 'seg': None}]

    def test_body_needs_clear_head_and_shoulders(self):
        self.assertIsNotNone(observe_body(self.raw(0.95), Settings()))
        self.assertIsNone(observe_body(self.raw(0.6), Settings()))

    def test_unsure_hands_and_signs_are_dropped(self):
        s = Settings()
        hands = observe_hands([{'box': [0, 0, .1, .1], 'sign': 'Open_Palm', 'sign_score': 0.6, 'hand_score': 0.9},
                               {'box': [0, 0, .1, .1], 'sign': 'Open_Palm', 'sign_score': 0.9, 'hand_score': 0.5}], s)
        self.assertEqual([h.sign for h in hands], [None])


class Presence(unittest.TestCase):
    def test_single_frame_ghosts_on_an_empty_chair_are_ignored(self):
        # Recorded case: the pose model "sees" a person in an empty chair in
        # about 1 frame in 10, with full confidence.
        w = Watcher(Settings(leave_seconds=3.0))
        frames = [(body() if n % 10 == 0 else None, []) for n in range(60)]
        out = run(w, frames)
        self.assertNotIn('patient', labels(out))
        self.assertTrue(any(o['caption'].startswith('Patient out of view') for o in out))

    def test_missed_frames_do_not_blink_a_seated_patient(self):
        w = Watcher(Settings())
        frames = [(None if n % 3 == 0 else body(), []) for n in range(40)]  # 67% detected
        for n, (b, _) in enumerate(frames):
            out = w.update(n / 10, b, [])
            if n >= 10:
                self.assertIn('patient', labels(out), n)


class PersonGate(unittest.TestCase):
    def test_pose_ghost_without_a_detected_person_is_ignored(self):
        # Recorded case (night, IR): the pose model held a "person" on a mouse
        # and cable for minutes; the person detector saw nobody.
        w = Watcher(Settings(leave_seconds=3.0))
        out = run(w, [(body(cx=0.85), [Hand((0.8, 0.8, 0.85, 0.85), 'Open_Palm')], [])] * 60)
        self.assertNotIn('patient', labels(out))
        self.assertNotIn('gesture', labels(out))
        self.assertTrue(any(o['caption'].startswith('Patient out of view') for o in out))

    def test_ghost_beside_a_real_person_is_ignored(self):
        w = Watcher(Settings(leave_seconds=3.0))
        out = run(w, [(body(cx=0.85), [], [(0.1, 0.05, 0.4, 0.9)])] * 60)
        self.assertNotIn('patient', labels(out))

    def test_confirmed_person_is_shown(self):
        w = Watcher(Settings())
        out = run(w, [(body(), [], [(0.3, 0.1, 0.7, 0.8)])] * 20)
        self.assertEqual(captions(out), {'Patient still'})


class Gestures(unittest.TestCase):
    def test_wave_from_hand_detector(self):
        w = Watcher(Settings())
        frames = [(body(), [Hand((x, 0.15, x + 0.08, 0.27))]) for x in [0.6, 0.7] * 5]
        self.assertIn(WAVE_CAPTION, captions(run(w, frames)))

    def test_jittery_pose_wrist_while_typing_is_not_a_wave(self):
        # Recorded case: pose wrists jump 5-10% of the frame while typing.
        w = Watcher(Settings())
        out = run(w, [(body(wrist=(x, 0.62)), []) for x in [0.55, 0.65] * 20])
        self.assertNotIn(WAVE_CAPTION, captions(out))
        self.assertEqual(labels(out), {'patient'})

    def test_glimpsed_hand_is_not_a_wave(self):
        w = Watcher(Settings())
        frames = [(body(), [Hand((x, 0.15, x + 0.08, 0.27))] if n % 3 == 0 else []) for n, x in enumerate([0.6, 0.7] * 12)]
        self.assertNotIn(WAVE_CAPTION, captions(run(w, frames)))

    def test_raised_hand_needs_holding(self):
        w = Watcher(Settings(hold_seconds=1.0))
        up = (body(wrist=(0.6, 0.1), elbow=(0.62, 0.25)), [])
        self.assertNotIn(RAISED_CAPTION, captions(run(Watcher(Settings(hold_seconds=1.0)), [up] * 10)))
        self.assertIn(RAISED_CAPTION, captions(run(w, [up] * 20)))

    def test_hand_at_chest_is_not_raised(self):
        w = Watcher(Settings(hold_seconds=0.5))
        out = run(w, [(body(wrist=(0.6, 0.4), elbow=(0.62, 0.5)), [])] * 30)
        self.assertNotIn(RAISED_CAPTION, captions(out))

    def test_hand_sign_held_and_sticky(self):
        w = Watcher(Settings(hold_seconds=1.0, sticky_seconds=3.0))
        palm = [(body(), [Hand((0.3, 0.3, 0.4, 0.45), 'Open_Palm')])] * 12
        out = run(w, palm)
        self.assertIn('Open hand - signalling', captions(out))
        later = w.update(1.1 + 2.0, body(), [])  # hand gone 2 s later: still shown
        self.assertIn('Open hand - signalling', captions(later))
        gone = w.update(1.1 + 4.0, body(), [])
        self.assertNotIn('Open hand - signalling', captions(gone))

    def test_resting_hand_is_quiet(self):
        w = Watcher(Settings())
        out = run(w, [(body(), [Hand((0.55, 0.6, 0.65, 0.72), 'Closed_Fist')])] * 30)
        self.assertEqual(captions(out), {'Patient still'})


class Patient(unittest.TestCase):
    def test_moving_vs_still(self):
        self.assertEqual(captions(run(Watcher(Settings()), [(body(), [])] * 15)), {'Patient still'})
        moving = [(body(shift=0.015 * n), []) for n in range(15)]
        self.assertIn('Patient moving', captions(run(Watcher(Settings()), moving)))

    def test_leaving_zone_raises_alert_after_delay(self):
        zone = [(0.3, 0.1), (0.7, 0.1), (0.7, 0.9), (0.3, 0.9)]
        w = Watcher(Settings(leave_seconds=3.0), zone, 'bed')
        run(w, [(body(cx=0.5), [])] * 10)
        out = run(w, [(body(cx=0.9), [])] * 20, start=1.0)          # 2 s outside
        self.assertNotIn('alert', labels(out))
        out = run(w, [(body(cx=0.9), [])] * 20, start=3.0)          # 4 s outside
        alert = [o for o in out if o['label'] == 'alert']
        self.assertEqual(len(alert), 1)
        self.assertTrue(alert[0]['caption'].startswith('Patient left the bed'))
        self.assertNotIn('alert', labels(run(w, [(body(cx=0.5), [])], start=5.0)))  # back: alert clears

    def test_out_of_view_without_zone(self):
        w = Watcher(Settings(leave_seconds=3.0))
        run(w, [(body(), [])] * 10)
        out = run(w, [(None, [])] * 50, start=1.0)
        self.assertTrue(any(o['caption'].startswith('Patient out of view') for o in out))


if __name__ == '__main__':
    unittest.main()
