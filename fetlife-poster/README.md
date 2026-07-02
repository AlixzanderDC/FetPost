# fetlife-poster

Local automation service for FetLife — the backend service in the FetPost stack.

Runs on `http://127.0.0.1:3747` and is only accessible from your machine.
Never exposes credentials to the internet.

---

## Architecture

```
FetPost UI (nexuspost-ui — folder name pending rename)
      │
      │  HTTP on localhost:3747 (x-service-token: FL_SERVICE_SECRET)
      ▼
fetlife-poster (this service)
      │
      ├── credentials.js  — AES-256-GCM encrypted credential store
      ├── scheduler.js    — Persistent job queue with timer restoration
      ├── poster.js       — Playwright browser automation
      └── history.js      — Append-only audit log

data/
  credentials.enc   ← encrypted credentials (never commit this)
  accounts.json     ← account metadata, no passwords
  queue.json        ← scheduled post queue
  history.jsonl     ← append-only audit log
  sessions/         ← saved browser sessions (cookies)
```

---

## Setup

### 1. Install dependencies

```bash
cd fetlife-poster
npm install
npx playwright install chromium
```

### 2. Set environment variables

Create a `.env` file (or set in your shell/process manager):

```env
# Shared secret between this service and the FetPost UI
FL_SERVICE_SECRET=generate-a-long-random-string-here

# Optional: machine-specific key for credential encryption
# If not set, a default is derived from platform/arch (less secure)
FL_MACHINE_SECRET=another-long-random-string
```

Generate secrets with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Start the service

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start

# Or with dotenv loaded:
node --env-file=.env src/server.js
```

### 4. Keep it running

On a dedicated machine/server, use a process manager:

```bash
# PM2 (recommended)
npm install -g pm2
pm2 start src/server.js --name fetlife-poster --env-file .env
pm2 save
pm2 startup  # auto-start on reboot
```

---

## API Reference

All endpoints require the header: `x-service-token: <FL_SERVICE_SECRET>`

### Accounts

| Method | Path | Description |
|--------|------|-------------|
| POST | `/accounts` | Add/update account |
| GET | `/accounts` | List accounts (no passwords) |
| DELETE | `/accounts/:id` | Remove account |
| POST | `/accounts/:id/test` | Test login |

**POST /accounts body:**
```json
{
  "accountId": "leather-rope-dc-main",
  "username": "LeatherRopeDC",
  "password": "...",
  "groupName": "Leather & Rope DC"
}
```

### Posts

| Method | Path | Description |
|--------|------|-------------|
| POST | `/posts` | Schedule a post |
| GET | `/posts` | Get queue |
| DELETE | `/posts/:id` | Cancel post |
| GET | `/history` | Audit log |

**POST /posts body (status):**
```json
{
  "postId": "unique-id",
  "accountId": "leather-rope-dc-main",
  "content": "Post text here",
  "scheduledAt": "2026-05-09T19:00:00.000Z",
  "postType": "status"
}
```

**POST /posts body (event):**
```json
{
  "postId": "unique-id",
  "accountId": "leather-rope-dc-main",
  "content": "Event description",
  "scheduledAt": "2026-05-09T19:00:00.000Z",
  "postType": "event",
  "eventDetails": {
    "title": "Rope Fundamentals",
    "description": "Monthly skill share...",
    "startDate": "2026-05-16T19:00:00.000Z",
    "location": "TBA",
    "dresscode": "Casual",
    "isPrivate": false
  }
}
```

---

## Security notes

- Credentials are encrypted with AES-256-GCM before being written to disk
- Sessions (cookies) are stored in `data/sessions/` — protect this directory
- The service only binds to `127.0.0.1` — not accessible over the network
- Set `FL_MACHINE_SECRET` in your environment for stronger key derivation
- Never commit `data/` to version control — add it to `.gitignore`

---

## FetLife UI changes

FetLife doesn't have a public API, so `poster.js` uses CSS selectors to interact
with their UI. If posting breaks after a FetLife update, the selectors in
`poster.js` may need updating. The `postStatus()` function tries multiple
selector fallbacks to be resilient.

To debug, set `headless: false` in `launchContext()` to watch the browser.

---

## .gitignore additions

```
data/
.env
node_modules/
```
