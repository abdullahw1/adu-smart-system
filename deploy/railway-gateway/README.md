# Temporary Mac gateway

Railway runs only an authenticated Chisel reverse tunnel and HTTP/WebSocket
proxy. The app, account database, camera credentials and recordings remain on
the Mac. The gateway's backend is the loopback-only reverse listener at port
3001; the tunnel account may bind only that listener. No camera subnet, raw
RTSP/API port, SOCKS proxy or owner-setup endpoint is intentionally published.
The app's existing login and role checks apply to every camera request. Its
loopback owner-setup guard rejects requests forwarded through this gateway.

Railway service root: deploy/railway-gateway, Dockerfile: Dockerfile,
PORT: 8080, one replica, no sleep mode. Set TUNNEL_SECRET to a random 32-byte
hex value and CHISEL_KEY to an independently generated random seed. Store
credentials only in Railway variables and gitignored runtime files. Pin the
client to the fingerprint printed by the deployed server.

The Mac client runs the same official jpillora/chisel:1.13.0 image, with
AUTH=mac:<secret> loaded from a private env file. Forward
R:127.0.0.1:3001:host.docker.internal:3000 to the Railway HTTPS URL. The
container needs no published ports, host networking, privileged access or
Docker socket. Use restart: unless-stopped. APP_ORIGIN on the Mac must equal
the Railway HTTPS origin; use that URL for sign-in and camera controls.

Keep the Mac awake and Docker running. Sleep, Wi-Fi loss, quitting Docker,
or stopping the app interrupts remote access; the tunnel reconnects when
connectivity returns. Railway relays video and incurs compute/network usage.
This is temporary until the Ubuntu mini PC is configured.

To disable remote access, stop/remove the adu-camera-tunnel container and
remove the Railway domain or stop its service. Rotate TUNNEL_SECRET in both
places if the client env file is disclosed. Do not commit runtime credentials.
