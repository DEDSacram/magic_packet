# Wake-on-LAN over Cloudflare Tunnel

Web app that sends a Wake-on-LAN magic packet to `192.168.88.238`
(MAC `04:7c:16:6d:f6:26`), reachable from anywhere through a Cloudflare Tunnel.

## Setup

1. Create the environment file and set a passphrase:

   ```sh
   cp .env.example .env
   sh scripts/gen-secret.sh
   ```

   Paste the output into `WOL_SECRET` in `.env`.

2. Create a Cloudflare tunnel. In the Zero Trust dashboard go to
   **Networks > Tunnels**, create a named tunnel, then **Configure** and copy
   the connector token. Paste it into `TUNNEL_TOKEN` in `.env`.

3. Add a public hostname to the tunnel pointing at the app:

   | Type | Value              |
   | ---- | ------------------ |
   | Subdomain | `wol` (or your choice) |
   | Domain  | your domain        |
   | Path    | (blank)            |
   | Service | `http://127.0.0.1:8080` |

   The tunnel runs with host networking, so `127.0.0.1` here is the host's
   loopback, which is where the app binds.

4. Start it:

   ```sh
   docker compose up -d --build
   ```

5. Check it works:

   ```sh
   curl -s localhost:8080/healthz
   docker compose logs -f
   ```

## Access control

The only protection is `WOL_SECRET`. If someone guesses it they can wake your
PC, nothing more — the app never executes commands. But the URL is public, so
add a second layer if you want:

**Cloudflare Access** (recommended): Zero Trust > Settings > Access > Applications,
add a self-hosted app for the `wol` subdomain with an email OTP or identity
provider policy. Then you never need `WOL_SECRET` again, though keeping it is
harmless.

Failed attempts are rate limited to 8 per 15 minutes per IP.

## Keeping WoL working

The tunnel and app only run while the PC is on, so this wakes the PC but
cannot be *used* while it is asleep. To actually wake a sleeping machine:

- **Wake-on-LAN from elsewhere** on the LAN, or
- **Wake-on-WAN** if your router supports it, or
- An always-on host (router, NAS, another box) running this app.

## Notes

- Host networking is required. A magic packet is a UDP broadcast to
  `255.255.255.255:9` and it must leave on the real LAN interface. Behind a
  docker bridge it would only reach the bridge subnet.
- The app sends to global broadcast, each interface's subnet broadcast, and
  each local IP, three times each. Some switches and wifi APs drop global
  broadcast, hence the redundancy.
- `WOL_TARGET_MAC` is configurable, so you can point this at another machine
  without code changes.
