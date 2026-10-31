#!/usr/bin/env python3
"""Run on the Ubuntu host. Exit nonzero for service/disk/recording failures."""
import datetime, glob, json, os, pathlib, subprocess, sys, time, urllib.request
failures = []
root = pathlib.Path('/mnt/surveillance')
if subprocess.run(['mountpoint', '-q', str(root)]).returncode:
    failures.append('Recording drive is not mounted')
else:
    stats = os.statvfs(root)
    if stats.f_bavail * stats.f_frsize < 5 * 1024**3:
        failures.append('Less than 5 GiB recording space remains')
try:
    with urllib.request.urlopen('http://127.0.0.1:5000/api/stats', timeout=10) as response:
        cameras = json.load(response)['cameras']
    if not cameras:
        failures.append('No cameras configured')
    for camera, stats in cameras.items():
        if stats.get('camera_fps', 0) <= 0:
            failures.append(f'{camera}: no camera frames')
        latest = 0
        for hours in (0, 1):
            at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=hours)
            folder = root / 'recordings' / at.strftime('%Y-%m-%d') / at.strftime('%H') / camera
            for file in folder.glob('*.mp4'):
                try:
                    latest = max(latest, file.stat().st_mtime)
                except FileNotFoundError:
                    pass
        if time.time() - latest > 120:
            failures.append(f'{camera}: no recent recording segments')
except Exception:
    failures.append('Frigate is unavailable')
try:
    with urllib.request.urlopen('http://127.0.0.1:3000/api/auth/session', timeout=10) as response:
        if response.status != 200:
            failures.append('Camera app is unavailable')
except Exception:
    failures.append('Camera app is unavailable')
state = pathlib.Path('/var/lib/adu-health/state.json')
state.parent.mkdir(parents=True, exist_ok=True)
try:
    previous = json.loads(state.read_text())
except FileNotFoundError:
    previous = []
if failures != previous:
    message = 'ADU: ' + ('; '.join(failures) if failures else 'Recording system recovered')
    subprocess.run(['logger', '-t', 'adu-health', message], check=False)
    webhook = os.environ.get('ALERT_WEBHOOK_URL')
    if webhook:
        # Configure an endpoint that accepts a JSON {text: ...} message.
        req = urllib.request.Request(webhook, data=json.dumps({'text': message}).encode(), headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=10):
                pass
        except Exception:
            print('Alert delivery failed', file=sys.stderr)
            sys.exit(1)  # Retry next run; do not mark this change delivered.
    state.write_text(json.dumps(failures))
for message in failures:
    print(message, file=sys.stderr)
sys.exit(bool(failures))
