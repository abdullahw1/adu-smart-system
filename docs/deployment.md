# Development, edge box and Ubuntu deployment

Contents: [Development](#development-no-cameras-needed) ·
[App accounts, security and data](#app-accounts-security-and-data) ·
[Edge box today](#edge-box-today-detection-stack) ·
[Live captions and the patient monitor](#live-captions-and-the-patient-monitor) ·
[Ubuntu production](#ubuntu-production) · [Remote access](#private-remote-access) ·
[Health](#health-and-recovery) · [Face recognition](#face-recognition-prototype)

All stacks are run with the Makefile: `make build|up|down|clean|ps [STACK=dev|detect|prod] [SERVICES="..."]`
(`make` alone lists the targets). No target deletes data.

## Development (no cameras needed)

Use Node 22.22 or newer in the Node 22 line (the app uses built-in SQLite).

```sh
make up          # dev stack (STACK=dev is the default)
cd frontend
npm ci
FACES_DIR=../runtime/faces-dev npm run dev
```

The dev stack (`docker-compose.dev.yml`) runs go2rtc, MQTT, Frigate (CPU
detector, no recording), patient-watch and face-watch, all bound to localhost
on the production ports, so the app needs no other settings. By default go2rtc
loops a recorded clip as `cam_03` / `cam_03_sub` (`go2rtc/go2rtc.demo.yaml`):
the live grid, Frigate person boxes, patient-monitor captions and face labels
all run on known footage. `FACES_DIR` points the Faces tab at the dev face
library (`runtime/faces-dev`) instead of the live one. `make ps STACK=dev`
shows the dev containers.

To use the real cameras instead, from a laptop on the camera network with the
root `.env` filled in: `GO2RTC_CONFIG=go2rtc.yaml make up`, and set
`DEV_FACE_CAMERAS=cam_01,cam_02,cam_03,cam_04` for face recognition on all of
them.

**The demo clip** is built from a patient-watch recording (`record.py`: frames
plus model output) by `demo/make-demo-video.sh`; `make up` does this the first
time from `~/patient-watch-recordings/rec1` (or `RECORDING=<folder>`). It shows
real people, so `demo/media/` is gitignored; copy the recording folder between
machines. The same recording scores detection quality (see
[Measuring accuracy](#measuring-accuracy)).

**On the edge box itself** the live stack already holds those ports. Shift the
dev ports and point a second copy of the app at them, with its own build
folder and database so it doesn't touch the live app:

```sh
DEV_GO2RTC_PORT=11984 DEV_RTSP_PORT=18554 DEV_MQTT_PORT=11883 DEV_FRIGATE_PORT=15000 make up
cd frontend && GO2RTC_API_URL=http://127.0.0.1:11984 GO2RTC_RTSP_URL=rtsp://127.0.0.1:18554 \
  FRIGATE_MQTT_URL=mqtt://127.0.0.1:11883 FRIGATE_DETECT_API_URL=http://127.0.0.1:15000 \
  FACES_DIR=../runtime/faces-dev PORT=3100 NEXT_DIST_DIR=.next-dev APP_DATA_DIR=data-dev npm run dev
```

The dev stack has its own Compose project name (`adu-dev`), so it never
replaces the live containers. `make clean` removes its containers and built
images but keeps the dev face library and the demo clip.

**Tests:** `cd frontend && npm test` (app) and `npm run typecheck`. The
patient-watch and face-watch unit tests run on every image build, so
`make build` fails if they fail.

## App accounts, security and data

Open http://localhost:3000/setup on the machine running the app and create the
owner account. Setup is allowed only from loopback with a local Host and Origin and
only while no account exists. Passwords are hashed with scrypt. Login sessions
last 12 hours and are revoked on logout. Add viewers or administrators from
Access. Viewers can watch and download, but cannot change settings, start/stop
recordings, rename cameras, or delete footage.

Camera credentials stay in the root `.env` and go2rtc. The app's `/api/cameras`
returns IDs and display defaults only. The browser negotiates MSE through the
authenticated `/live/ws` endpoint, with bounded messages and buffers. The
upstream API and RTSP listeners bind only to loopback. Never publish them to
WAN or forward them in the router. An authorized user on the server itself can
still inspect these local services; local host access is a trust boundary.

The first startup imports existing camera-names.json and camera-settings.json
into data/app.sqlite once. Original files remain intact for rollback. Back up
the app data directory with SQLite's backup API or while the app is stopped;
copying only a live database file omits its WAL. Do not share one app data
directory across independent homes.

The manual recorder allows one process per camera, reports REC only after
receiving video frames, and stops on low disk space or its 100 GiB clip quota.
Set RECORDING_MAX_BYTES and RECORDING_MIN_FREE_BYTES to tune those limits. It
never automatically deletes manual clips. Restarting the app ends manual
recordings; Frigate independently owns continuous recording.

**On-demand recording:** open a camera and press **Record**; **Stop** finishes
it, and recordings stop on their own after 1 hour. Clips are full-quality MP4s
saved on the machine running the app, in `frontend/data/recordings/` (override
with `RECORDINGS_DIR`; on production the HDD's `/mnt/surveillance/manual`).
The live captions are saved alongside each clip (`<clip>.captions.jsonl`), so
playback shows them and **Download with captions** can draw them into a copy.
Recording needs `ffmpeg`/`ffprobe` on the machine running the app (the
production app image includes them).

**Camera settings** use ONVIF with the `CAMxx_HOST` / `CAM_USER` /
`CAM_PASSWORD` values from the root `.env`. These Anpviz cameras store only a
fixed UTC offset and ignore DST rules, so after a daylight-saving change the
page flags the clock as wrong; press Apply to fix it.

The server talks to go2rtc and Frigate through server-only settings
(`GO2RTC_API_URL`, `GO2RTC_RTSP_URL`, `FRIGATE_API_URL`,
`FRIGATE_DETECT_API_URL`, `FRIGATE_MQTT_URL`, `FACES_DIR`); browsers only ever
use the authenticated app origin. When a new build is deployed, open pages
reload themselves.

## Edge box today: detection stack

Until the surveillance HDD is installed, the edge server runs:

| What | How | Where |
|---|---|---|
| go2rtc (camera relay) | systemd user service `adu-go2rtc` | 127.0.0.1:1984 API, :8554 RTSP, :8555 WebRTC |
| The app | systemd user service `adu-app` (`node server.mjs`, production build) | 127.0.0.1:3000, HTTPS via Tailscale Serve |
| Frigate 0.18.2 detection, no recording | `docker-compose.detect.yml` (`frigate-detect`) | 127.0.0.1:5000 (UI/API) |
| Mosquitto | same stack (`frigate-mqtt`) | 127.0.0.1:1883 |
| patient-watch (camera 03) | same stack | publishes `adu/watch/cam_03` |
| face-watch (all cameras, 2 fps each) | same stack | publishes `adu/faces/<camera>`; library in `runtime/faces/` |

```sh
make up STACK=detect      # start or update (builds patient-watch and face-watch)
make ps                   # containers plus the two native services
make down STACK=detect    # stop; the face library and Frigate config are kept
```

Frigate here pulls each camera's sub-stream directly (credentials from the
root `.env`), detects objects with OpenVINO on the iGPU at 5 fps and publishes
`frigate/events`. Its internal go2rtc ports are not published, so nothing
clashes with the native go2rtc. Frigate's config and the zones drawn in its UI
live in `frigate-detect/config/config.yml`; its database and secrets there are
gitignored.

After changing the app: `cd frontend && npm run build`, then
`systemctl --user restart adu-app`. Open pages pick up the new build by
themselves.

## Live captions and the patient monitor

The app subscribes to MQTT and merges three caption feeds into the live view
(`/live/detections`):

- **Frigate objects** on every camera: "Person walking toward camera", "Car
  driving past", "Package or bag left here". Updates arrive about once a
  second.
- **patient-watch** on camera 03 (`adu/watch/cam_03`): the patient's box with
  "Patient moving / still"; gestures ("Waving - may need help", "Hand raised",
  held open palm, pointing up, thumbs up or down) shown for 3 s after they
  stop; and a red alert when the patient has left the zone, or is out of view,
  for 5 s. On that camera the patient box replaces Frigate's person box. If
  patient-watch stops or loses video, a red "Patient monitor offline / no
  video" caption says so: a silent monitor must not look like a calm room.
- **face-watch** on every camera (`adu/faces/<camera>`): face boxes with a name
  or an ID. Face labels simply disappear if the service stops.

**patient-watch** reads the sub-stream at 10 fps and runs MediaPipe Pose and
Gesture Recognizer on the CPU. An EfficientDet-Lite2 person detector, run about
twice a second, must also see a person around the pose's head and shoulders;
on its own the pose model "found" patients in an empty chair and, in night
mode, on a mouse and cable. Waves come only from the hand detector, presence
is judged over a 2 s window, and raised hands and hand signs must be held for
1 s. Settings (compose environment):

- `CAMERA`: the camera to watch.
- `SENSITIVITY`: `high` (quicker alerts), `normal` or `low`.
- `PATIENT_ZONE`: the zone name. Draw a zone with that name (default
  `patient_area`) on the camera in the Frigate UI (Settings → Masks / Zones);
  patient-watch reads it every 30 s, so redrawing needs no restart. Without a
  zone, leaving the whole frame raises the alert.

Captions only: it sends no notifications and must not replace a nurse call.

### Measuring accuracy

Both services come with tools to measure them on known footage instead of
guessing:

```sh
# record ~3 minutes of camera 03: frames + raw model output
mkdir -p rec && docker run --rm --network host --user "$(id -u)" -v "$PWD/rec:/out" -e SECONDS=200 \
  adu-smart-system-patient-watch python record.py
# replay the caption rules on it (fast; reuses the recorded model output)
python3 patient-watch/replay.py rec normal
# re-run the models and rules on the frames and score against hand-made labels
#   rec/labels.json: {"seated": [[2, 36]], "standing": [[36, 56]], "empty": [[56, 62]], "gestures": [[74, 77.5]]}
mkdir -p eval && docker run --rm --user "$(id -u)" -v "$PWD/rec:/rec:ro" -v "$PWD/eval:/out" \
  adu-smart-system-patient-watch python evaluate.py /rec /rec/labels.json /out    # + eval/annotated.mp4
# face recognition on a video: how many ids does one person create?
docker run --rm -v "$PWD/demo/media:/media:ro" adu-smart-system-face-watch python evaluate.py /media/cam_03.mp4
```

Results on the November 2026 recording (one person, backlit desk view):

- **patient-watch:** 0 false gesture captions. Patient box shown 99.4% of the
  time while seated and 0% with the room empty. The "out of view" alert
  covered the whole empty period. A real wave against the window was missed.
- **face-watch:** 1 ID for the one person. Once known, recognised from the
  first frame and labelled 99% of the time.

## Ubuntu production

The checked-in production stack targets an Intel N100/N95 Ubuntu mini PC and
/dev/dri/renderD128. Adjust that device and FFmpeg hardware preset if the actual
PC differs. Deploy the repository at /opt/adu-smart-system. The disk and its
contents are never formatted by these scripts.

1. Mount the surveillance HDD at /mnt/surveillance using its filesystem UUID in
   /etc/fstab. Use ext4 for a Linux-only recording drive. Confirm with findmnt
   that it is a dedicated filesystem, separate from /. Do not use a folder or
   bind mount backed by the OS disk.
2. On the mounted HDD, create /mnt/surveillance/manual. Create runtime/app and
   runtime/faces in the repository. Give these directories UID/GID 1000 ownership for the
   unprivileged app container. Check the Dockerfile's node UID if customizing
   the base image. Keep app data on the SSD and video on the HDD.
3. Fill the root .env with CAM_USER, CAM_PASSWORD and every installed
   CAMxx_HOST. Run `python3 deploy/generate-frigate.py`. It writes a private,
   gitignored frigate/config.yml for the actual inventory, URL-encodes camera
   credentials and never prints them. It refuses to overwrite an existing
   config. Add future cameras in that config using matching cam_XX IDs.
4. `make build STACK=prod` builds the production app (with FFmpeg),
   patient-watch and face-watch. The persistent frigate directory holds both
   its config and database. Frigate is pinned to 0.18.2; validate future
   upgrades before changing the pin.
5. Install deploy/adu.service in /etc/systemd/system and run
   `sudo systemctl daemon-reload` then `sudo systemctl enable --now adu`
   (afterwards `make up STACK=prod` / `make down STACK=prod` start and stop
   it through systemd).
   The service checks the mount before every start and stops if the mount
   unit disappears. Docker container restart policies are deliberately off:
   systemd owns restarts so Docker cannot bypass the disk check at boot.
6. Create the owner account from Ubuntu's localhost:3000/setup, or use an SSH
   local port forward from your Mac. For example, forward Mac port 3001 to
   127.0.0.1:3000 on Ubuntu, then open http://localhost:3001/setup on the Mac.
   Account setup on that screen is a user action; there is no default password.
7. Confirm every camera produces recent recording files and playback works.
   The default retention target is 14 continuous days; actual capacity can
   force shorter history. Measure recording bitrates before promising days.
8. Stop the edge box's interim services first: `make down STACK=detect` and
   `systemctl --user disable --now adu-app adu-go2rtc`. Production reuses the
   same ports, container names and `runtime/faces/` library. Copy
   `frigate-detect/config/config.yml`'s zones (e.g. `patient_area`) into
   `frigate/config.yml` if you want them.

The production stack (`docker-compose.yml`) runs Frigate (recording, bundled
go2rtc), the app, Mosquitto, patient-watch and face-watch. The generated
production Frigate config records only: detection and MQTT are off, so
Frigate's own object captions are absent until `detect` and `mqtt` are
enabled there. patient-watch and face-watch don't depend on them. The health
check covers Frigate, recordings and the app, not yet patient-watch or
face-watch (`make ps STACK=prod` shows them).

## Private remote access

Install Tailscale on Ubuntu and authorized phones/laptops. Use Tailscale Serve
for the app, with HTTPS enabled in the tailnet:

```sh
tailscale serve --bg http://127.0.0.1:3000
```

Set APP_ORIGIN in root .env to the exact resulting HTTPS origin and restart
adu. This enforces the expected origin and Secure session cookies. Sign in
again at the HTTPS address. Restrict tailnet grants to authorized family
members on the served HTTPS port. Do not use Funnel or advertise the camera
subnet. The same HTTPS address serves pages, recordings and live WebSockets;
no public camera ports or separate browser stream URL are needed.

Test on cellular with home Wi-Fi off. Both ends need working internet for
remote access; recording and local playback must continue with WAN down.
Browsers without H.265 decoding can use Lower bandwidth for live viewing;
recorded H.265 clips require a compatible browser/player. Exported time-range
MP4 playback on iOS needs further hardware validation; use Frigate's native
HLS interface locally if that browser cannot play the MP4 export.

## Health and recovery

Install adu-health.service and adu-health.timer and enable the timer. It checks
mount, free space, camera FPS, recent recording segments and the app every
minute. State changes go to the system journal. To receive notifications,
configure ALERT_WEBHOOK_URL in root-owned /etc/adu-health.env for an endpoint
accepting JSON {"text": "..."}; unchanged failures do not spam notifications.
A failed notification is retried. A monitor on another device is still needed
to detect this server losing power or internet entirely.

Connect the recording enclosure, server, PoE switch and router to the UPS.
NUT and SMART integration depend on the UPS model and whether the USB enclosure
passes disk health commands through; validate these on the actual hardware.
Do not claim UPS or disk-failure alerts are operational until those tests pass.

Acceptance: test reboot recovery, absent-drive startup refusal, WAN loss,
camera disconnects, playback on phone/desktop, viewer restrictions, remote
viewing on cellular, disk health and UPS runtime. Ubuntu deployment, Frigate
recording and tailnet configuration cannot be validated on the development
Mac without access to that hardware and its recording disk.

## Face recognition (prototype)

`face-watch` (in the production, detection-only and dev stacks) finds faces on
every camera's sub-stream (OpenCV YuNet) at 2 fps per camera, turns each into
an embedding (SFace) and labels it in the live view with a name, an ID such as
`face_0003`, or "Face" while it is not yet identified. An unknown person gets a new id only
after a few clear, consistent views, so a glimpse creates nothing. Faces must
be roughly 32 px wide or more in the 640x360 sub stream, which in practice
means within a few metres of the camera.

The app's **Faces** tab shows the library: every id with its photos, when and
where it was last seen, and possible duplicates (ids whose photos look like the
same person). Administrators can name ids, merge duplicates or mark them as
different people, remove single wrong photos, and delete one, several or all
faces; viewers can only browse. The app reads the library from
`runtime/faces/` (override with `FACES_DIR`, e.g. `runtime/faces-dev` for the
dev stack). The same changes are available on the command line, and the
service picks them up within 2 seconds:

```sh
docker exec face-watch python manage.py list
docker exec face-watch python manage.py sheet          # runtime/faces/sheet.jpg: faces per id
docker exec face-watch python manage.py name face_0003 "Alice"
docker exec face-watch python manage.py merge face_0007 face_0003   # same person
docker exec face-watch python manage.py forget face_0007
```

To enrol someone ahead of time, put clear photos in `runtime/faces/known/<Name>/`.
The library is the only copy (it is gitignored by design): include
`runtime/faces/` in backups of the box, copied while face-watch is stopped.
`face-watch/evaluate.py VIDEO` replays footage through the same rules and
reports how many identities it creates (one person should give one id).

The library in `runtime/faces/` is biometric data about everyone the cameras
see, including visitors and passers-by. It never leaves this machine, it is
gitignored, and unnamed ids not seen for `RETAIN_DAYS` (30) are deleted
automatically. Check the consent and notice rules that apply where it is used
(for example BIPA in Illinois, GDPR in the EU, and healthcare-facility
policies) before using it beyond a household prototype.
