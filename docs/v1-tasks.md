# v1 Task Spec — Hardware & Recording

**Target:** Sunday, September 27, 2026
**Start:** Thursday, September 24, 2026 (3 days)

Scope is exactly the v1 row of the [Phases table](../README.md#phases): 5 cameras recording 24/7, VLANs enforced, Frigate operational, remote viewing via Tailscale tunnel, UPS installed, health alerts configured. No AI (v3). No homeowner app (v2).

## Risk flag

Three days is aggressive for a full hardware install — 9 Cat6A runs terminated, patch panel dressed, rack built out, 5 cameras mounted — unless most of the physical work is already done. Tasks below are ordered so that if something slips, it slips at the **end** (health alerts, temp sensor) and not the **middle** (cameras not recording). If cabling isn't mostly pulled already, flag that today — it's the item most likely to blow the date.

## Definition of done

Pulled directly from the README's v1 description and Requirements section:

- [ ] 5 cameras recording 24/7 in Frigate
- [ ] Live view + 14-day playback confirmed in Frigate's own UI
- [ ] VLANs 10/20/30/40 enforced per [`firewall-matrix.md`](firewall-matrix.md), verified with a test device on each
- [ ] No port forwarded from internet to any camera, SSH, or database — remote access only via Tailscale tunnel to the app port
- [ ] UPS installed, feeding the whole cabinet, tested by pulling the plug
- [ ] Health alerts wired: camera offline, disk failing/full, UPS on battery, cabinet over-temperature, server down
- [ ] WAN cable pulled → recording and local playback keep working
- [ ] chrony NTP configured for the camera VLAN (it has no internet route)

## Day-by-day

### Thu Sept 24 — Rack & terminate
- [ ] Confirm all hardware is on-site (cameras, switch, router, AP, mini PC, HDD, UPS, cabinet, cable, connectors, patch panel)
- [ ] Mount the 6U wall cabinet
- [ ] Rack patch panel (U1), PoE switch (U2); shelf in for router + mini PC (U3–U4)
- [ ] Terminate patch panel end of all 9 Cat6A runs (5 camera + 4 room) — critical path if not already pulled
- [ ] Mount UPS, plug in switch, router, mini PC, cabinet fan

### Fri Sept 25 — Cabling, OS, network
- [ ] Finish any remaining cable termination (camera-end connectors, room jacks)
- [ ] Mount 5 cameras, run PoE, confirm link lights on the switch
- [ ] Flash Debian to the edge server; disable onboard Wi-Fi in BIOS/OS
- [ ] Install Docker + Docker Compose
- [ ] ER605: create VLANs 10/20/30/40, trunk to switch, confirm AT&T gateway passthrough
- [ ] Switch: VLAN 20 access ports → cameras, VLAN 10 access ports → room jacks, trunk → AP, trunk (VLAN 10+20) → edge server
- [ ] EAP610: SSID-to-VLAN mapping (trusted / IoT / guest)
- [ ] Apply the firewall rules from `firewall-matrix.md` on the ER605
- [ ] Smoke test: VLAN 10 device reaches internet + edge server; VLAN 20 device (test laptop on a camera port) reaches nothing but the edge server's RTSP/ONVIF ports

### Sat Sept 26 — Stack up, cameras live
- [ ] Copy `docs/frigate-config.example.yml` → `frigate/config.yml`, fill in real RTSP/ONVIF credentials for all 5 cameras (gitignored — never commit)
- [ ] Create `mosquitto/config/mosquitto.conf` and `caddy/Caddyfile` (referenced by `docker-compose.yml`, not yet in the repo)
- [ ] Mount the 4TB HDD to `/mnt/surveillance`, confirm it's separate from the OS drive
- [ ] `docker compose up -d`
- [ ] Confirm all 5 cameras connected in Frigate, recording main stream, detecting on sub-stream
- [ ] Confirm live view for all 5
- [ ] Set 14-day retention, confirm actual disk usage tracks the ~16-day budget
- [ ] Configure chrony for the camera VLAN
- [ ] Install Tailscale on the edge server; confirm it reaches the app port only, not camera ports
- [ ] Verify zero ports forwarded on the ER605 WAN side

### Sun Sept 27 — Health, resilience, acceptance
- [ ] smartmontools — disk health checks
- [ ] NUT — connect UPS, configure battery/on-battery alerts
- [ ] Uptime Kuma — wire alerts: camera offline, disk failing/full, UPS on battery, cabinet over-temp, server down
- [ ] Cabinet temp sensor + alert threshold (attempt if hardware's on hand; if not, log as an open item — don't block on it)
- [ ] **Acceptance 1:** pull the WAN cable → recording and local playback keep working
- [ ] **Acceptance 2:** pull the UPS plug → system stays up, alert fires
- [ ] **Acceptance 3:** unplug one camera → offline alert fires within 60s
- [ ] **Acceptance 4:** from outside the LAN, Tailscale reaches the Frigate UI; camera ports are unreachable
- [ ] Walk `firewall-matrix.md` row by row, confirm every rule holds
- [ ] Update README v1 status to Done, note actual retention achieved
- [ ] Commit `mosquitto/config`, `caddy/Caddyfile` (sanitized, no secrets) to the repo
- [ ] Push to `main`

## Explicitly out of scope for Sunday

Belongs to v2 or v3 — do not let these creep in:
- FastAPI backend / Next.js frontend (v2)
- Object detection / OpenVINO (v3)
- Sensor integrations — smoke/CO/gas/flood/door/stove (v3)
- Off-site backup (v3)
- Installer image (v3)

## Carried open items (don't block Sunday on these)

From the README's Open Items — unresolved, but not v1-acceptance-blocking:
- AT&T install date / confirmed plan speed
- Final AP location (LR-02 vs. spare vs. attic camera)
- 30-day retention storage upgrade (8TB+) — budget decision
- Customer-facing remote access model for v3
