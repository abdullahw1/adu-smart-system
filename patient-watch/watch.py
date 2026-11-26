"""Patient watch: gesture and zone captions for one camera (prototype).

Reads the camera's sub stream from the local go2rtc, runs MediaPipe Pose and
Gesture Recognizer on each frame (CPU), applies the rules in logic.py and
publishes the result over MQTT for the app's live view:

  adu/watch/<camera>         {"camera", "t", "objects": [...]}   up to 5x a second
  adu/watch/<camera>/status  online | no_video | offline          (retained; offline is the MQTT will)

The "patient zone" is drawn in Frigate's UI (Settings > Masks / Zones on the
camera) and read from Frigate's config every 30 s, so redrawing it needs no
restart. Without a zone, leaving the whole frame raises the alert.

Captions only: this sends no notifications and must not replace a nurse call.
"""
import json
import logging
import os
import threading
import time
import urllib.request

os.environ.setdefault('OPENCV_FFMPEG_CAPTURE_OPTIONS', 'rtsp_transport;tcp')
import cv2  # noqa: E402
import mediapipe as mp  # noqa: E402
import paho.mqtt.client as mqtt  # noqa: E402
from mediapipe.tasks import python as mp_tasks  # noqa: E402
from mediapipe.tasks.python import vision  # noqa: E402

from logic import Body, Hand, Settings, Watcher, parse_zone  # noqa: E402

CAMERA = os.environ.get('CAMERA', 'cam_03')
SOURCE = os.environ.get('SOURCE', f'rtsp://127.0.0.1:8554/{CAMERA}_sub')
MQTT_HOST = os.environ.get('MQTT_HOST', '127.0.0.1')
MQTT_PORT = int(os.environ.get('MQTT_PORT', '1883'))
FRIGATE_API = os.environ.get('FRIGATE_API', 'http://127.0.0.1:5000').rstrip('/')
ZONE_NAME = os.environ.get('PATIENT_ZONE', 'patient_area')
FPS = float(os.environ.get('FPS', '10'))
SENSITIVITY = os.environ.get('SENSITIVITY', 'high')
MODELS = os.environ.get('MODELS', '/models')
TOPIC = f'adu/watch/{CAMERA}'

log = logging.getLogger('patient-watch')


class LatestFrame(threading.Thread):
    """Reads the stream continuously and keeps only the newest frame, so slow
    processing never builds up a backlog (old frames = late captions)."""

    def __init__(self, url):
        super().__init__(daemon=True)
        self.url, self.frame, self.stamp = url, None, 0.0
        self.lock = threading.Lock()

    def run(self):
        while True:
            cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                log.warning('cannot open %s, retrying', self.url.split('@')[-1])
                time.sleep(3)
                continue
            log.info('video connected')
            while True:
                ok, frame = cap.read()
                if not ok:
                    log.warning('video stream ended, reconnecting')
                    break
                with self.lock:
                    self.frame, self.stamp = frame, time.time()
            cap.release()
            time.sleep(1)

    def latest(self):
        with self.lock:
            return self.frame, self.stamp


def fetch_zone():
    """Returns (polygon, name) for the patient zone from Frigate, or ([], '')."""
    try:
        with urllib.request.urlopen(FRIGATE_API + '/api/config', timeout=5) as res:
            camera = json.load(res).get('cameras', {}).get(CAMERA, {})
    except Exception as error:  # Frigate down: keep the previous zone
        log.debug('zone fetch failed: %s', error)
        return None
    zones = camera.get('zones') or {}
    if not zones:
        return [], ''
    name = ZONE_NAME if ZONE_NAME in zones else next(iter(zones))
    detect = camera.get('detect') or {}
    return parse_zone(zones[name].get('coordinates', ''), detect.get('width') or 640, detect.get('height') or 360), name


