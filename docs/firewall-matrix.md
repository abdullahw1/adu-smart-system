# Firewall rule matrix

Enforced on the router (ER605). Row = source of the connection, column = destination.

| Source \ Destination | VLAN 10 Trusted | VLAN 20 Cameras | VLAN 30 IoT | VLAN 40 Guest | Internet | Edge server (app port) |
|---|---|---|---|---|---|---|
| **VLAN 10 Trusted** | — | DENY | ALLOW | DENY | ALLOW | ALLOW |
| **VLAN 20 Cameras** | DENY | — | DENY | DENY | DENY | LIMITED (RTSP/ONVIF ports only) |
| **VLAN 30 IoT** | DENY | DENY | — | DENY | ALLOW | LIMITED (MQTT/API ports only) |
| **VLAN 40 Guest** | DENY | DENY | DENY | — | ALLOW | DENY |

**LIMITED** means the connection is allowed only to the specific port(s) the service needs — not general access:
- VLAN 20 → Edge server: Frigate's RTSP/ONVIF ingest ports only. No SSH, no web UI, no other port.
- VLAN 30 → Edge server: MQTT broker port + any API endpoint devices need. Nothing else.

Camera-to-camera and IoT-to-IoT traffic is denied by default — nothing on those VLANs needs to talk to its neighbors.

**Rule that never changes, regardless of VLAN config:** never forward a port from the internet to any camera, the server's SSH, or any database. Remote users reach the app only, via the Tailscale tunnel.
