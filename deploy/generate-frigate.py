#!/usr/bin/env python3
"""Generate the installed camera inventory without printing credentials."""
import json, os, pathlib, re, sys
from urllib.parse import quote
root = pathlib.Path(__file__).resolve().parent.parent
target = root / 'frigate/config.yml'
if target.exists():
    sys.exit('frigate/config.yml already exists; edit it in place instead.')
env = {}
for line in (root / '.env').read_text().splitlines():
    match = re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$', line)
    if match:
        env[match[1]] = match[2].strip('"\'')
env.update(os.environ)
user, password = env.get('CAM_USER'), env.get('CAM_PASSWORD')
if not user or not password:
    sys.exit('Set CAM_USER and CAM_PASSWORD in .env first.')
config = {'mqtt': {'enabled': False}, 'ffmpeg': {'hwaccel_args': 'preset-vaapi'}, 'detect': {'enabled': False}, 'record': {'enabled': True, 'continuous': {'days': 14}}, 'go2rtc': {'streams': {}}, 'cameras': {}}
for key, host in sorted(env.items()):
    match = re.fullmatch(r'CAM(\d+)_HOST', key)
    if not match or not host:
        continue
    if not re.fullmatch(r'[A-Za-z0-9.-]+', host):
        sys.exit('Camera hosts must be IP addresses or hostnames.')
    camera = 'cam_' + match[1].zfill(2)
    for suffix, stream in [('', 'stream0'), ('_sub', 'stream1')]:
        name = camera + suffix
        address = f'rtsp://{quote(user, safe="")}:{quote(password, safe="")}@{host}:554/{stream}#backchannel=0'
        config['go2rtc']['streams'][name] = [address, f'ffmpeg:{name}#video=h264#hardware']
    config['cameras'][camera] = {'ffmpeg': {'inputs': [
        {'path': f'rtsp://127.0.0.1:8554/{camera}', 'input_args': 'preset-rtsp-restream', 'roles': ['record']},
        {'path': f'rtsp://127.0.0.1:8554/{camera}_sub', 'input_args': 'preset-rtsp-restream', 'roles': ['detect']} ]}, 'detect': {'width': 640, 'height': 360, 'fps': 5}}
if not config['cameras']:
    sys.exit('No CAMxx_HOST entries configured.')
target.parent.mkdir(exist_ok=True, mode=0o700)
with target.open('x') as output:
    os.chmod(target, 0o600)
    json.dump(config, output, indent=2)
print(f'Generated configuration for {len(config["cameras"])} cameras. Credentials were not printed.')
