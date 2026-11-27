#!/bin/sh
set -eu
mountpoint -q /mnt/surveillance || { echo 'Surveillance drive is not mounted; refusing to start.' >&2; exit 1; }
# A bind of an OS-drive directory is not a dedicated recording filesystem.
[ "$(stat -c %d /mnt/surveillance)" != "$(stat -c %d /)" ] || { echo 'Surveillance path is on the OS filesystem.' >&2; exit 1; }
[ -d /mnt/surveillance/manual ] || { echo 'Create the manual clips directory on the HDD first.' >&2; exit 1; }
