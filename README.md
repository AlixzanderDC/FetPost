# FetPost

A self-hosted scheduling and cross-posting tool for [FetLife](https://fetlife.com). Schedule status posts, write group cross-posts, fan one event announcement out to multiple groups with automatic staggered timing, and manage multiple accounts from a single dashboard.

> **Disclaimer:** This tool automates a service whose Terms of Service may prohibit automation. Use it for your own accounts, at your own risk. Don't spam, don't post on behalf of others without consent, and respect rate limits. The author is not affiliated with FetLife.

## What it does

- **Schedule status posts** for any time in the future, per account.
- **Group cross-post** — author one event announcement and fan it out to a list of FetLife groups with a 60–120s stagger between posts (avoids looking automated).
- **Multi-account support** — run posts under several FetLife identities from one UI.
- **Calendar view** — see what's scheduled across all accounts, click any chip to inspect or cancel a post.
- **Saved templates** scoped per account/per group for posts you write often.
- **Auto-discovery** of your joined groups and organized/attending events for quick selection.
- **Image attachments** with thumbnail previews in the calendar and queue.
- **Cookie-based authentication** — log in once via a real browser, then the bot uses session cookies for all subsequent posting (no headless password-login race against Cloudflare).

## Architecture

Two Node.js services run side by side, communicating over localhost HTTP:

```
Browser  ─►  nexuspost-ui (port 4000)  ─HTTP─►  fetlife-poster (port 3747)
                  │                                      │
                  │                                      ├── credentials.js  (AES-256-GCM)
                  │                                      ├── scheduler.js    (persistent timer queue)
                  │                                      ├── poster.js       (Playwright + real Chrome)
                  │                                      └── extractor.js    (cookie capture)
                  └── public/index.html  (single-page UI)
```

- **`nexuspost-ui/`** — Express + a single-page HTML dashboard.
- **`fetlife-poster/`** — Playwright-based automation service. Bound to `127.0.0.1` only.

## Quick start

### Prerequisites
- Node.js ≥ 20.6 (for `--env-file` support)
- Google Chrome (Playwright drives a real Chrome, not Chromium, to avoid bot detection)

### Install

```bash
git clone https://github.com/<your-username>/FetPost.git
cd FetPost

# Copy the env template and generate secrets
cp .env.example .env
node -e "console.log('FL_SERVICE_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
node -e "console.log('FL_MACHINE_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
# Edit .env and remove the placeholder values

# Install service dependencies
(cd fetlife-poster && npm install)
(cd nexuspost-ui && npm install)
```

### Run

**Linux / macOS:**
```bash
./start.sh
```

**Windows:**
```cmd
start.cmd
```

Open `http://localhost:4000` in your browser. Add a FetLife account; cookie capture will open a Chrome window where you log in once, and from there scheduling and posting works headless.

## Cookie capture

FetLife sits behind Cloudflare, which actively blocks automated logins from datacenter IPs and challenges any login that looks scripted. Rather than play that arms race, FetPost captures session cookies through a single human login:

1. You click **Add Account** in the UI.
2. A real Chrome window opens (visible — `headless: false`).
3. You log in normally. Solve any Cloudflare challenge or 2FA prompt.
4. Once logged in, you click "I've logged in" in the UI (or hit Enter in the spawning terminal).
5. FetPost saves the cookies. All future posts use those cookies — no password login, no Cloudflare challenge.

Cookies typically last 1–4 weeks. A scheduled cron job at 4 AM every other day attempts a silent **headless refresh** (revisit `/home`, FetLife rotates cookies, re-save) to extend their life. When the cookies fully expire, the cron fails and you redo the manual login flow.

## 24/7 deployment

For the bot to fire scheduled posts when your laptop is off, run FetPost on a small server. The author runs it on a $6/month DigitalOcean Droplet:

- **Tailscale** for private remote access from any device (UI is bound to `127.0.0.1`; Tailscale tunnels in).
- **NordVPN** on the server to mask the datacenter IP from Cloudflare (residential-style VPN exits don't trigger as many challenges).
- **systemd** unit for auto-start on boot.
- **TigerVNC + XFCE** for occasional manual cookie refreshes.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the full setup walkthrough. *(Coming soon — for now, the gist is: install Node + Chrome + Tailscale + NordVPN + TigerVNC, scp the repo, point the UI at `http://<tailscale-name>:4000`.)*

## Security model

- Credentials are encrypted at rest with AES-256-GCM. The encryption key is the `FL_MACHINE_SECRET` env var, derived per machine.
- Both services bind to `127.0.0.1` only — the UI service has no external listener by default.
- Inter-service HTTP requests carry a shared secret (`FL_SERVICE_SECRET`) header.
- `data/` is in `.gitignore` — credentials, cookies, scheduled posts, and post history never leave your machine.
- The default deployment exposes the UI through Tailscale (private tailnet only). Don't put `:4000` on the public internet.

## Project status

Built and used in production by the author since early 2026. Active development is focused on FetLife. Earlier versions targeted Bluesky / OnlyFans / Fansly / ManyVids / NiteFlirt; that code has been removed but git history may still show traces of it.

## Contributing

Issues and PRs welcome. Please don't file anything that would help someone abuse the tool (e.g., evading FetLife's rate limits, posting on behalf of accounts you don't own). The README is in plain English on purpose — if something's confusing, that's a bug.

## License

MIT — see [LICENSE](LICENSE).
