# FetPost Deployment

End-to-end walkthrough for running FetPost 24/7 on a small Linux server. The reference deployment is a $6/month DigitalOcean Droplet (Ubuntu 24.04 LTS, 1 vCPU, 1 GB RAM, 25 GB disk). Steps should adapt to any Debian/Ubuntu host with minor tweaks.

By the end you'll have:

- Both FetPost services running under `systemd` (auto-restart on crash, auto-start on boot)
- Tailscale providing private HTTPS access to the UI from any of your devices
- NordVPN masking the datacenter IP so FetLife's Cloudflare doesn't catch cookie refreshes in a challenge loop
- Tailscale and NordVPN coexisting cleanly via an iptables bypass rule
- TigerVNC available for the occasional manual cookie refresh
- Cron jobs that keep cookies fresh and tracked-event RSVPs up to date

This guide assumes you're comfortable with SSH and a Linux shell.

## Server requirements

- Ubuntu 24.04 LTS (or any current Debian-derivative — paths may differ)
- 1 GB RAM minimum (Playwright + Chrome push memory; less is unstable)
- 20 GB disk
- Root SSH access
- A NordVPN account (or another VPN with a CLI that supports per-app allowlisting)

## 1. Base system

SSH in as `root` and bring the box up to date:

```bash
apt update && apt upgrade -y
apt install -y curl wget gnupg2 ca-certificates lsb-release software-properties-common \
  ufw fonts-liberation libnss3 libatk-bridge2.0-0 libxss1 libasound2t64 \
  libgbm1 libgtk-3-0 libxshmfence1 xvfb
```

Turn on UFW with a sensible default:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp                     # SSH
ufw allow in on tailscale0           # everything over Tailscale
ufw --force enable
```

The UI port (`4000`) and backend port (`3747`) are **not** exposed publicly. They listen only on `127.0.0.1` and are reached via Tailscale Serve later.

## 2. Node.js 20+

FetPost uses Node's built-in `--env-file` flag, which requires Node ≥ 20.6.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version    # expect v22.x
```

## 3. Google Chrome

Playwright drives a real Chrome (not Chromium) so FetLife's bot detection doesn't flag headless signatures.

```bash
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
  > /etc/apt/sources.list.d/google-chrome.list
apt update
apt install -y google-chrome-stable
google-chrome --version
```

## 4. Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
```

`tailscale up` prints a one-time login URL — open it in any browser, sign in to your tailnet, and approve the new node. Once approved, the Droplet shows up in `tailscale status` and your other devices can reach it by tailnet name (e.g., `fetpost.tail<abcdef>.ts.net`).

### Tailscale Serve (HTTPS proxy)

Expose the UI over HTTPS on the tailnet:

```bash
tailscale serve --bg --https=443 http://localhost:4000
tailscale serve status
```

From any of your tailnet peers you'll now reach the UI at `https://<your-fetpost-host>.tail<abcdef>.ts.net`.

## 5. NordVPN

NordVPN masks the Droplet's datacenter IP from Cloudflare. Without it, FetLife's cookie refresh gets caught in an endless Cloudflare challenge loop — **don't skip this**.

```bash
sh <(curl -sSf https://downloads.nordcdn.com/apps/linux/install.sh)
nordvpn login                  # follow the URL it prints to authenticate
nordvpn set autoconnect on
nordvpn set killswitch off     # leave kill switch off so Tailscale can coexist
nordvpn connect United_States  # pick a country/server you trust
nordvpn status                 # confirm Connected, note the technology (NORDLYNX = WireGuard)
```

### NordVPN allowlist (critical for Tailscale)

NordVPN's policy routing will silently swallow Tailscale's outbound TCP/UDP traffic unless we explicitly allowlist Tailscale's destinations. Add these:

```bash
nordvpn allowlist add subnet 100.64.0.0/10        # Tailscale CGNAT (peer IPs)
nordvpn allowlist add subnet 100.100.100.0/24     # Tailscale MagicDNS
nordvpn allowlist add subnet 192.200.0.0/24       # controlplane.tailscale.com
nordvpn allowlist add subnet 199.38.180.0/22      # Tailscale primary AS (DERP relays)
nordvpn allowlist add subnet 199.165.136.0/24     # log.tailscale.com
nordvpn allowlist add port 41641 protocol UDP     # Tailscale direct WireGuard
nordvpn allowlist add port 3478 protocol UDP      # STUN
nordvpn allowlist add port 22 protocol TCP        # SSH

nordvpn settings | grep -A 20 Allowlisted          # confirm
```

