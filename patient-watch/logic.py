"""Patient-watch rules: turns per-frame body and hand landmarks into captions.

Pure logic, no camera or model code, so it can be unit tested. All positions
are 0..1 fractions of the frame (x to the right, y downward).

What it reports for one camera:
  patient  - the body box, captioned "Patient moving" / "Patient still"
  gesture  - waving, a raised hand, or a held hand sign (open palm, thumbs
             down, ...). Gesture captions stay up for a few seconds after the
             gesture stops so a person glancing at the screen still sees them.
  alert    - the patient has been outside the marked zone (or out of view)
             for longer than leave_seconds.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

# MediaPipe Pose landmark indices used here.
NOSE, L_SHOULDER, R_SHOULDER, L_WRIST, R_WRIST, L_HIP, R_HIP = 0, 11, 12, 15, 16, 23, 24
TORSO = (L_SHOULDER, R_SHOULDER, L_HIP, R_HIP)

# MediaPipe Gesture Recognizer categories -> caption. "None" is ignored.
HAND_SIGNS = {
    'Open_Palm': 'Open hand - signalling',
    'Pointing_Up': 'Pointing up - signalling',
    'Thumb_Down': 'Thumbs down - may need help',
    'Thumb_Up': 'Thumbs up',
    'Victory': 'Two-finger sign',
    'ILoveYou': 'Hand sign',
    'Closed_Fist': 'Fist raised',
}
WAVE_CAPTION = 'Waving - may need help'
RAISED_CAPTION = 'Hand raised'


@dataclass
class Settings:
    wave_window: float = 2.0      # seconds of hand movement checked for a wave
    wave_reversals: int = 2       # direction changes needed (left-right-left = 2)
    wave_amplitude: float = 0.35  # swing needed, as a fraction of hand/shoulder size
    hold_seconds: float = 0.8     # a raised hand or hand sign must be held this long
    sticky_seconds: float = 3.0   # gesture captions stay up this long afterwards
    leave_seconds: float = 5.0    # out of zone this long -> alert
    move_threshold: float = 0.02  # mean landmark travel (frame fraction) over 0.5 s
    min_visibility: float = 0.5

    @classmethod
    def for_sensitivity(cls, level: str) -> 'Settings':
        level = (level or 'normal').lower()
        if level == 'high':
            return cls(wave_reversals=2, wave_amplitude=0.25, hold_seconds=0.5, leave_seconds=3.0, move_threshold=0.012)
        if level == 'low':
            return cls(wave_reversals=3, wave_amplitude=0.5, hold_seconds=1.2, leave_seconds=8.0, move_threshold=0.035)
        return cls()


@dataclass
class Body:
    # landmark index -> (x, y, visibility)
    landmarks: dict[int, tuple[float, float, float]]


@dataclass
class Hand:
    box: tuple[float, float, float, float]  # x1, y1, x2, y2
    sign: str | None = None                 # Gesture Recognizer category, if confident

    @property
    def centre(self) -> tuple[float, float]:
        return ((self.box[0] + self.box[2]) / 2, (self.box[1] + self.box[3]) / 2)

    @property
    def size(self) -> float:
        return max(self.box[2] - self.box[0], self.box[3] - self.box[1])


def reversals(xs: list[float], amplitude: float) -> int:
    """Count direction changes in a 1-D path, ignoring swings under amplitude."""
    if len(xs) < 3:
        return 0
    count, direction = 0, 0
    low = high = extreme = xs[0]
    for x in xs[1:]:
        if direction == 0:  # wait for the first real swing to set a direction
            low, high = min(low, x), max(high, x)
            if x - low >= amplitude:
                direction, extreme = 1, x
            elif high - x >= amplitude:
                direction, extreme = -1, x
        elif direction == 1:
            if x > extreme:
                extreme = x
            elif extreme - x >= amplitude:
                count, direction, extreme = count + 1, -1, x
        else:
            if x < extreme:
                extreme = x
            elif x - extreme >= amplitude:
                count, direction, extreme = count + 1, 1, x
    return count


def parse_zone(coordinates, width: int = 640, height: int = 360) -> list[tuple[float, float]]:
    """Frigate zone coordinates ("x1,y1,x2,y2,..." or a list) -> fractional polygon.
    Frigate 0.14+ stores fractions; older configs use detect-frame pixels."""
    if isinstance(coordinates, (list, tuple)):
        coordinates = ','.join(str(c) for c in coordinates)
    values = [float(v) for v in str(coordinates).replace(' ', '').split(',') if v]
    if len(values) < 6 or len(values) % 2:
        return []
    pixels = any(v > 1.0 for v in values)
    points = list(zip(values[0::2], values[1::2]))
    return [(x / width, y / height) if pixels else (x, y) for x, y in points]


def inside(point: tuple[float, float], polygon: list[tuple[float, float]]) -> bool:
    x, y = point
    result = False
    for (x1, y1), (x2, y2) in zip(polygon, polygon[1:] + polygon[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            result = not result
    return result


def to_box(x1: float, y1: float, x2: float, y2: float) -> list[float]:
    """x1,y1,x2,y2 -> app format [left, top, width, height], clamped to the frame."""
    x1, y1 = max(0.0, min(1.0, x1)), max(0.0, min(1.0, y1))
    x2, y2 = max(0.0, min(1.0, x2)), max(0.0, min(1.0, y2))
    return [round(x1, 4), round(y1, 4), round(max(0.0, x2 - x1), 4), round(max(0.0, y2 - y1), 4)]


@dataclass
class _Track:
    id: int
    points: deque = field(default_factory=lambda: deque(maxlen=60))  # (t, x, y)
    size: float = 0.05
    sign: str | None = None
    sign_since: float = 0.0
    seen: float = 0.0


class Watcher:
    def __init__(self, settings: Settings | None = None, zone: list[tuple[float, float]] | None = None, zone_name: str = ''):
        self.settings = settings or Settings()
        self.zone = zone or []
        self.zone_name = zone_name
        self.events: dict[str, dict] = {}           # key -> object + 'until'
        self.raised_since: dict[str, float] = {}
        self.wrists: dict[str, deque] = {'L': deque(maxlen=60), 'R': deque(maxlen=60)}
        self.hands: list[_Track] = []
        self.next_hand = 1
        self.body_history: deque = deque(maxlen=30)  # (t, {index: (x, y)})
        self.last_in_zone: float | None = None
        self.moving_until = 0.0  # "moving" holds a moment so the caption doesn't flicker

    def set_zone(self, zone: list[tuple[float, float]], name: str = '') -> None:
        self.zone, self.zone_name = zone, name

    # ---- per frame -------------------------------------------------------
    def update(self, t: float, body: Body | None, hands: list[Hand]) -> list[dict]:
        if self.last_in_zone is None:
            self.last_in_zone = t
        s = self.settings
        points = {}
        if body:
            points = {i: (x, y) for i, (x, y, v) in body.landmarks.items() if v >= s.min_visibility}
        objects = []
        if points:
            objects.append(self._patient(t, points))
            self._wrists(t, points)
        else:
            self.body_history.clear()
            self.raised_since.clear()
            for q in self.wrists.values():
                q.clear()
        self._hands(t, hands)
        objects += self._events(t)
        alert = self._zone(t, points)
        if alert:
            objects.append(alert)
        return objects

    # ---- body ------------------------------------------------------------
    def _patient(self, t: float, points: dict) -> dict:
        xs, ys = [p[0] for p in points.values()], [p[1] for p in points.values()]
        pad = 0.03
        self.body_history.append((t, points))
        old = [h for h in self.body_history if t - h[0] >= 0.5]
        if old:
            then = old[-1][1]
            shared = [i for i in points if i in then]
            if shared:
                travel = sum(math.dist(points[i], then[i]) for i in shared) / len(shared)
                if travel >= self.settings.move_threshold:
                    self.moving_until = t + 1.5
        moving = t <= self.moving_until
        return {'id': 'patient', 'label': 'patient', 'caption': 'Patient moving' if moving else 'Patient still', 'score': 1.0,
                'box': to_box(min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)}

    def _shoulder_width(self, points: dict) -> float:
        if L_SHOULDER in points and R_SHOULDER in points:
            return max(0.03, math.dist(points[L_SHOULDER], points[R_SHOULDER]))
        xs = [p[0] for p in points.values()]
        return max(0.03, (max(xs) - min(xs)) * 0.5)

    def _wrists(self, t: float, points: dict) -> None:
        s = self.settings
        ref = self._shoulder_width(points)
        for side, wrist, shoulder in (('L', L_WRIST, L_SHOULDER), ('R', R_WRIST, R_SHOULDER)):
            history = self.wrists[side]
            if wrist not in points:
                history.clear()
                self.raised_since.pop(side, None)
                continue
            x, y = points[wrist]
            history.append((t, x, y))
            self._check_wave(t, 'wave-' + side, history, ref)
            raised = shoulder in points and y < points[shoulder][1] - 0.15 * ref
            if not raised:
                self.raised_since.pop(side, None)
                continue
            since = self.raised_since.setdefault(side, t)
            if t - since >= s.hold_seconds:
                half = ref * 0.4
                self._event(t, 'raised-' + side, 'gesture', RAISED_CAPTION, to_box(x - half, y - half, x + half, y + half))

    # ---- hands -----------------------------------------------------------
    def _hands(self, t: float, hands: list[Hand]) -> None:
        s = self.settings
        unmatched = list(self.hands)
        for hand in hands:
            cx, cy = hand.centre
            best = min(unmatched, key=lambda tr: math.dist(tr.points[-1][1:], (cx, cy)), default=None)
            if best is None or math.dist(best.points[-1][1:], (cx, cy)) > 0.2:
                best = _Track(self.next_hand)
                self.next_hand += 1
                self.hands.append(best)
            else:
                unmatched.remove(best)
            best.points.append((t, cx, cy))
            best.size, best.seen = hand.size, t
            if hand.sign != best.sign:
                best.sign, best.sign_since = hand.sign, t
            key = f'hand-{best.id}'
            self._check_wave(t, 'wave-' + key, best.points, best.size)
            if best.sign in HAND_SIGNS and t - best.sign_since >= s.hold_seconds:
                self._event(t, key, 'gesture', HAND_SIGNS[best.sign], to_box(*hand.box))
        self.hands = [tr for tr in self.hands if t - tr.seen <= 0.5]

    def _check_wave(self, t: float, key: str, points, ref: float) -> None:
        s = self.settings
        recent = [p for p in points if t - p[0] <= s.wave_window]
        if len(recent) < 4:
            return
        amplitude = max(0.015, s.wave_amplitude * ref)
        if reversals([p[1] for p in recent], amplitude) >= s.wave_reversals:
            xs, ys = [p[1] for p in recent], [p[2] for p in recent]
            pad = ref * 0.5
            self._event(t, 'wave', 'gesture', WAVE_CAPTION, to_box(min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad))

    # ---- sticky gesture captions ----------------------------------------
    def _event(self, t: float, key: str, label: str, caption: str, box: list[float]) -> None:
        self.events[key] = {'id': key, 'label': label, 'caption': caption, 'score': 1.0, 'box': box, 'until': t + self.settings.sticky_seconds}

    def _events(self, t: float) -> list[dict]:
        self.events = {k: e for k, e in self.events.items() if e['until'] >= t}
        waving = 'wave' in self.events
        shown = [e for k, e in self.events.items() if not (waving and k != 'wave')]  # a wave says it all
        return [{k: v for k, v in e.items() if k != 'until'} for e in shown]

    # ---- zone ------------------------------------------------------------
    def _zone(self, t: float, points: dict) -> dict | None:
        centre = None
        if points:
            torso = [points[i] for i in TORSO if i in points] or list(points.values())
            centre = (sum(p[0] for p in torso) / len(torso), sum(p[1] for p in torso) / len(torso))
        if centre and (not self.zone or inside(centre, self.zone)):
            self.last_in_zone = t
            return None
        away = t - self.last_in_zone
        if away < self.settings.leave_seconds:
            return None
        if self.zone:
            xs, ys = [p[0] for p in self.zone], [p[1] for p in self.zone]
            box = to_box(min(xs), min(ys), max(xs), max(ys))
            name = self.zone_name.replace('_', ' ') or 'marked area'
            caption = f'Patient left the {name} ({int(away)}s)' if centre else f'Patient out of view ({int(away)}s)'
        else:
            box = to_box(0.01, 0.01, 0.99, 0.99)
            caption = f'Patient out of view ({int(away)}s)'
        return {'id': 'left-zone', 'label': 'alert', 'caption': caption, 'score': 1.0, 'box': box}
