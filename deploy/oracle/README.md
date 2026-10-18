# Always-free, hands-off proxy (Oracle Cloud)

Goal: the proxy runs itself. No PC, no Render, no monthly cookie refresh.

Two things live on one always-on VM:

| piece | what it does |
| --- | --- |
| `wr-proxy` + `wr-pot` | the yt-dlp proxy and its PO-token provider (same code as Render) |
| Chromium profile + `wr-refresh.timer` | keeps a signed-in browser session alive and re-writes `cookies.txt` every 6h |

The Chromium profile stays signed in, so Google rotates its own session tokens
whenever the profile visits youtube.com. That is the whole trick: **because the
browser is real and stays logged in, nothing ever expires on a schedule.** If the
session is ever dropped the refresher signs back in with the throwaway
credentials in `/etc/wr/wr.env`. `wr-load.service` burns a little CPU so Oracle
does not classify the VM as idle and reclaim it.

## What only you can do

1. **Create the account and VM** (Oracle requires a card for identity
   verification; Always Free resources are not charged).

   Compute -> Instances -> Create instance:
   - **Image**: Ubuntu 24.04 (aarch64)
   - **Shape**: Ampere -> `VM.Standard.A1.Flex`, 1 OCPU / 6 GB is plenty
     (Always Free allows up to 4 OCPU / 24 GB)
   - **Networking**: assign a public IPv4
   - **SSH keys**: upload a public key (or let Oracle generate one and download
     the private key)
   - **Advanced options -> Management -> Cloud-init script**: paste
     `cloud-init.yaml`

   If you get *"Out of host capacity"*, try a different availability domain, or
   retry in a few hours - ARM A1 is often full in popular regions.

2. **Give me access** so I can finish the job: the instance's public IP and the
   SSH private key (or run the commands yourself - `setup.sh` is idempotent).
   Everything below this point is mine to do.

## What I do once I can reach the box

- watch `/root/wr-setup.log` until the install finishes
- put the throwaway email/password into `/etc/wr/wr.env`
- run the refresher once by hand to establish the signed-in Chromium profile and
  confirm the exported cookie set matches what the app needs
- expose it on a stable hostname (Cloudflare Tunnel on your `jalalamanj.online`,
  so no inbound ports and no certificate management)
- point `endpoint.txt` at the new hostname, then confirm `/stream` returns 206
  and that a song downloads in the app
- keep Render around for a few days as a fallback, then delete it

## Honest limits

- Google occasionally challenges automated sign-ins. The persistent profile
  avoids this in the normal case; if it ever does happen the hourly health check
  opens an issue instead of failing silently.
- Oracle *can* reclaim idle instances - `wr-load` is there to prevent it, but if
  they ever do, the recovery is recreating the VM and pasting the same
  cloud-init.

## Files

- `setup.sh` - idempotent installer (deps, yt-dlp + plugin, provider, services)
- `refresh-cookies.mjs` - persistent-profile cookie refresher
- `cloud-init.yaml` - paste into the VM's cloud-init box
