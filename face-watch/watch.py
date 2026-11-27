"""Face watch: recognises faces on every camera against a local face library.

Reads each camera's sub stream from go2rtc, finds faces (YuNet), turns each
into an embedding (SFace) and applies identity.py: known faces get their name
or id, unknown faces get a new id (face_0001, ...) once seen clearly a few
times. Results go over MQTT for the app's live view:

  adu/faces/<camera>   {"camera", "t", "objects": [{"id", "label": "face", "caption", "identity", "box"}]}
  adu/faces/status     online | offline   (retained; offline is the MQTT will)

The library lives in DATA (see store.py). Name or merge ids with manage.py;
photos in DATA/known/<Name>/ are enrolled under that name at start-up and
whenever that folder changes.
"""
import hashlib
import json
import logging
import os
import threading
import time

os.environ.setdefault('OPENCV_FFMPEG_CAPTURE_OPTIONS', 'rtsp_transport;tcp')
import cv2  # noqa: E402
import paho.mqtt.client as mqtt  # noqa: E402

from identity import Gallery, Identifier, Settings  # noqa: E402
from models import FaceModels  # noqa: E402
from store import Store  # noqa: E402

CAMERAS = [c.strip() for c in os.environ.get('CAMERAS', 'cam_01,cam_02,cam_03,cam_04').split(',') if c.strip()]
SOURCE = os.environ.get('SOURCE', 'rtsp://127.0.0.1:8554/{camera}_sub')  # {camera} is replaced
MQTT_HOST = os.environ.get('MQTT_HOST', '127.0.0.1')
MQTT_PORT = int(os.environ.get('MQTT_PORT', '1883'))
FPS = float(os.environ.get('FACE_FPS', '3'))  # per camera
DATA = os.environ.get('DATA', '/data')
RETAIN_DAYS = float(os.environ.get('RETAIN_DAYS', '30'))
TOPIC = 'adu/faces'

log = logging.getLogger('face-watch')


class LatestFrame(threading.Thread):
    """Keeps only the newest frame of a stream, reconnecting as needed."""

    def __init__(self, url):
        super().__init__(daemon=True)
        self.url, self.frame, self.stamp = url, None, 0.0
        self.lock = threading.Lock()

    def run(self):
        while True:
            cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                time.sleep(5)
                continue
            log.info('video connected: %s', self.url.rsplit('/', 1)[-1])
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                with self.lock:
                    self.frame, self.stamp = frame, time.time()
            cap.release()
            log.warning('video lost: %s', self.url.rsplit('/', 1)[-1])
            time.sleep(2)

    def latest(self):
        with self.lock:
            return self.frame, self.stamp


