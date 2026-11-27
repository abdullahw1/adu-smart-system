"""Diagnostic recorder: saves raw model output (and small frames) for tuning.

Runs the same models as watch.py with permissive thresholds and writes one
JSON line per frame to OUT/observations.jsonl, plus OUT/frames/<ms>.jpg, so
rules can be replayed and tuned offline (see replay.py). Run it as a one-off
container next to the live service:

  docker run --rm --network host -v "$PWD/out:/out" -e SECONDS=300 \
    adu-smart-system-patient-watch python record.py
"""
import json
import os
import time

import cv2
import mediapipe as mp
import numpy as np

import watch
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision

OUT = os.environ.get('OUT', '/out')
SECONDS = float(os.environ.get('SECONDS', '300'))


def main():
    os.makedirs(os.path.join(OUT, 'frames'), exist_ok=True)
    base = lambda name: mp_tasks.BaseOptions(model_asset_path=os.path.join(watch.MODELS, name))  # noqa: E731
    pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=base('pose_landmarker_lite.task'), running_mode=vision.RunningMode.VIDEO, num_poses=2,
        min_pose_detection_confidence=0.3, min_pose_presence_confidence=0.3, min_tracking_confidence=0.3,
        output_segmentation_masks=True))
    gestures = vision.GestureRecognizer.create_from_options(vision.GestureRecognizerOptions(
        base_options=base('gesture_recognizer.task'), running_mode=vision.RunningMode.VIDEO, num_hands=2,
        min_hand_detection_confidence=0.3, min_hand_presence_confidence=0.3, min_tracking_confidence=0.3))
    people = vision.ObjectDetector.create_from_options(vision.ObjectDetectorOptions(
        base_options=base('efficientdet_lite2.tflite'), running_mode=vision.RunningMode.IMAGE,
        score_threshold=0.2, category_allowlist=['person'], max_results=4))
    reader = watch.LatestFrame(watch.SOURCE)
    reader.start()
    end, last, last_people = time.time() + SECONDS, 0.0, 0.0
    with open(os.path.join(OUT, 'observations.jsonl'), 'w') as out:
        while time.time() < end:
            frame, stamp = reader.latest()
            if frame is None or stamp == last:
                time.sleep(0.02)
                continue
            last = stamp
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            ms = int(stamp * 1000)
            pr = pose.detect_for_video(image, ms)
            gr = gestures.recognize_for_video(image, ms)
            bodies = []
            for i, lms in enumerate(pr.pose_landmarks or []):
                mask = pr.segmentation_masks[i].numpy_view() if pr.segmentation_masks else None
                xs, ys = [p.x for p in lms], [p.y for p in lms]
                seg = None
                if mask is not None:
                    h, w = mask.shape[:2]
                    x1, x2 = int(max(0, min(xs)) * w), int(min(1, max(xs)) * w)
                    y1, y2 = int(max(0, min(ys)) * h), int(min(1, max(ys)) * h)
                    region = mask[y1:max(y1 + 1, y2), x1:max(x1 + 1, x2)]
                    seg = round(float(np.mean(region)), 3) if region.size else 0.0
                bodies.append({'lm': [[round(p.x, 4), round(p.y, 4), round(p.visibility, 3), round(p.presence, 3)] for p in lms], 'seg': seg})
            hands = []
            for i, lms in enumerate(gr.hand_landmarks or []):
                xs, ys = [p.x for p in lms], [p.y for p in lms]
                g = gr.gestures[i][0] if gr.gestures and i < len(gr.gestures) and gr.gestures[i] else None
                hd = gr.handedness[i][0] if gr.handedness and i < len(gr.handedness) and gr.handedness[i] else None
                hands.append({'box': [round(min(xs), 4), round(min(ys), 4), round(max(xs), 4), round(max(ys), 4)],
                              'sign': g.category_name if g else None, 'sign_score': round(g.score, 3) if g else 0,
                              'hand_score': round(hd.score, 3) if hd else 0})
            row = {'t': round(stamp, 3), 'bodies': bodies, 'hands': hands}
            if stamp - last_people >= watch.PERSON_EVERY:  # as often as watch.py runs it
                last_people = stamp
                r = people.detect(image)
                h, w = frame.shape[:2]
                row['people'] = [[round(d.bounding_box.origin_x / w, 4), round(d.bounding_box.origin_y / h, 4),
                                  round((d.bounding_box.origin_x + d.bounding_box.width) / w, 4),
                                  round((d.bounding_box.origin_y + d.bounding_box.height) / h, 4), round(d.categories[0].score, 3)]
                                 for d in r.detections]
            out.write(json.dumps(row) + '\n')
            cv2.imwrite(os.path.join(OUT, 'frames', f'{ms}.jpg'), frame, [cv2.IMWRITE_JPEG_QUALITY, 80])  # full sub-stream size, so detectors can be re-run offline
            time.sleep(max(0.0, 0.1 - (time.time() - stamp)))


if __name__ == '__main__':
    main()
