# Data flow

The system splits into two long-running processes plus a couple of supporting daemons. This document maps a request from the operator's browser all the way to FetLife and back.

## Process topology

```
┌──────────────────────────────────────────────────────────────────┐
│  Operator's browser                                              │
│    ↓ HTTPS                                                       │
│  Tailscale serve (per-tailnet only — not public)                 │
│  https://fetpost.tail01b83c.ts.net                               │
└──────────────────────────────────────────────────────────────────┘
                              ↓
              ┌───────────────────────────────────┐
              │  Droplet (Ubuntu, systemd)        │
              ├───────────────────────────────────┤
              │                                   │
              │  ┌─────────────────────────────┐  │
              │  │ nexuspost-ui (Node)         │  │
              │  │ 127.0.0.1:4000              │  │
              │  │ systemd: fetpost-ui.service │  │
              │  │                             │  │
              │  │ • Serves the dashboard UI   │  │
              │  │ • UI_PASSWORD auth          │  │
              │  │ • Proxies /api/* → backend  │  │
              │  └──────────────┬──────────────┘  │
              │                 │ x-service-token │
              │                 ↓                 │
              │  ┌─────────────────────────────┐  │
              │  │ fetlife-poster (Node)       │  │
              │  │ 127.0.0.1:3747              │  │
              │  │ systemd:                    │  │
              │  │   fetlife-poster.service    │  │
              │  │                             │  │
              │  │ • Scheduler + queue.json    │  │
              │  │ • Playwright (Chromium)     │  │
              │  │ • Cookie store              │  │
              │  │ • License gate              │  │
              │  └──────────────┬──────────────┘  │
              │                 │                 │
              │                 ↓ Playwright      │
              │  ┌─────────────────────────────┐  │
              │  │ Chromium (headless mostly)  │  │
              │  └──────────────┬──────────────┘  │
              │                 │                 │
              └─────────────────┼─────────────────┘
                                ↓
                ┌───────────────────────────────┐
                │  NordVPN (cgroup-marked)      │
                │  Masks droplet IP from CF     │
                └───────────────┬───────────────┘
                                ↓
                ┌───────────────────────────────┐
                │  Cloudflare                   │
                │  (FetLife's edge)             │
                └───────────────┬───────────────┘
                                ↓
                ┌───────────────────────────────┐
                │  FetLife.com                  │
                └───────────────────────────────┘
```

Supporting daemons on the droplet:
- **tailscaled** — Tailscale daemon, owns the `:443` listener for `fetpost.tail01b83c.ts.net`.
- **nordvpnd** — NordVPN daemon. Required (per project memory) for Cloudflare to not flag the droplet IP.
- **tigervncserver@:1.service** — headed Chrome display for manual cookie refresh.
- **websockify** — bridges noVNC on `:6080` to TigerVNC on `:5901`.

## Trust boundaries

| Boundary | Auth mechanism |
|---|---|
| Browser → Tailscale serve | Tailnet membership. The serve listener binds only to `100.64.110.8:443` (the tailnet IP), so non-tailnet traffic can't even connect. |
| Browser → `nexuspost-ui` | `UI_PASSWORD` cookie. The login screen sets a session cookie; every `/api/*` route checks it. |
| `nexuspost-ui` → `fetlife-poster` | `x-service-token: $FL_SERVICE_SECRET` header. The backend rejects anything without it. Localhost-only listener as a second layer. |
| `fetlife-poster` → FetLife | Per-account cookie file under `data/cookies/<accountId>.json`. Loaded into a fresh Playwright context per posting action. |
| `fetlife-poster` → license worker | Plaintext `licenseKey` over HTTPS. The worker validates against its server-side state. |

## Lifecycle of a scheduled post

1. **Compose** — operator picks an account in the UI, writes content, picks `scheduledAt`. UI sends `POST /api/posts/fetlife { postId, accountId, content, scheduledAt, postType, ... }`.

2. **Schedule** — `nexuspost-ui` proxies to `POST /posts` on the backend. `schedulePost()` validates, mutexes through `mutateQueue`, persists to `queue.json` (atomic write), and calls `armTimer(job)`.