The subnet list above is sufficient to reach Tailscale's control plane and DERP servers. Combined with the iptables bypass in step 9, Tailscale will use direct UDP peer-to-peer where possible and DERP relay as fallback — fully working alongside NordVPN.

## 6. TigerVNC + XFCE (for manual cookie refresh)

When cookies fully expire, you need to log into FetLife through a real visible Chrome session. TigerVNC + XFCE gives you a lightweight desktop you can remote into from any tailnet peer.

```bash
apt install -y xfce4 xfce4-goodies tigervnc-standalone-server tigervnc-common dbus-x11

# Configure VNC for root
vncpasswd                          # set a VNC password
mkdir -p /root/.vnc

cat > /root/.vnc/xstartup <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
EOF
chmod +x /root/.vnc/xstartup

# Start a 1920x1200 desktop on display :1 (port 5901)
vncserver -localhost no :1 -geometry 1920x1200 -depth 24
```

UFW already blocks port 5901 from the public internet (only Tailscale and SSH pass). Connect from your Surface or laptop with TigerVNC Viewer to `<your-fetpost-host>.tail<abcdef>.ts.net:5901`.

To make VNC come back on reboot, add a systemd unit (see step 8) or set it up via `vncserver@.service`.

## 7. Deploy FetPost

```bash
mkdir -p /root/fetpost
cd /root/fetpost
git clone https://github.com/AlixzanderDC/FetPost.git .

# Generate secrets
cp .env.example .env
node -e "console.log('FL_SERVICE_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
node -e "console.log('FL_MACHINE_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
# Edit .env to remove placeholder values and add Canva creds if using

# Install service dependencies
(cd fetlife-poster && npm install)
(cd nexuspost-ui && npm install)

# Pre-create runtime directories so systemd doesn't trip on missing paths
mkdir -p /root/fetpost/.logs
mkdir -p /root/fetpost/fetlife-poster/data/cookies
mkdir -p /root/fetpost/fetlife-poster/data/events
chmod 700 /root/fetpost/fetlife-poster/data/cookies
```

## 8. systemd units for the app

Two units — backend first, UI depends on backend. Both auto-restart on failure, auto-start at boot.

Write `/etc/systemd/system/fetlife-poster.service`:

```ini
[Unit]
Description=FetPost — FetLife poster backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/fetpost/fetlife-poster
ExecStart=/usr/bin/node --env-file=/root/fetpost/.env src/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fetlife-poster

[Install]
WantedBy=multi-user.target
```

Write `/etc/systemd/system/fetpost-ui.service`:

```ini
[Unit]
Description=FetPost — UI server
After=network-online.target fetlife-poster.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/fetpost/nexuspost-ui
ExecStart=/usr/bin/node --env-file=/root/fetpost/.env src/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=fetpost-ui
# DISPLAY/XAUTHORITY are required so the manual "Refresh cookies" button can
# launch a headed Chrome on TigerVNC display :1 when headless refresh fails.
# Without them, the headed fallback either crashes or runs invisibly.
Environment=DISPLAY=:1
Environment=XAUTHORITY=/root/.Xauthority

[Install]
WantedBy=multi-user.target
```

Then:

```bash
systemctl daemon-reload
systemctl enable --now fetlife-poster fetpost-ui
systemctl status fetlife-poster fetpost-ui     # both should be active (running)

curl -sI http://localhost:3747 | head -1       # backend: 404 is expected (no GET /)
curl -sI http://localhost:4000 | head -1       # UI: 200 OK
```

Logs go to journald — tail with `journalctl -u fetlife-poster -f` (or `fetpost-ui`).

## 9. Tailscale + NordVPN coexistence (iptables bypass)