def models(settings_level):
    confidence = 0.3 if settings_level == 'high' else 0.5
    base = lambda name: mp_tasks.BaseOptions(model_asset_path=os.path.join(MODELS, name))  # noqa: E731
    pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=base('pose_landmarker_lite.task'), running_mode=vision.RunningMode.VIDEO, num_poses=2,
        min_pose_detection_confidence=confidence, min_pose_presence_confidence=confidence, min_tracking_confidence=confidence))
    gestures = vision.GestureRecognizer.create_from_options(vision.GestureRecognizerOptions(
        base_options=base('gesture_recognizer.task'), running_mode=vision.RunningMode.VIDEO, num_hands=2,
        min_hand_detection_confidence=confidence, min_hand_presence_confidence=confidence, min_tracking_confidence=confidence))
    return pose, gestures


def largest_body(result):
    """The patient is taken to be the biggest person in view."""
    best, best_area = None, 0.0
    for landmarks in result.pose_landmarks or []:
        xs, ys = [p.x for p in landmarks], [p.y for p in landmarks]
        area = (max(xs) - min(xs)) * (max(ys) - min(ys))
        if area > best_area:
            best, best_area = landmarks, area
    if best is None:
        return None
    return Body({i: (p.x, p.y, p.visibility) for i, p in enumerate(best)})


def hands_from(result):
    hands = []
    for i, landmarks in enumerate(result.hand_landmarks or []):
        xs, ys = [p.x for p in landmarks], [p.y for p in landmarks]
        sign = None
        if result.gestures and i < len(result.gestures) and result.gestures[i]:
            top = result.gestures[i][0]
            if top.category_name != 'None' and top.score >= 0.5:
                sign = top.category_name
        hands.append(Hand((min(xs), min(ys), max(xs), max(ys)), sign))
    return hands


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    settings = Settings.for_sensitivity(SENSITIVITY)
    watcher = Watcher(settings)
    pose, gestures = models(SENSITIVITY)

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f'patient-watch-{CAMERA}')
    client.will_set(TOPIC + '/status', 'offline', retain=True)
    status = {'value': None}

    def set_status(value):
        if status['value'] != value:
            status['value'] = value
            client.publish(TOPIC + '/status', value, retain=True)
            log.info('status %s', value)

    client.on_connect = lambda c, u, f, rc, p=None: (status.update(value=None), set_status('online'))
    client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=10)
    client.loop_start()

    reader = LatestFrame(SOURCE)
    reader.start()

    interval = 1.0 / FPS
    last_zone_fetch = last_publish = last_stats = 0.0
    last_payload, last_stamp, frames, captions = None, 0.0, 0, {}
    log.info('watching %s at %.0f fps, sensitivity %s', CAMERA, FPS, SENSITIVITY)
    while True:
        start = time.time()
        if start - last_zone_fetch > 30:
            last_zone_fetch = start
            zone = fetch_zone()
            if zone is not None and (zone[0] != watcher.zone or zone[1] != watcher.zone_name):
                watcher.set_zone(*zone)
                log.info('patient zone: %s', zone[1] or 'none (whole frame)')

        frame, stamp = reader.latest()
        if frame is None or start - stamp > 3:
            set_status('no_video')
            time.sleep(0.5)
            continue
        set_status('online')
        if stamp == last_stamp:  # no new frame yet
            time.sleep(0.02)
            continue
        last_stamp = stamp

        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        ms = int(stamp * 1000)
        body = largest_body(pose.detect_for_video(image, ms))
        hands = hands_from(gestures.recognize_for_video(image, ms))
        objects = watcher.update(stamp, body, hands)
        frames += 1

        # Log caption changes: a simple record of what was shown and when.
        now_captions = {o['id']: o['caption'] for o in objects if o['label'] != 'patient'}
        for key, caption in now_captions.items():
            if captions.get(key, '').split(' (')[0] != caption.split(' (')[0]:
                log.info('caption: %s', caption)
        captions = now_captions

        payload = json.dumps({'camera': CAMERA, 't': round(stamp, 3), 'objects': objects})
        if start - last_publish >= 0.2 and (payload != last_payload or start - last_publish >= 1.0):
            client.publish(TOPIC, payload)
            last_publish, last_payload = start, payload

        if start - last_stats >= 60:
            if last_stats:
                log.info('%.1f fps processed', frames / (start - last_stats))
            last_stats, frames = start, 0
        time.sleep(max(0.0, interval - (time.time() - start)))


if __name__ == '__main__':
    main()
