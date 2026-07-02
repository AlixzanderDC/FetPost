# Account meta schema

Every account in `data/accounts.json` is an object keyed by `accountId`. The credentials themselves (username + password) live encrypted in `data/credentials.enc` — `accounts.json` holds everything else.

This document is the source of truth for what fields can appear on an account. Add a new field? Update this file in the same commit.

Both files are written atomically through `util/atomic-json.js` and serialized through the `mutateCreds` chain in `credentials.js` (see [atomic-writes.md](./atomic-writes.md)).

## Fields owned by credentials/auth flow

These are managed by `storeCredentials()` / `updateAccountStatus()`. Operator can change them, but only via the dedicated APIs — `updateAccountFields()` refuses to touch them (the `PROTECTED_FIELDS` set in `credentials.js`).

| Field | Type | Written by | Notes |
|---|---|---|---|
| `accountId` | string | `storeCredentials` | Stable internal identifier. Used everywhere as the account key. Never changes for the life of the account. |
| `username` | string | `storeCredentials` | The FetLife display username (used in `@`-mention paths, e.g. `/QueerDudesParty`). |
| `accountType` | enum | `storeCredentials`, `updateAccountType` | One of `'venue'`, `'organization'`, `'individual'`, `'festival'`. Defaults to `'organization'`. Drives UI conditionals (Venue Events tab is venue-only; Campaigns tab is festival-only). |
| `groupName` | string \| null | `storeCredentials` | Display label for the account in the dashboard / org-filter dropdown. Defaults to `null` (UI falls back to `accountId`). |
| `addedAt` | ISO timestamp | `storeCredentials` | When the account was first connected. Immutable after that. |
| `lastUsed` | ISO timestamp | `updateAccountStatus` | Last time the scheduler attempted a posting action with this account. |
| `lastStatus` | string | `updateAccountStatus` | `'ok'` after a successful post, `'post_failed'` after a failure, `'login_failed'` from `testLogin`. Surfaced in the Accounts UI. |

## Operator-editable fields (`updateAccountFields` path)

These can be set via `PATCH /accounts/:accountId` — typically from a dashboard control. Setting a value to `null` or `''` deletes the field from the account meta.

### Notification + signature

| Field | Type | Purpose | Owner UI |
|---|---|---|---|
| `autoSignature` | string | Text appended to every status/picture/event/group body the scheduler fires. The scheduler dedupes it if the body already contains the signature. Per-post opt-out via job's `skipAutoSignature`. | Accounts → account-level "Auto-signature" textarea |
| `telegramBotToken` | string | Telegram bot HTTP API token. Failures + post-published notifications go through this. | Accounts → Telegram settings |
| `telegramChatId` | string | Recipient chat ID for the Telegram bot. | Accounts → Telegram settings |

### Calendar + events

| Field | Type | Purpose | Owner UI |
|---|---|---|---|
| `websiteCalendarUrl` | URL | iCal feed pulled by `website-calendar.js` to surface events that aren't on FetLife yet (Auto-fill in Batch Compose, Weekly Digest). | Accounts → Website Calendar |
| `hiddenCalendarEvents` | string[] | Event URLs the operator chose to hide from the dashboard calendar. Set by Venue Events → Hide from calendar. | Venue Events tab |
| `paused` | boolean | When `true`, the scheduler defers every job for this account by `PAUSE_DEFER_MS` (30 min). Unpausing triggers `rearmAccountSchedule` to fire any due-during-pause posts immediately. | Accounts → Pause posting toggle |

### Venue scan config (venue accounts)

`venueAddress`, `searchTerms[]`, `cityUrl`, `scanFromDate`, `scanToDate` live in a separate per-account file at `data/venue-events/<accountId>.json` under the `config` key — NOT in `accounts.json`. See [data-flow.md](./data-flow.md) for the venue-events module.

### Marketing-template defaults

| Field | Type | Purpose | Owner UI |
|---|---|---|---|
| `eventPromoTemplate` | string | Default body used when Batch Compose generates "promote each event" rows from a calendar. | Accounts → Event promo template |
| `digestTitle` | string | Default title for Weekly Digest posts. | Accounts → Weekly Digest defaults |
| `digestFooter` | string | Trailing text appended to every Weekly Digest body. | Accounts → Weekly Digest defaults |

### Calendar export

| Field | Type | Purpose | Owner UI |
|---|---|---|---|
| `iCalToken` | string | Secret token issued by `POST /accounts/:accountId/ical-token`. Lets a calendar app subscribe to `/calendar/:accountId/:token.ics` to see this account's scheduled FetPost posts as a calendar feed. Treat like a password. | Accounts → Get iCal URL |

### Removed / legacy

| Field | Status |
|---|---|
| `discordWebhookUrl` | Removed in the Discord wind-down (see commit history). May still appear on accounts that pre-date the removal — silently ignored. Operator can `null` it out via the Accounts UI. |

## How to add a new field

1. Update this doc in the same PR. If the field has a strict shape (URL, enum, etc.), document the validation.
2. Wire UI to send `PATCH /accounts/:accountId { newField: value }`. Don't add a bespoke endpoint per field.
3. If the field is sensitive (anything looking like a credential or token): consider whether it should be in `accounts.json` at all, or whether it deserves its own encrypted store like `credentials.enc`. `accounts.json` is currently plaintext.
4. If reads happen at fire-time (scheduler hot path), grab the account once via `getAccount()` and pass through, rather than calling `getAccount` repeatedly inside `executeJob`.
