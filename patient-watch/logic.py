"""Patient-watch rules: turns per-frame body and hand landmarks into captions.

Pure logic, no camera or model code, so it can be unit tested and replayed
against recordings (record.py / replay.py). All positions are 0..1 fractions
of the frame (x to the right, y downward).

What it reports for one camera:
  patient  - the body box, captioned "Patient moving" / "Patient still"
  gesture  - waving, a raised hand, or a held hand sign (open palm, thumbs
             down, ...). Gesture captions stay up for a few seconds after the
             gesture stops so a person glancing at the screen still sees them.
  alert    - the patient has been outside the marked zone (or out of view)
             for longer than leave_seconds.

Tuned on a labelled recording of the cam_03 desk view (Nov 2026):
  * The pose model "sees" a person in an empty chair in single frames with
    full confidence, so presence is decided over a 2 s window, not per frame:
    a seated person is detected in 56-100% of frames, the empty chair in 6-43%.
  * Pose wrist points jitter by 5-10% of the frame while typing and were
    wrong during a real wave, so waves come only from the hand detector.
  * At night (IR) the pose model locked onto a mouse and cable on the desk
    with full confidence for minutes, so a hysteresis window is not enough:
    a pose body (and hand) only counts where a separate person detector
    (EfficientDet-Lite2, see watch.py) also sees a person. On the recording
    that detector scored 0.7-0.93 with the person in view and 0 on the empty
    chair; live, 0 on the empty room at night.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

# MediaPipe Pose landmark indices used here.
NOSE, L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW, L_WRIST, R_WRIST, L_HIP, R_HIP = 0, 11, 12, 13, 14, 15, 16, 23, 24
TORSO = (L_SHOULDER, R_SHOULDER, L_HIP, R_HIP)
CORE = (NOSE, L_SHOULDER, R_SHOULDER)  # reliably seen whenever a person really is in view
# Head and shoulders: steady points for judging whole-body movement (wrists jitter).
STEADY = (NOSE, 2, 5, 7, 8, L_SHOULDER, R_SHOULDER)

# MediaPipe Gesture Recognizer categories -> caption. "None" is ignored, and so
# are Closed_Fist / Victory / ILoveYou: resting and typing hands trigger them.
HAND_SIGNS = {
    'Open_Palm': 'Open hand - signalling',
    'Pointing_Up': 'Pointing up - signalling',
    'Thumb_Down': 'Thumbs down - may need help',
    'Thumb_Up': 'Thumbs up',
}
WAVE_CAPTION = 'Waving - may need help'
RAISED_CAPTION = 'Hand raised'


@dataclass
class Settings:
    # Presence: share of frames with a body over presence_window seconds.
    presence_window: float = 2.0
    enter_rate: float = 0.6       # becomes present at or above this
    exit_rate: float = 0.35       # becomes absent below this
    core_visibility: float = 0.8  # nose + both shoulders must be this visible
    # Waves (hand detector only).
    wave_window: float = 2.5      # seconds of hand movement checked for a wave
    wave_reversals: int = 3       # direction changes needed (left-right-left-right = 3)
    wave_amplitude: float = 0.6   # swing needed, as a fraction of the hand's size
    wave_min_swing: float = 0.03  # ... and at least this fraction of the frame
    wave_coverage: float = 0.6    # hand seen in at least this share of frames
    # Raised hand (pose) and hand signs.
    raise_margin: float = 0.3     # wrist above shoulder by this x shoulder width
    wrist_visibility: float = 0.8
    sign_score: float = 0.7
    hand_score: float = 0.7
    hold_seconds: float = 1.0     # a raised hand or hand sign must be held this long
    sticky_seconds: float = 3.0   # gesture captions stay up this long afterwards
    leave_seconds: float = 5.0    # out of zone this long -> alert
    move_threshold: float = 0.04  # head/shoulder travel (frame fraction) over 0.5 s; seated jitter ~0.01-0.03
    min_visibility: float = 0.5
    person_margin: float = 0.15   # person boxes are widened by this x their size when matching pose/hands

    @classmethod
    def for_sensitivity(cls, level: str) -> 'Settings':
        level = (level or 'normal').lower()
        if level == 'high':  # quicker, not looser: detector thresholds stay put
            return cls(hold_seconds=0.7, leave_seconds=3.0, move_threshold=0.03)
        if level == 'low':
            return cls(wave_reversals=4, hold_seconds=1.5, leave_seconds=8.0, move_threshold=0.06)
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


def observe_body(bodies: list[dict], settings: Settings) -> Body | None:
    """Raw pose output -> the patient's Body, or None.
    bodies: [{'lm': [[x, y, visibility, presence], ...33], 'seg': mask mean or None}]
    Only bodies whose head and shoulders are clearly seen count; of those the
    biggest is taken to be the patient."""
    best, best_area = None, -1.0
    for b in bodies:
        lm = b['lm']
        if len(lm) <= R_SHOULDER or min(lm[i][2] for i in CORE) < settings.core_visibility:
            continue
        xs, ys = [p[0] for p in lm], [p[1] for p in lm]
        area = (max(xs) - min(xs)) * (max(ys) - min(ys))
        if area > best_area:
            best, best_area = b, area
    if best is None:
        return None
    return Body({i: (p[0], p[1], p[2]) for i, p in enumerate(best['lm'])})


def observe_hands(hands: list[dict], settings: Settings) -> list[Hand]:
    """Raw gesture output -> confident Hands. hands: [{'box', 'sign', 'sign_score', 'hand_score'}]"""
    out = []
    for h in hands:
        if h.get('hand_score', 1.0) < settings.hand_score:
            continue
        sign = h.get('sign')
        if sign in (None, 'None') or h.get('sign_score', 0) < settings.sign_score:
            sign = None
        out.append(Hand(tuple(h['box']), sign))
    return out


def widen(box: tuple[float, float, float, float], margin: float) -> tuple[float, float, float, float]:
    x1, y1, x2, y2 = box
    dx, dy = (x2 - x1) * margin, (y2 - y1) * margin
    return x1 - dx, y1 - dy, x2 + dx, y2 + dy


def in_box(point: tuple[float, float], box: tuple[float, float, float, float]) -> bool:
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]


def confirm(body: Body | None, hands: list[Hand], people: list | None, settings: Settings) -> tuple[Body | None, list[Hand]]:
    """Keeps only the body and hands that lie inside a detected person.
    people: person boxes (x1, y1, x2, y2) from the person detector, or None
    when there is no detector (nothing is filtered then)."""
    if people is None:
        return body, hands
    boxes = [widen(tuple(b), settings.person_margin) for b in people]
    if body is not None:
        lm = body.landmarks
        neck = ((lm[L_SHOULDER][0] + lm[R_SHOULDER][0]) / 2, (lm[L_SHOULDER][1] + lm[R_SHOULDER][1]) / 2)
        if not any(in_box(lm[NOSE][:2], b) and in_box(neck, b) for b in boxes):
            body = None
    hands = [h for h in hands if any(in_box(h.centre, b) for b in boxes)]
    return body, hands


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
        self.hands: list[_Track] = []
        self.next_hand = 1
        self.frames: deque = deque()                 # (t, body seen) over presence_window
        self.present = False
        self.last_body: tuple[float, Body] | None = None
        self.body_history: deque = deque(maxlen=30)  # (t, {index: (x, y)})
        self.last_in_zone: float | None = None
        self.moving_until = 0.0  # "moving" holds a moment so the caption doesn't flicker

    def set_zone(self, zone: list[tuple[float, float]], name: str = '') -> None:
        self.zone, self.zone_name = zone, name

    # ---- per frame -------------------------------------------------------
    def update(self, t: float, body: Body | None, hands: list[Hand], people: list | None = None) -> list[dict]:
        """people: person boxes currently seen by the person detector (None = no detector)."""
        if self.last_in_zone is None:
            self.last_in_zone = t
        s = self.settings
        body, hands = confirm(body, hands, people, s)
        self._presence(t, body)
        # While present, a frame the model missed reuses the last body briefly,
        # so the box doesn't blink; while absent, stray detections are ignored.
        shown = None
        if self.present and self.last_body and t - self.last_body[0] <= 1.0:
            shown = self.last_body[1]
        points = {}
        if shown:
            points = {i: (x, y) for i, (x, y, v) in shown.landmarks.items() if v >= s.min_visibility}
        objects = []
        if points:
            objects.append(self._patient(t, points))
            if body is not None:
                self._raised(t, body)
        else:
            self.body_history.clear()
            self.raised_since.clear()
        self._hands(t, hands)
        objects += self._events(t)
        alert = self._zone(t, points)
        if alert:
            objects.append(alert)
        return objects

    def _presence(self, t: float, body: Body | None) -> None:
        s = self.settings
        if body is not None:
            self.last_body = (t, body)
        self.frames.append((t, body is not None))
        while self.frames and t - self.frames[0][0] > s.presence_window:
            self.frames.popleft()
        if len(self.frames) < 5:  # too little to judge yet
            return
        rate = sum(seen for _, seen in self.frames) / len(self.frames)
        if not self.present and rate >= s.enter_rate:
            self.present = True
        elif self.present and rate < s.exit_rate:
            self.present = False

    # ---- body ------------------------------------------------------------
    def _patient(self, t: float, points: dict) -> dict:
        xs, ys = [p[0] for p in points.values()], [p[1] for p in points.values()]
        pad = 0.03
        self.body_history.append((t, points))
        old = [h for h in self.body_history if t - h[0] >= 0.5]
        if old:
            then = old[-1][1]
            shared = [i for i in STEADY if i in points and i in then]
            if shared:
                travel = sum(math.dist(points[i], then[i]) for i in shared) / len(shared)
                if travel >= self.settings.move_threshold:
                    self.moving_until = t + 1.5
        moving = t <= self.moving_until
        return {'id': 'patient', 'label': 'patient', 'caption': 'Patient moving' if moving else 'Patient still', 'score': 1.0,
                'box': to_box(min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)}

    def _raised(self, t: float, body: Body) -> None:
        """A hand held clearly above the shoulder, with the elbow below it."""
        s = self.settings
        lm = body.landmarks
        ref = max(0.03, math.dist(lm[L_SHOULDER][:2], lm[R_SHOULDER][:2]))
        for side, wrist, elbow, shoulder in (('L', L_WRIST, L_ELBOW, L_SHOULDER), ('R', R_WRIST, R_ELBOW, R_SHOULDER)):
            w, e, sh = lm.get(wrist), lm.get(elbow), lm.get(shoulder)
            raised = (w and e and sh and w[2] >= s.wrist_visibility and e[2] >= s.min_visibility
                      and w[1] < sh[1] - s.raise_margin * ref and w[1] < e[1])
            if not raised:
                self.raised_since.pop(side, None)
                continue
            since = self.raised_since.setdefault(side, t)
            if t - since >= s.hold_seconds:
                half = ref * 0.4
                self._event(t, 'raised-' + side, 'gesture', RAISED_CAPTION, to_box(w[0] - half, w[1] - half, w[0] + half, w[1] + half))

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
            self._check_wave(t, best)
            if best.sign in HAND_SIGNS and t - best.sign_since >= s.hold_seconds:
                self._event(t, f'hand-{best.id}', 'gesture', HAND_SIGNS[best.sign], to_box(*hand.box))
        self.hands = [tr for tr in self.hands if t - tr.seen <= 0.5]

    def _check_wave(self, t: float, track: _Track) -> None:
        s = self.settings
        recent = [p for p in track.points if t - p[0] <= s.wave_window]
        frames = sum(1 for f in self.frames if t - f[0] <= s.wave_window) or len(recent)
        if len(recent) < 6 or len(recent) < s.wave_coverage * frames:
            return  # a hand glimpsed now and then can't be judged as waving
        amplitude = max(s.wave_min_swing, s.wave_amplitude * track.size)
        if reversals([p[1] for p in recent], amplitude) >= s.wave_reversals:
            xs, ys = [p[1] for p in recent], [p[2] for p in recent]
            pad = track.size * 0.6
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