NordVPN's policy routing forces all unmarked outbound traffic through its tunnel. Tailscale's control-plane and DERP connections die silently inside that tunnel. The fix: mark `tailscaled`'s outbound packets with NordVPN's bypass `fwmark` so they route via `eth0` directly, and SNAT them to the eth0 public IP so replies come back to the right place.

Write the rule installer at `/usr/local/sbin/tailscale-nordvpn-bypass.sh`:

```sh
#!/bin/sh
iptables -t mangle -C OUTPUT -m cgroup --path system.slice/tailscaled.service -j MARK --set-mark 0xe1f1 2>/dev/null || iptables -t mangle -I OUTPUT 1 -m cgroup --path system.slice/tailscaled.service -j MARK --set-mark 0xe1f1
iptables -t nat -C POSTROUTING -o eth0 -m mark --mark 0xe1f1 -j MASQUERADE 2>/dev/null || iptables -t nat -I POSTROUTING 1 -o eth0 -m mark --mark 0xe1f1 -j MASQUERADE
```

```bash
chmod +x /usr/local/sbin/tailscale-nordvpn-bypass.sh
```

The script is idempotent — `iptables -C` returns success if the rule already exists, so re-runs are no-ops.

Hook it into `tailscaled` so it reinstalls on every daemon start, via a drop-in at `/etc/systemd/system/tailscaled.service.d/nordvpn-bypass.conf`:

```ini
[Service]
ExecStartPost=/usr/local/sbin/tailscale-nordvpn-bypass.sh
```

Add a watchdog timer that re-applies the rules every 60 seconds in case anything flushes them. Write `/etc/systemd/system/tailscale-nordvpn-bypass.service`:

```ini
[Unit]
Description=Ensure tailscaled bypass rules are present
After=tailscaled.service nordvpnd.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/tailscale-nordvpn-bypass.sh
```

And `/etc/systemd/system/tailscale-nordvpn-bypass.timer`:

```ini
[Unit]
Description=Reapply tailscaled bypass rules periodically

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now tailscale-nordvpn-bypass.timer
systemctl restart tailscaled

# Verify Tailscale is healthy WITH NordVPN connected
tailscale netcheck                              # UDP: true, real DERP latencies
tailscale status                                # no "logged out" / "coordination server" warnings
curl -s https://api.ipify.org && echo           # NordVPN exit IP, NOT your Droplet IP
```

## 10. Cron jobs

FetPost has three scripts that should run on a schedule:

- `src/setup-cookies.js` — silent headless cookie refresh (every other night at 4 AM)
- `src/refresh-tracked-rsvps.js` — refresh RSVP counts for tracked events (every night at 5 AM)
- `src/refresh-tracked-posts.js` — refresh engagement (loves / super loves / comments / views) for tracked posts (every night at 6 AM)

