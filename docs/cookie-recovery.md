# Cookie recovery runbook

FetLife sessions expire faster than 48 hours — empirically more like 24-36h when accessing from non-residential IPs (the droplet). The system has a three-layer recovery story so this isn't an emergency every other day.

## The three layers

```
┌───────────────────────────────────────────────────────────────────┐
│  Layer 1: in-process auto-refresh                                 │
│  When? Any code path catches "Not logged in" / login-form content │
│  Where? extractor.js:autoRefreshCookies() → tryHeadlessRefresh()  │
│  Wins when:  the remember_user_token is still valid               │
│  Loses when: 2FA prompt OR the token has been invalidated         │
├───────────────────────────────────────────────────────────────────┤
│  Layer 2: 12-hour cron headless refresh                           │
│  When? Twice daily (04:00 and 16:00 UTC on the droplet)           │
│  Where? src/refresh-cookies.js (called via cron — see DEPLOYMENT) │
│  Wins when:  same as Layer 1, but pre-emptive                     │
│  Loses when: same as Layer 1 — and it's silent if it loses        │
├───────────────────────────────────────────────────────────────────┤
│  Layer 3: manual VNC login                                        │
│  When? Operator clicks "Refresh cookies" in the dashboard, OR     │
│        SSHes in and runs `node src/setup-cookies.js`              │
│  Where? extractor.js:extractCookiesForAccount() — opens a headed  │
│         Chrome that the operator drives via noVNC at :6080        │
│  Wins when: always, modulo CAPTCHA/2FA the human can solve        │
└───────────────────────────────────────────────────────────────────┘
```

All three save into `data/cookies/<accountId>.json`. Layer 1 + Layer 2 share `tryHeadlessRefresh()` — the cron is just a scheduled trigger for the same code path.

## Anonymous-cookie guard

(Added Sprint 3.) Every save path now runs `looksLikeRealSession()` before persisting. A cookie file is only written if at least one of these is present with a value ≥16 chars:

- `_fl_sessionid`
- `_session_id`
- `remember_user_token`

If none are present (typical after a Cloudflare-only nav), the save **aborts** and the previous file is preserved. Before this guard, the most common failure mode was silently overwriting good cookies with anonymous ones — operator would only discover hours later when a post failed with "session expired."

## How to read symptoms

| Symptom | Probable cause | Fix |
|---|---|---|
| Recent post fails with "FetLife session expired — landed on the login form" | Layer 1 caught the dead session, refresh hadn't run yet | Manual VNC refresh for THAT account. The next post should succeed. |
| Logs show `[extractor] Headless refresh for X produced anonymous cookies (no usable session cookie found...)` | The cron tried but only got Cloudflare cookies | Manual VNC refresh. If it keeps recurring, the account's `remember_user_token` is dead — see "Persistent failures" below. |
| Dashboard cookie-freshness widget shows the file is fresh but posts still fail | Anonymous cookies saved before the Sprint 3 guard, or guard bypassed somehow | Manual VNC refresh. Cookies file mtime is fresh but content is useless. |
| Multiple accounts all fail at once with "session expired" | Cron didn't run, or NordVPN was down during the cron window | Manual VNC refresh per account. Check `journalctl -u fetlife-poster --since "12 hours ago"` for `[extractor]` lines. |
| Refreshing via VNC succeeds but the next post still says "expired" | UI loaded a stale cookie path — service restart picks up new file | `systemctl restart fetlife-poster.service` |

## Persistent failures: when manual VNC keeps being needed

If a specific account requires manual VNC refresh more than once a week, FetLife's session-persistence for that account is broken in a way headless refresh can't fix. Common causes:

1. **The account doesn't have "Remember me" set when logging in.** The extractor's auto-tick init script (`extractor.js`:152-171) handles this on every fresh login, but a one-time hand-login from a different device can wipe the long-lived token. Manual VNC refresh + verify the box is checked.
2. **FetLife sees the droplet IP as suspicious.** Per project memory, NordVPN must stay on to mask the droplet IP from Cloudflare. If NordVPN flapped during the cron window, FetLife's risk score goes up + sessions get cut shorter. Check NordVPN status: `systemctl status nordvpn`.
3. **2FA was turned on for the account.** Headless refresh can't solve the prompt. Either turn 2FA off on FetLife or accept that this account needs daily manual VNC.

## Manual VNC refresh — step by step

1. Open the dashboard, go to Accounts.
2. Click "Refresh cookies" for the failing account.
3. The UI opens a noVNC tab pointed at the droplet's `:6080` (proxied through `nexuspost-ui` for auth).
4. Inside the noVNC window, a Chrome window is open at `https://fetlife.com/sign_in` with the username pre-filled. The "Remember me" checkbox is auto-ticked.
5. Type the password. Solve any CAPTCHA. Submit.
6. The extractor polls for a session cookie. When it lands, the Chrome window closes automatically and the saved-cookies count appears in the dashboard.

If the headless Chrome process is stuck or doesn't appear:
```sh
ssh root@<droplet>
ps -ef | grep chrom        # find the stuck Chromium
kill -9 <pid>              # force-quit it
# Retry from the dashboard.
```

## Cron-mode environment

The cron sets `FETPOST_CRON=1`, which makes the extractor:
- Skip the interactive "press Enter to continue" prompts (it can't read stdin in cron).
- Cap the auto-login wait at 30s before giving up (vs. waiting indefinitely in interactive mode).
- Still falls back to logging the failure — there's no human at the keyboard to drive VNC.

If the cron fails for an account, the operator sees it only in the dashboard freshness widget (which colors the account amber/red based on cookie file age). No proactive email/Telegram alert today; that's documented as a Sprint 3+ followup that isn't done.

## Coalescing + cooldown

`autoRefreshCookies()` deduplicates concurrent requests for the same account (the in-flight Map). After completion it applies a per-outcome cooldown:

- **Success** → 30s cooldown. No point refreshing again that soon.
- **Failure** → 5s cooldown. Lets a burst of scans retry instead of all silently failing after the first attempt.
