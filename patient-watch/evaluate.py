"""Scores the current models + rules end to end on a record.py recording.

  python evaluate.py REC_DIR LABELS.json [OUT_DIR]

Unlike replay.py (which reuses the recorded model output), this re-runs the
same models and thresholds as watch.py on the saved frames, so it measures the
version you are about to deploy. LABELS.json is hand-made from the footage:

  {"seated": [[2, 36], [66, 200]], "standing": [[36, 56]], "empty": [[56, 62]],
   "gestures": [[74, 77.5]]}

(seconds from the first frame; "standing" = in view but out of the chair,
scored for information only). Prints a scorecard and, with OUT_DIR, writes
OUT_DIR/annotated.mp4 with the captions drawn as the app shows them.
"""
import json
import os
import sys

import cv2
import mediapipe as mp

import watch
from logic import Settings, Watcher, observe_body, observe_hands
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision

COLOURS = {'patient': (10, 214, 255), 'gesture': (10, 159, 255), 'alert': (58, 69, 255)}  # BGR, as in globals.css


def within(t, spans):
    return any(a <= t < b for a, b in spans)


def main():
    folder, labels = sys.argv[1], json.load(open(sys.argv[2]))
    out_dir = sys.argv[3] if len(sys.argv) > 3 else None
    settings = Settings.for_sensitivity(os.environ.get('SENSITIVITY', watch.SENSITIVITY))
    pose, gestures = watch.models()
    people_model = vision.ObjectDetector.create_from_options(vision.ObjectDetectorOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=os.path.join(watch.MODELS, 'efficientdet_lite2.tflite')),
        running_mode=vision.RunningMode.IMAGE, score_threshold=watch.PERSON_SCORE, category_allowlist=['person'], max_results=4))

    names = sorted(os.listdir(os.path.join(folder, 'frames')), key=lambda n: int(n[:-4]))
    t0 = int(names[0][:-4]) / 1000
    watcher, seen, last_people, video, rows = Watcher(settings), [], -1.0, None, []
    for name in names:
        ms = int(name[:-4])
        t = ms / 1000
        frame = cv2.imread(os.path.join(folder, 'frames', name))
        if frame is None:
            continue
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        body = observe_body(watch.raw_bodies(pose.detect_for_video(image, ms)), settings)
        hands = observe_hands(watch.raw_hands(gestures.recognize_for_video(image, ms)), settings)
        if t - last_people >= watch.PERSON_EVERY:  # same cadence and memory as watch.PersonDetector
            last_people = t
            seen.append((t, watch.person_boxes(people_model, frame)))
        seen = [s for s in seen if t - s[0] <= watch.PERSON_MEMORY]
        objects = watcher.update(t, body, hands, [b for _, boxes in seen for b in boxes])
        rows.append((t - t0, objects))

        if out_dir:
            if video is None:
                os.makedirs(out_dir, exist_ok=True)
                h, w = frame.shape[:2]
                video = cv2.VideoWriter(os.path.join(out_dir, 'annotated.mp4'), cv2.VideoWriter_fourcc(*'mp4v'), 10, (w * 2, h * 2))
            big = cv2.resize(frame, None, fx=2, fy=2)
            H, W = big.shape[:2]
            for o in objects:
                x, y, bw, bh = o['box']
                colour = COLOURS.get(o['label'], (255, 255, 255))
                p1, p2 = (int(x * W), int(y * H)), (int((x + bw) * W), int((y + bh) * H))
                cv2.rectangle(big, p1, p2, colour, 2)
                cv2.putText(big, o['caption'], (p1[0] + 4, max(18, p1[1] + 18)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, colour, 2)
            truth = next((k for k in ('seated', 'standing', 'empty') if within(t - t0, labels.get(k, []))), '?')
            if within(t - t0, labels.get('gestures', [])):
                truth += ' + gesture'
            cv2.putText(big, f'{t - t0:6.1f}s  truth: {truth}', (10, H - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
            video.write(big)
    if video:
        video.release()
    score(rows, labels)


def score(rows, labels):
    def share(spans, test):
        picked = [objs for t, objs in rows if within(t, spans)]
        return (100.0 * sum(1 for o in picked if test(o)) / len(picked)) if picked else float('nan'), len(picked)

    has = lambda label: lambda objs: any(o['label'] == label for o in objs)  # noqa: E731
    gesture_spans = labels.get('gestures', [])
    padded = [[a - 1, b + settings_sticky()] for a, b in gesture_spans]  # captions may lag/linger
    print('                                     frames   result')
    for name, spans, label, want in (('Patient box while seated', labels.get('seated', []), 'patient', 'high'),
                                     ('Patient box while standing/walking', labels.get('standing', []), 'patient', 'info'),
                                     ('Patient box while room empty', labels.get('empty', []), 'patient', 'zero'),
                                     ('"Out of view" alert while seated', labels.get('seated', []), 'alert', 'zero'),
                                     ('"Out of view" alert while room empty', labels.get('empty', []), 'alert', 'info')):
        pct, n = share(spans, has(label))
        print(f'  {name:36} {n:5}   {pct:5.1f}%   (want {dict(high="~100%", zero="0%", info="-")[want]})')
    empty = labels.get('empty', [])
    for a, b in empty:
        first = next((t for t, objs in rows if a <= t < b + 10 and has('alert')(objs)), None)
        print(f'  Empty from {a:.0f}s: alert after ' + (f'{first - a:.1f}s' if first is not None else 'never'))
    false = [t for t, objs in rows if has('gesture')(objs) and not within(t, padded)]
    print(f'  Gesture captions outside real gestures: {len(false)} frames' + (f' (at {sorted({int(t) for t in false})} s)' if false else ''))
    for a, b in gesture_spans:
        hit = [o['caption'] for t, objs in rows if a - 1 <= t < b + 3 for o in objs if o['label'] == 'gesture']
        print(f'  Real gesture {a}-{b}s: ' + (f'detected ({", ".join(sorted(set(hit)))})' if hit else 'MISSED'))
    moving, n = share(labels.get('seated', []), lambda objs: any(o['caption'] == 'Patient moving' for o in objs))
    print(f'  Seated frames captioned "moving": {moving:.0f}% (no labels for this; check the video)')


def settings_sticky():
    return Settings().sticky_seconds


if __name__ == '__main__':
    main()
