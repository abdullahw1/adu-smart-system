#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
set -a
. "$repo/runtime/mac-remote.env"
set +a
cd "$repo/frontend"
export NODE_ENV=production NEXT_DIST_DIR=.build HOST=127.0.0.1 PORT=3000
exec node server.mjs
