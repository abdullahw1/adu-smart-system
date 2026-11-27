#!/usr/bin/env bash
# Builds the demo camera video from a patient-watch recording (record.py output:
# frames/<epoch ms>.jpg). Keeps the recorded timing, drops the first SKIP seconds
# (the stream was still starting), scales to the real sub-stream size (640x360)
# and encodes H.264 with a keyframe every second so viewers join quickly.
#
#   demo/make-demo-video.sh ~/patient-watch-recordings/rec1 [demo/media/cam_03.mp4]
#
# The output holds real footage of people, so demo/media/ is gitignored.
set -euo pipefail
REC=${1:?usage: $0 RECORDING_DIR [OUT.mp4]}
OUT=${2:-$(dirname "$0")/media/cam_03.mp4}
SKIP=${SKIP:-2.5}
mkdir -p "$(dirname "$OUT")"
LIST=$(mktemp)
trap 'rm -f "$LIST"' EXIT
# ffmpeg concat list: each frame shown until the next one was captured.
ls "$REC/frames" | sort -n | awk -v dir="$REC/frames" -v skip="$SKIP" '
  { ms = substr($0, 1, length($0) - 4) + 0 }
  NR == 1 { start = ms }
  (ms - start) / 1000 < skip { next }
  prev != "" { printf "file '\''%s/%s'\''\nduration %.3f\n", dir, prev, (ms - prevms) / 1000 }
  { prev = $0; prevms = ms }
  END { printf "file '\''%s/%s'\''\nduration 0.1\n", dir, prev }' > "$LIST"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$LIST" \
  -vf "scale=640:360:flags=lanczos,fps=10,format=yuv420p" \
  -c:v libx264 -preset veryfast -crf 23 -g 10 -keyint_min 10 -sc_threshold 0 -an -movflags +faststart "$OUT"
echo "wrote $OUT ($(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT") s)"