3. **Wait** — `armTimer` is a wall-clock `setTimeout`. A 60-second sweep re-arms any unarmed scheduled jobs (backstop for missed timers on long-future schedules).

4. **Fire** — `executeJob(job)` runs. Order:
    - **License gate** — `isPostingAllowed()`. If not allowed, defer 30 min and retry.
    - **Pause gate** — if account `paused`, defer 30 min.
    - **Atomic claim** — flip status `scheduled → running` inside `mutateQueue`. Two timers racing can't both claim.
    - **Placeholder strip** — drop body lines that still contain `{Insert ...}` placeholders (fail-safe in case auto-resolve didn't fire).
    - **Auto-signature append** — if account has `autoSignature` and body doesn't already contain it.
    - **Post action** — `postToGroup` / `postStatus` / `postPicture` / `postEvent` — wrapped in `withWallClockBudget()` (4–8min depending on type).
    - **Post-action status update**:
        - Group post landed on a real post URL → `status = sent`.
        - Group post redirected to group page → `status = submitted_pending_moderation` (Sprint 2 distinction).
        - Status/picture confirmed in feed via screenshot inspection → `status = sent`.
        - Anything threw → `status = failed`, error message recorded.

5. **Persist** — `mutateQueue` saves the final status to `queue.json` atomically. `history.jsonl` gets an append-only audit entry.

6. **Notify** — best-effort Telegram notification fires (dynamic import; module-missing or transport failure never affects the scheduler).

## What runs at boot

`server.js` listen callback, in order:
1. `license.init()` — load license state from disk, kick a network revalidation, set 6h interval.
2. `rehydrateProgressJobs()` — load `data/jobs/*.json` from disk; any still `running` becomes `interrupted` so polling UIs see a real status.
3. `startSnapshotScheduler()` — first snapshot 30s after boot, then every 24h.
4. `startJanitor()` — first sweep 60s after boot, then every 24h.

Separately, `restoreScheduledJobs()` runs at module import time (top-level call in `scheduler.js`):
1. Convert `running` orphans to `outcome_unknown`.
2. Connectivity-class failed jobs from the last 3 days flip back to `scheduled` (staggered).
3. Every still-`scheduled` job gets a timer armed.

## What's in `data/`

```
data/
├── queue.json                    # scheduled posts (single source of truth)
├── credentials.enc               # AES-256-GCM encrypted username+passwords
├── accounts.json                 # per-account metadata (see account-meta-schema.md)
├── license.json                  # cached license state
├── history.jsonl                 # append-only audit log of every post attempt
├── cookies/                      # per-account FetLife cookies
│   └── <accountId>.json
├── venue-events/                 # per-account scan config + discovered events
│   └── <accountId>.json
├── campaigns/                    # per-account campaign library + runs
│   └── <accountId>.json
├── templates/                    # per-account saved post templates
│   └── <accountId>.json
├── mentions/                     # per-account FetLife mention/tag scan results
│   └── <accountId>.json
├── tracked-events/, tracked-posts/, events/, groups/   # discovery caches
├── jobs/                         # persistent progress jobs (Sprint 2)
│   └── <jobId>.json
├── snapshots/                    # nightly rollups (Sprint 3)
│   └── YYYY-MM-DD/
├── post-screenshots/             # diagnostic PNGs + HTML dumps from failures
└── metrics/                      # tracked-engagement snapshots
```

Atomic-written: queue.json, credentials.enc, accounts.json, license.json, every per-account JSON, jobs/*.json. See [atomic-writes.md](./atomic-writes.md).

## Cookies, in plain English

- Operator logs in once via headed Chrome (manual VNC, or the first-run wizard).
- Chrome stores `_fl_sessionid` + `remember_user_token` + Cloudflare cookies. We persist all of them to `data/cookies/<accountId>.json`.
- Every posting action loads that cookie file into a fresh Playwright context. The `remember_user_token` keeps the session alive.
- Sessions decay <48h. Layer-1 + Layer-2 + Layer-3 recovery (see [cookie-recovery.md](./cookie-recovery.md)) keep the file fresh.
- The Sprint 3 guard refuses to overwrite the file with a Cloudflare-only ("anonymous") cookie set, which was the most common silent-failure mode.