def enrol_known(store, models, gallery):
    """Enrols DATA/known/<Name>/*.jpg|png under <Name>. Each photo is enrolled once."""
    folder = os.path.join(store.folder, 'known')
    if not os.path.isdir(folder):
        return 0
    have = {r[0] for r in store.db.execute("SELECT source FROM samples WHERE source LIKE 'known:%'")}
    ids = {r['name']: r['id'] for r in store.identities() if r['name']}
    added = 0
    for name in sorted(os.listdir(folder)):
        person = os.path.join(folder, name)
        if not os.path.isdir(person):
            continue
        for file in sorted(os.listdir(person)):
            source = f'known:{name}/{file}'
            if source in have or not file.lower().endswith(('.jpg', '.jpeg', '.png')):
                continue
            image = cv2.imread(os.path.join(person, file))
            face = models.largest(image) if image is not None else None
            if face is None:
                log.warning('no face found in %s', source)
                continue
            identity = ids.get(name)
            if identity is None:
                identity = ids[name] = gallery.new_id()
                store.add_identity(identity, time.time(), name)
            key = 'known-' + hashlib.sha1(source.encode()).hexdigest()[:12]
            store.add_sample(identity, key, time.time(), '', face.score, face.embedding, face.crop, source)
            added += 1
    if added:
        log.info('enrolled %d known photo(s)', added)
        store.bump()
    return added


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    store = Store(DATA)
    models = FaceModels()
    settings = Settings()

    def fresh_identifier():
        gallery = Gallery()
        store.load_into(gallery)
        return gallery

    identifier = Identifier(fresh_identifier(), settings)
    enrol_known(store, models, identifier.gallery)
    identifier.gallery = fresh_identifier()
    loaded_version = store.version()
    log.info('face library: %d identities', len(identifier.gallery.samples))

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id='face-watch')
    client.will_set(TOPIC + '/status', 'offline', retain=True)
    client.on_connect = lambda c, u, f, rc, p=None: c.publish(TOPIC + '/status', 'online', retain=True)
    client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=10)
    client.loop_start()

    readers = {cam: LatestFrame(SOURCE.format(camera=cam)) for cam in CAMERAS}
    for reader in readers.values():
        reader.start()
    last_done = {cam: 0.0 for cam in CAMERAS}
    last_publish = {cam: (0.0, None) for cam in CAMERAS}
    last_check = last_expire = last_stats = 0.0
    known_mtime, processed = None, 0
    log.info('watching %s at %.0f fps each', ', '.join(CAMERAS), FPS)
    while True:
        now = time.time()
        if now - last_check >= 2:  # names/merges from manage.py, new photos in known/
            last_check = now
            known = os.path.join(DATA, 'known')
            mtime = max((os.stat(os.path.join(r, d)).st_mtime for r, ds, _ in os.walk(known) for d in ds + ['.']), default=None) \
                if os.path.isdir(known) else None
            if mtime != known_mtime:
                known_mtime = mtime
                enrol_known(store, models, identifier.gallery)
            if store.version() != loaded_version:
                loaded_version = store.version()
                identifier.gallery = fresh_identifier()
                for tracks in identifier.tracks.values():  # renamed: shows at once; merged/forgotten: re-identify
                    for track in tracks:
                        if track.identity not in identifier.gallery.samples:
                            track.identity = None
                log.info('face library reloaded: %d identities', len(identifier.gallery.samples))
        if now - last_expire >= 3600:
            last_expire = now
            gone = store.expire(RETAIN_DAYS, now)
            if gone:
                log.info('expired %d unnamed identities not seen for %g days', len(gone), RETAIN_DAYS)

        busy = False
        for cam, reader in readers.items():
            frame, stamp = reader.latest()
            if frame is None or stamp <= last_done[cam] or now - last_done[cam] < 1 / FPS:
                if frame is None or now - stamp > 3:  # no video: clear the camera's faces
                    objects = []
                else:
                    continue
            else:
                last_done[cam] = stamp
                busy = True
                faces = models.faces(frame, f'{int(stamp * 1000)}-{cam}-')
                objects = identifier.update(cam, stamp, faces)
                processed += 1
                for event in identifier.events:
                    kind, identity = event[0], event[1]
                    if kind == 'new':
                        store.add_identity(identity, stamp)
                        for face in event[2]:
                            store.add_sample(identity, face.key, stamp, cam, face.score, face.embedding, face.crop)
                        log.info('new identity %s on %s', identity, cam)
                    elif kind == 'add':
                        store.add_sample(identity, event[2].key, stamp, cam, event[2].score, event[2].embedding, event[2].crop)
                    elif kind == 'drop':
                        store.drop_sample(identity, event[2])
                    elif kind == 'seen':
                        store.seen(identity, stamp, event[2])
                        log.info('%s seen on %s', identifier.gallery.label(identity), event[2])
                identifier.events.clear()
            body = json.dumps(objects)
            sent_at, sent = last_publish[cam]
            if (body != sent and now - sent_at >= 0.2) or now - sent_at >= 1.0:  # changes up to 5x/s, else 1x/s
                client.publish(f'{TOPIC}/{cam}', json.dumps({'camera': cam, 't': round(stamp or now, 3), 'objects': objects}))
                last_publish[cam] = (now, body)

        if now - last_stats >= 60:
            if last_stats:
                log.info('%.1f frames/s processed across %d cameras', processed / (now - last_stats), len(CAMERAS))
            last_stats, processed = now, 0
        if not busy:
            time.sleep(0.02)


if __name__ == '__main__':
    main()
