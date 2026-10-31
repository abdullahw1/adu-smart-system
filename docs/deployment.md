# Local development and Ubuntu deployment

## Mac development

Use Node 22.22 or newer in the Node 22 line (the app uses built-in SQLite).

```sh
docker compose -f docker-compose.dev.yml up -d
cd frontend
npm ci
npm run dev
```

Open http://localhost:3000/setup on the Mac running the app and create the owner
account. Setup is allowed only from loopback with a local Host and Origin and
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

## Ubuntu prerequisites

The checked-in production stack targets an Intel N100/N95 Ubuntu mini PC and
/dev/dri/renderD128. Adjust that device and FFmpeg hardware preset if the actual
PC differs. Deploy the repository at /opt/adu-smart-system. The disk and its
contents are never formatted by these scripts.

1. Mount the surveillance HDD at /mnt/surveillance using its filesystem UUID in
   /etc/fstab. Use ext4 for a Linux-only recording drive. Confirm with findmnt
   that it is a dedicated filesystem, separate from /. Do not use a folder or
   bind mount backed by the OS disk.
2. On the mounted HDD, create /mnt/surveillance/manual. Create runtime/app in
   the repository. Give these two directories UID/GID 1000 ownership for the
   unprivileged app container. Check the Dockerfile's node UID if customizing
   the base image. Keep app data on the SSD and video on the HDD.
3. Fill the root .env with CAM_USER, CAM_PASSWORD and every installed
   CAMxx_HOST. Run `python3 deploy/generate-frigate.py`. It writes a private,
   gitignored frigate/config.yml for the actual inventory, URL-encodes camera
   credentials and never prints them. It refuses to overwrite an existing
   config. Add future cameras in that config using matching cam_XX IDs.
4. `docker compose build app` builds the production app with FFmpeg. The
   persistent frigate directory holds both its config and database. Frigate
   is pinned to 0.18.2; validate future upgrades before changing the pin.
5. Install deploy/adu.service in /etc/systemd/system and run
   `sudo systemctl daemon-reload` then `sudo systemctl enable --now adu`.
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
