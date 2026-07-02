# Environment variables

Every `process.env.X` reference in the codebase. Marked **REQUIRED** if production won't boot or function without it; everything else is optional.

## REQUIRED in production

### `FL_MACHINE_SECRET`

The AES-256-GCM key for `data/credentials.enc`. Must be ≥32 hex chars.

- **Read by:** `credentials.js`, `google-oauth.js`, `canva.js` (same key — Sprint 4 leaves this scoped to credentials only; Canva/Google tokens are TODO if they're ever shipped to a multi-host deployment).
- **Boot guard (Sprint 1):** if unset OR shorter than 32 hex chars, the service refuses to start with a clear error. Set `FETPOST_DEV=1` to bypass for local dev (uses a publicly-known fallback string, which is fine locally and dangerous in prod).
- **Generate:**
  ```sh
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  Append the output to `.env` as `FL_MACHINE_SECRET=<value>`.
- **Important:** if you ever change this value, every `credentials.enc` file that was encrypted with the old key becomes unreadable. The boot guard will throw with a descriptive error. Recover by restoring `credentials.enc` from a snapshot taken under the old key (and restoring the old key), OR by deleting `credentials.enc` and re-adding every account.

### `FL_SERVICE_SECRET`

Shared secret between `nexuspost-ui` and `fetlife-poster`. The backend rejects any request without `x-service-token: <this value>`.

- **Read by:** `fetlife-poster/src/server.js` (auth middleware), `nexuspost-ui/src/server.js` (proxyRequest helper).
- **Default if unset:** `'change-this-secret'`. Boot prints a warning but doesn't refuse to start. Production deployments MUST override this — a known default lets any localhost process call privileged endpoints.
- **Generate:** same procedure as `FL_MACHINE_SECRET`. Both services must read the same value, so set it once in the shared `.env`.

## OPTIONAL — but you almost certainly want them set

### `UI_PASSWORD`

Dashboard login password. Only used if `data/admin.json` doesn't exist (first-run wizard creates `admin.json` from the first password the operator picks).

- **Read by:** `nexuspost-ui/src/server.js` login route.
- **Default if unset:** `'fetpost'` (was `'nexuspost'` pre-Sprint-4). Boot prints a warning if neither this nor `admin.json` is set. **Change this in production.**

### `LICENSE_SERVER_URL`

URL of the FetPost license worker (Cloudflare Worker). If unset, the license module sets `status='unenforced'` and posting runs unrestricted — appropriate for the public-repo / self-hosted path.

- **Read by:** `fetlife-poster/src/license.js`.
- **Default if unset:** `''`. License enforcement OFF.
- **Production paid deployments** set this to point at the worker.

## OPTIONAL — situational

### `FETPOST_CRON`

When set to `'1'`, signals cron-mode operation:
- `refresh-cookies.js` logs `DISPLAY=…` and uses headless-only flow.
- `extractor.js`'s headed extraction caps autofill wait at 30s instead of prompting for human input.

Without it, those scripts assume interactive use.

- **Read by:** `extractor.js`, `refresh-cookies.js`.
- **Used in:** the systemd timer / Task Scheduler entry that triggers `refresh-cookies.js` every 12h.

### `FETPOST_FORCE_HEADED`

When set to `'1'`, skips the headless refresh attempt entirely and goes straight to headed (VNC) extraction. Useful for debugging or when Cloudflare keeps blocking headless.

- **Read by:** `extractor.js`, `nexuspost-ui/src/server.js`.
- **Default if unset:** undefined → normal headless-first flow.

### `FETPOST_DEV`

When set to `'1'`, allows `credentials.js` to boot without `FL_MACHINE_SECRET`, falling back to the hardcoded `getMachineId()` string. **Dev only.** Production with this set has a publicly-known encryption key.

- **Read by:** `credentials.js` boot guard.
- **Default if unset:** undefined → boot guard requires `FL_MACHINE_SECRET`.

### `FL_ONLY_ACCOUNT`

Filter for `setup-cookies.js` / `extractor.js` extractAllCookies — limits the operation to a single named account. Overridable by CLI arg.

- **Read by:** `setup-cookies.js`.
- **Default if unset:** all accounts processed.

### `DISPLAY`

Standard X11 display variable. Required for headed Chrome on Linux (cron context). The cron line in DEPLOYMENT.md sets it.

- **Read by:** the cron environment + Chromium (not by FetPost code directly).
- **Production cron:** `DISPLAY=:1` (the TigerVNC display).

### `VNC_WS_TARGET`

WebSocket URL the noVNC proxy connects to.

- **Read by:** `nexuspost-ui/src/server.js`.
- **Default if unset:** `'ws://127.0.0.1:6080'` (default websockify→TigerVNC bridge).
- **Override** only if you put websockify on a non-default port.

## OPTIONAL — third-party integrations

These are feature-gated. The integrations only show up in the UI when their env vars are set.

### Canva integration

| Variable | Purpose |
|---|---|
| `CANVA_CLIENT_ID` | Canva API OAuth client ID. |
| `CANVA_CLIENT_SECRET` | Canva API OAuth client secret. |
| `CANVA_REDIRECT_URI` | OAuth callback URL — set to `https://<your-tailnet-host>/oauth/canva` (or wherever your UI is reachable). |

All three must be set for Canva features to appear. Buy/configure these at https://www.canva.com/developers/.

### Google Sheets / OAuth

| Variable | Purpose |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client ID for Sheets export. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret. |
| `GOOGLE_OAUTH_REDIRECT_URI` | OAuth callback URL. |

All three must be set for Google Sheets export to appear. Configure at https://console.cloud.google.com.

## A `.env` for production should contain at minimum

```dotenv
FL_MACHINE_SECRET=<64-hex-chars>
FL_SERVICE_SECRET=<64-hex-chars>
UI_PASSWORD=<your-dashboard-password>
LICENSE_SERVER_URL=https://fetpost-license.example.workers.dev
```

Everything else either has a sensible default or is feature-gated.

## A `.env` for local dev can be

```dotenv
FETPOST_DEV=1
FL_SERVICE_SECRET=dev-secret-not-for-prod
UI_PASSWORD=dev
```

`FETPOST_DEV=1` unlocks the weak-key fallback so you don't have to manage a real secret locally.

## Things to never do

- **Never** commit `.env` to git. The repo's `.gitignore` excludes it; verify with `git check-ignore .env` before any new `.env`-adjacent file is added.
- **Never** put `FL_MACHINE_SECRET` in a non-encrypted backup. Provider snapshots of the droplet include `.env`, which is acceptable; rsync'ing `.env` to a third-party storage bucket needs the env-encrypted-at-rest path that Sprint 3 deferred.
- **Never** rotate `FL_MACHINE_SECRET` without snapshotting `credentials.enc` first. Once you change the key, the old file is unreadable.
- **Never** set `FETPOST_DEV=1` in production "just to get things working." That's the difference between "your customer data is encrypted" and "your customer data is encrypted with a key everyone can derive."