Install them via `crontab -e`, or build the file from short shell-variable-assembled lines (safer when SSH'd from Windows where long pasted lines get split):

```bash
F=/tmp/fetpost.cron
P=/root/fetpost/fetlife-poster
N=/usr/bin/node
E=--env-file=/root/fetpost/.env
L=/root/fetpost/.logs
echo "0 4 */2 * * cd $P && $N $E src/setup-cookies.js >> $L/cookie-refresh.log 2>&1" > $F
echo "0 5 * * * cd $P && $N $E src/refresh-tracked-rsvps.js >> $L/tracked-rsvps.log 2>&1" >> $F
echo "0 6 * * * cd $P && $N $E src/refresh-tracked-posts.js >> $L/tracked-posts.log 2>&1" >> $F
crontab $F
crontab -l | cat -A     # each line must end in $ with no mid-line $
```

⚠ **Verify the entries are single-line each.** Pasted heredocs in Windows-based SSH sessions tend to split long lines, and a split crontab entry silently never runs. Use `crontab -l | cat -A` to confirm — every entry ends in exactly one `$` (line terminator), no `$` in the middle.

## 11. First cookie capture

Each FetLife account needs an initial human login to seed cookies. After that the cron in step 10 will keep them alive.

From your local machine, connect TigerVNC Viewer to `<your-fetpost-host>.tail<abcdef>.ts.net:5901`. Inside the VNC desktop, open a terminal and run:

```bash
cd /root/fetpost/fetlife-poster
DISPLAY=:1 /usr/bin/node --env-file=/root/fetpost/.env src/setup-cookies.js
```

The script opens a real Chrome window. Log into FetLife, solve any Cloudflare challenge or 2FA, and confirm in the FetPost UI (or terminal prompt) when complete. The cookie file lands at `data/cookies/<Account Name>.json`.

**Multi-account tip:** FetLife may invalidate one session when you log in elsewhere as the same identity. If you have multiple accounts to seed, log them in **one at a time**, fully closing Chrome (or using separate profiles / incognito windows) between accounts.

## Verification checklist

After everything's installed, this should all hold simultaneously:

```bash
# Services
systemctl is-active fetlife-poster fetpost-ui tailscaled \
                    tailscale-nordvpn-bypass.timer
# expect: active × 4

# iptables rules (bypass)
iptables -t mangle -L OUTPUT -n -v | grep cgroup           # one rule, MARK 0xe1f1
iptables -t nat    -L POSTROUTING -n -v | grep -i masq     # one rule, mark match 0xe1f1

# Tailscale healthy with NordVPN connected
tailscale netcheck | head -10                              # UDP: true, DERP latency populated
tailscale status                                           # no health warnings

# Public-facing IP is NordVPN's, not your Droplet's
curl -s https://api.ipify.org && echo                       # NordVPN exit IP

# UI reachable over Tailscale Serve (run from another tailnet peer)
curl -I https://<your-fetpost-host>.tail<abcdef>.ts.net    # HTTP/2 200

# Cron entries are clean
crontab -l | cat -A                                         # two single-line entries
```

## Troubleshooting

### FetPost shows "offline" in Tailscale, but the app is reachable on the public IP

The Tailscale tunnel is dropping while the app itself is still up. Common causes:

1. **NordVPN reconnected and flushed iptables.** The watchdog timer in step 9 should re-add the rules within 60 seconds. Confirm with the iptables greps above.
2. **NordVPN allowlist is missing entries.** Re-run `nordvpn settings | grep -A 20 Allowlisted` and check all subnets from step 5 are present.
3. **`tailscaled` itself is unhealthy.** `journalctl -u tailscaled -n 50 --no-pager` will show authentication or DERP errors.

### Posts fail with "Not logged in — cookies may have expired"

Cookies fully expired. The cron's headless refresh can extend valid cookies but can't recover expired ones. Re-run the manual VNC flow from step 11 for the affected account.

### `journalctl -u fetlife-poster` shows "Image uploaded" + "Picture posted" but no post appears on FetLife

FetLife silently rejected the post (rate limiting, image moderation, account flagged). Log into the account directly in your regular browser and check for warnings or pending-review notices.

### Cron job log file isn't being written

Verify the crontab entry is a single line: `crontab -l | cat -A` — entries split across two physical lines will never run. Reinstall from step 10.

### `tailscale netcheck` shows `UDP: false` after a reboot or NordVPN reconnect

The iptables MARK + MASQUERADE rules aren't in place. Either the watchdog timer is disabled, or `/usr/local/sbin/tailscale-nordvpn-bypass.sh` has a syntax error. Run it manually (`/usr/local/sbin/tailscale-nordvpn-bypass.sh && echo OK`) — it should print `OK`. If not, the script content was corrupted (commonly by pasting heredocs through Windows SSH).

### NordVPN auto-connects to a server in the wrong country

`nordvpn set autoconnect on <Country>` to pin a default. Use `nordvpn countries` and `nordvpn cities <Country>` to find a specific city.

## Reboot test

Once everything's installed, reboot the Droplet to confirm the full stack comes up unattended:

```bash
reboot
```

After the box is back, wait ~60 seconds (for NordVPN auto-connect, Tailscale handshake, and the bypass watchdog to fire), then verify with the checklist above. The UI should be reachable over Tailscale, scheduled posts should resume firing on time, and `tailscale netcheck` should show `UDP: true`.

If anything's broken after a reboot, the most common culprit is that NordVPN connected before `tailscaled` started — restart `tailscaled` once and the bypass rules + DERP latencies should snap back into place.
