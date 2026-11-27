#!/bin/sh
# Lists the containers that belong to the given Compose files (used by `make ps`).
#
#   deploy/compose-ps.sh docker-compose.yml docker-compose.dev.yml ...
#
# Containers are matched on Compose's project + service labels, so stopped
# containers and ones without a fixed container_name are included, and
# unrelated containers on the host are not.
set -eu
COMPOSE=${COMPOSE:-docker compose}

wanted=""
for file in "$@"; do
  # --no-interpolate: works without .env (camera credentials aren't needed here)
  project=$($COMPOSE -f "$file" config --no-interpolate 2>/dev/null | sed -n 's/^name: //p')
  for service in $($COMPOSE -f "$file" config --no-interpolate --services 2>/dev/null); do
    wanted="$wanted $project/$service"
  done
done

docker ps -a --format '{{.Label "com.docker.compose.project"}}/{{.Label "com.docker.compose.service"}}	{{.Names}}	{{.Status}}	{{.Ports}}' |
  awk -F '\t' -v wanted="$wanted " '
    BEGIN { format = "%-31s %-20s %-30s %s\n"; printf format, "STACK/SERVICE", "CONTAINER", "STATUS", "PORTS" }
    index(wanted, " " $1 " ") { rows[$1 "\t" $2] = sprintf(format, $1, $2, $3, $4) }
    END {
      n = 0
      for (key in rows) keys[++n] = key
      for (i = 2; i <= n; i++) for (j = i; j > 1 && keys[j - 1] > keys[j]; j--) { t = keys[j]; keys[j] = keys[j - 1]; keys[j - 1] = t }
      for (i = 1; i <= n; i++) printf "%s", rows[keys[i]]
      if (n == 0) print "(no containers for these stacks)"
    }'

# On the edge box go2rtc and the app also run outside Docker, as systemd user
# services (until production Compose takes over). Show them when present.
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user list-units 'adu-*' --all --no-legend --plain 2>/dev/null |
    awk 'NR == 1 { print "\nNative (systemd --user):" } { printf "  %-29s %s %s\n", $1, $3, $4 }'
fi
