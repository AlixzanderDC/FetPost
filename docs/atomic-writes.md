# Atomic writes + per-key mutex

Every persistent state file in `data/` is written through `util/atomic-json.js` so a crash mid-write can never leave a truncated file. Every read-modify-write that needs serialization goes through one of the keyed mutexes. This document explains when to use which, and what NOT to do.

## The helpers

In `fetlife-poster/src/util/atomic-json.js`:

```js
writeJsonAtomic(filePath, value, { pretty = true })
   // JSON.stringify(value) → write to filePath.tmp → fsync → rename to filePath.
   // POSIX rename(2) is atomic within the same filesystem.

writeRawAtomic(filePath, contents)
   // Same as above but for non-JSON payloads (e.g. credentials.enc base64).

readJsonStrict(filePath, { defaultIfMissing, label })
   // Reads + JSON.parse. Returns defaultIfMissing if the file doesn't exist.
   // If the file EXISTS but parse fails, THROWS with a labeled error message.

createKeyedMutex()
   // Returns mutate(key, work) — serializes work(key) for the same key,
   // parallel for different keys. Per-account / per-file scoping.
```

## When to use what

### JSON state file that gets read-modify-written

Use `writeJsonAtomic` for the write, `readJsonStrict` for the read, and serialize through a mutex if multiple call paths touch the same file.

Reference: `venue-events.js` `readStore` / `writeStore` + `mutateStore(accountId, ...)`.

```js
import { writeJsonAtomic, readJsonStrict, createKeyedMutex } from './util/atomic-json.js';

const mutateStore = createKeyedMutex();

async function readStore(accountId) {
  return await readJsonStrict(fileFor(accountId), {
    defaultIfMissing: { events: [] },
    label: `venue-events/${accountId}.json`,
  });
}

async function writeStore(accountId, store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeJsonAtomic(fileFor(accountId), store);
}

export async function setRsvp(accountId, eventUrl, status) {
  return await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    /* mutate */
    await writeStore(accountId, store);
  });
}
```

### Encrypted binary file

Use `writeRawAtomic` because the contents aren't JSON. Reference: `credentials.js:saveAllCredentials`.

```js
const encrypted = encrypt(JSON.stringify(creds), MACHINE_SECRET);
await writeRawAtomic(CREDS_FILE, encrypted);
```

### Append-only log file

`history.jsonl` uses `fs.appendFile`, NOT atomic writes. POSIX appends ≤ PIPE_BUF are atomic at the kernel level, and the cost of an atomic rewrite on every append would dominate. The reader tolerates corrupt lines individually (Sprint 1 hardened this — see `history.js:getPostHistory`).

Don't add atomic writes to append-only files.

### Cache file that's safe to recompute

`data/groups/<accountId>.json`, `data/events/<accountId>.json`, etc. — caches the system can re-scrape if they're missing. Use `writeJsonAtomic` for the write (cheap, prevents corruption) and `readJsonStrict` with `defaultIfMissing: null` for the read (caller treats `null` as "not cached yet, scrape it").

Reference: `discovery.js:refreshGroupsForAccount` / `readCachedGroups`.

## Which files use atomic writes today

| File / pattern | Module |
|---|---|
| `queue.json` | `scheduler.js` (oldest atomic-write — its own homegrown tmp+rename; predates the helper) |
| `credentials.enc` | `credentials.js` |
| `accounts.json` | `credentials.js` |
| `license.json` | `license.js` |
| `venue-events/<account>.json` | `venue-events.js` |
| `campaigns/<account>.json` | `campaigns.js` |
| `templates/<account>.json` | `templates.js` |
| `mentions/<account>.json` | `mentions.js` |
| `tracked-events/<account>-tracked.json` | `tracked-events.js` |
| `tracked-posts/<account>-tracked.json` | `tracked-posts.js` |
| `events/<account>.json`, `events/<account>-past.json`, `events/<account>-attending.json`, `groups/<account>.json` | `discovery.js` |
| `jobs/<jobId>.json` | `progress.js` (Sprint 2) |
| `snapshots/YYYY-MM-DD/...` | `snapshot.js` (uses raw `copyFile` — atomicity here is just rename-of-the-final-file; intermediate state is fine because the snapshot directory is never read until the next snapshot day) |

## The mutex pattern

Three patterns in use:

### Single global chain — one file, all callers serialize

`scheduler.js:queueOpChain` (one queue.json). `credentials.js:credsOpChain` (one creds + meta pair).

```js
let opChain = Promise.resolve();
function mutate(work) {
  const next = opChain.then(async () => work());
  opChain = next.catch(() => {});
  return next;
}
```

Use when: there's exactly one file (or one logical resource) that every mutation touches.

### Per-key chain — N files, callers for the same file serialize, different files parallel

`createKeyedMutex()` factory. Used by `venue-events.js:mutateStore`, `campaigns.js:mutateStore`.

```js
const mutate = createKeyedMutex();
await mutate(accountId, async () => { /* read-modify-write for THIS account */ });
```

Use when: per-account files. Different accounts don't conflict; same-account mutations must serialize.

### No mutex needed

If the data is write-only-from-one-path AND the path is itself serialized by its caller (e.g. inside an already-mutexed `mutateQueue`), you don't need a second mutex around it. Adding one creates priority-inversion risk for no benefit.

## What goes wrong without these

The system has been bitten by every one of these — listed here as historical receipts, not hypotheticals:

| Bug | Cause | Fix landed in |
|---|---|---|
| 244 jobs lost | `loadQueue()` returned `{}` on parse error; next save overwrote the damaged file with empty state | Sprint 1: `readJsonStrict` throws |
| Batch Compose: scheduled 5 posts, only 1 saved | Five `mutateQueue` calls raced, each loaded the same snapshot, each saved their own version → last write won | Pre-Sprint-1 single-chain mutex on `queueOpChain` |
| Concurrent venue RSVP + scan finish: RSVP "didn't take" | Scan's final `writeStore` clobbered the freshly-set rsvpStatus | Sprint 1: per-account `mutateStore` on venue-events |
| `credentials.enc` truncated after SIGKILL → service won't boot | Direct `fs.writeFile` on top of the live file → crash mid-write leaves partial bytes → next decrypt fails | Sprint 1: `writeRawAtomic` |
| Operator typed `FL_MACHINE_SECRET=` (blank) in `.env` → service booted with the publicly-known fallback key, silently re-encrypted everything with a worthless key | No boot-time validation | Sprint 1: boot guard throws unless secret ≥32 hex chars OR `FETPOST_DEV=1` |

## Things to never do

- **Never** use `fs.writeFile` on a file in `data/` that's read by anything else. Always go through `writeJsonAtomic` or `writeRawAtomic`. Direct `writeFile` is fine for stdout-like / debug-only files (`data/metrics/debug-*.txt`) where the worst case is "lost a debug dump."
- **Never** silently catch a parse error and return empty state. The "return `{}` on parse failure" pattern is what caused the 244-job loss. Always either throw, log loudly, or return a sentinel the caller knows means "corrupted, do something about it."
- **Never** mutate a JSON file outside the mutex it's supposed to be protected by. If you find yourself wanting to do this, add a wrapper function in the owning module — don't reach in.
- **Never** assume `rename(2)` is cross-filesystem. The `.tmp` file MUST be on the same filesystem as the target. We achieve this by always writing `<path>.tmp` next to `<path>` — don't put the tmp file under `/tmp/` (which may be tmpfs / a different mount).
