import unittest

from logic import (L_SHOULDER, L_WRIST, R_SHOULDER, L_HIP, R_HIP, NOSE, RAISED_CAPTION, WAVE_CAPTION,
                   Body, Hand, Settings, Watcher, inside, parse_zone, reversals)


def body(cx=0.5, wrist=None, shift=0.0):
    """A seated person centred at cx; wrist=(x, y) overrides the left wrist."""
    lm = {NOSE: (cx, 0.2), L_SHOULDER: (cx + 0.1, 0.35), R_SHOULDER: (cx - 0.1, 0.35),
          L_HIP: (cx + 0.08, 0.7), R_HIP: (cx - 0.08, 0.7), L_WRIST: wrist or (cx + 0.12, 0.65)}
    return Body({i: (x + shift, y, 0.9) for i, (x, y) in lm.items()})


def run(watcher, frames, fps=10, start=0.0):
    out = []
    for n, (b, hands) in enumerate(frames):
        out = watcher.update(start + n / fps, b, hands)
    return out


def captions(objects):
    return {o['caption'] for o in objects}


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


class Gestures(unittest.TestCase):
    def test_wave_from_pose_wrist(self):
        w = Watcher(Settings.for_sensitivity('high'))
        path = [0.55, 0.65, 0.55, 0.65, 0.55, 0.65, 0.55, 0.65]
        out = run(w, [(body(wrist=(x, 0.15)), []) for x in path])
        self.assertIn(WAVE_CAPTION, captions(out))

    def test_wave_from_hand_detector_without_body(self):
        w = Watcher(Settings.for_sensitivity('high'))
        frames = [(None, [Hand((x, 0.3, x + 0.08, 0.42))]) for x in [0.4, 0.5, 0.4, 0.5, 0.4, 0.5]]
        self.assertIn(WAVE_CAPTION, captions(run(w, frames)))

    def test_raised_hand_needs_holding(self):
        w = Watcher(Settings(hold_seconds=0.8))
        up = (body(wrist=(0.6, 0.15)), [])
        self.assertNotIn(RAISED_CAPTION, captions(run(w, [up] * 3)))
        self.assertIn(RAISED_CAPTION, captions(run(w, [up] * 12)))

    def test_hand_sign_held_and_sticky(self):
        w = Watcher(Settings(hold_seconds=0.5, sticky_seconds=3.0))
        palm = [(body(), [Hand((0.3, 0.3, 0.4, 0.45), 'Open_Palm')])] * 8
        out = run(w, palm)
        self.assertIn('Open hand - signalling', captions(out))
        later = w.update(0.7 + 2.0, body(), [])  # hand gone 2 s later: still shown
        self.assertIn('Open hand - signalling', captions(later))
        gone = w.update(0.7 + 4.0, body(), [])
        self.assertNotIn('Open hand - signalling', captions(gone))

    def test_resting_hand_is_quiet(self):
        w = Watcher(Settings.for_sensitivity('high'))
        out = run(w, [(body(), [Hand((0.55, 0.6, 0.65, 0.72))])] * 30)
        self.assertEqual(captions(out), {'Patient still'})


class Patient(unittest.TestCase):
    def test_moving_vs_still(self):
        w = Watcher(Settings())
        self.assertEqual(captions(run(w, [(body(), [])] * 10)), {'Patient still'})
        moving = [(body(shift=0.01 * n), []) for n in range(10)]
        self.assertIn('Patient moving', captions(run(Watcher(Settings()), moving)))

    def test_leaving_zone_raises_alert_after_delay(self):
        zone = [(0.3, 0.1), (0.7, 0.1), (0.7, 0.9), (0.3, 0.9)]
        w = Watcher(Settings(leave_seconds=3.0), zone, 'bed')
        run(w, [(body(cx=0.5), [])] * 5)
        out = run(w, [(body(cx=0.9), [])] * 20, start=0.5)          # 2 s outside
        self.assertNotIn('alert', {o['label'] for o in out})
        out = run(w, [(body(cx=0.9), [])] * 20, start=2.5)          # 4 s outside
        alert = [o for o in out if o['label'] == 'alert']
        self.assertEqual(len(alert), 1)
        self.assertTrue(alert[0]['caption'].startswith('Patient left the bed'))
        self.assertEqual(run(w, [(body(cx=0.5), [])], start=5.0)[-1]['label'], 'patient')  # back: alert clears

    def test_out_of_view_without_zone(self):
        w = Watcher(Settings(leave_seconds=3.0))
        run(w, [(body(), [])])
        out = run(w, [(None, [])] * 40, start=0.1)
        self.assertTrue(any(o['caption'].startswith('Patient out of view') for o in out))


if __name__ == '__main__':
    unittest.main()
