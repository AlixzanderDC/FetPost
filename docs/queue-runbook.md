# Queue runbook

`data/queue.json` is the system's single most important file. It contains every scheduled / running / sent / failed / outcome-unknown / pending-moderation post. Lose this file and you lose every post the operator scheduled. The system once lost 244 jobs to a single bug in this file's loader — that lesson is baked into the current code.

## File format

```jsonc
{
  "<postId>": {
    "postId": "fetlife-<accountId>-<timestamp>-<rand>",
    "accountId": "CrucibleCon",
    "scheduledAt": "2026-10-24T18:00:00.000Z",
    "status": "scheduled",         // see enum below
    "postType": "status",          // status | picture | event | group_event
    "content": "...",              // status/picture body
    "title": "...",                // group_event only
    "body": "...",                 // group_event / event body
    "groupId": "138711",           // group_event only
    "eventDetails": { ... },       // event only
    "images": [ ... ],             // picture / group_event with attachments
    "eventUrl": "https://...",     // optional source-tracking
    "parentId": "...",             // for batch-generated children (cross-post fanout)
    // Lifecycle stamps:
    "createdAt": "...",
    "updatedAt": "...",
    "sentAt": "...",               // set when status = sent
    "failedAt": "...",             // set when status = failed
    "error": "...",                // failure reason
    "result": { "url": "...", "moderated": false },  // post outcome details
    "moderationNote": "...",       // for submitted_pending_moderation
    "outcomeUnknownAt": "...",     // for outcome_unknown
    "confirmedAt": "...",          // set when operator clicks "Confirm sent"
    "deferredUntil": "...",        // license/pause defer
    "deferReason": "...",
    "autoRetriedAt": "...",        // boot connectivity-retry stamp
    "skipAutoSignature": false     // per-post opt-out
  },
  ...
}
```

Keys are `postId`s; the file is a flat dict, NOT an array.

## Status enum

| Status | Means | Set by |
|---|---|---|
| `scheduled` | Waiting for its `scheduledAt`. Has an in-memory `setTimeout` (re-armed at boot + by the 60s sweep). | `schedulePost`, `retryJob` |
| `running` | Currently executing — Playwright is driving FetLife. Transient. | `executeJob` (claim-and-set) |
| `sent` | Confirmed live on FetLife. | `executeJob` on success, `confirmJobSent` (operator) |
| `submitted_pending_moderation` | `postToGroup` submitted but landed on the group page → either in the moderation queue OR silently rejected. Needs operator confirmation. | `executeJob` when `result.moderated === true` |
| `outcome_unknown` | Was `running` when the service restarted. We can't tell if FetLife received it. Needs operator confirmation. | `restoreScheduledJobs` at boot |
| `failed` | Posting actually threw. Retryable. | `executeJob` on exception |
| `cancelled` | Operator clicked Cancel before it fired. (Soft-deleted by `cancelPost`, which removes the key entirely — `cancelled` mostly shows up in `history.jsonl`, not the live queue.) | `cancelPost` |

State transitions:
```
        retry             confirm-sent
        ←──────           ←──────────
scheduled → running → sent
                    ↘
                      → submitted_pending_moderation ←─ confirm-sent / retry
                    ↘
                      → failed ←─ retry
                    ↘
   restart-mid-execution → outcome_unknown ←─ confirm-sent / retry
```

## At boot

`restoreScheduledJobs()` does three things in order:

1. **Orphan rescue.** Any `running` job becomes `outcome_unknown` (per Sprint 2 — auto-retry was the duplicate-post hazard). The operator must decide.
2. **Connectivity auto-retry.** Any `failed` job from the last 3 days whose error matches `isConnectivityError()` (cookie / timeout / Cloudflare / wall-clock budget) gets flipped back to `scheduled`, staggered 30–60s apart so they don't all fire at once on startup.
3. **Re-arm timers.** Every still-`scheduled` job gets a fresh `setTimeout`.

A 60-second sweep (`setInterval`) re-arms any `scheduled` job that doesn't have an active timer — backstops against missed `setTimeout`s on very-distant-future jobs.

## File safety guarantees

- **Atomic writes.** Every `saveQueue()` goes through `writeJsonAtomic` (tmp + fsync + rename). A SIGKILL or power loss mid-write leaves the live file untouched. A `.tmp` may linger; it's never read.
- **Throw on parse.** A truncated or corrupt `queue.json` makes `loadQueue()` THROW with `"queue.json failed to parse"`. The service refuses to start. Do NOT bypass this — the previous behavior was to return `{}`, then the next save overwrote the damaged file with empty state. That's how we lost 244 jobs once.
- **Mutex.** Every read-modify-write goes through `mutateQueue()` (single-chain promise queue). Concurrent calls serialize. Batch Compose used to lose N−1 of N posts to a race here; doesn't anymore.

## Recovery procedures

### "queue.json failed to parse" at boot

```sh
ssh root@<droplet>
systemctl status fetlife-poster.service
# Look for the parse-failure message in the journal.
journalctl -u fetlife-poster.service -n 50 --no-pager
```

Steps:

1. Stop the service. `systemctl stop fetlife-poster.service`
2. Find a known-good snapshot. `ls /root/fetpost/fetlife-poster/data/snapshots/`
3. Copy `queue.json` from the most recent good snapshot:
   ```sh
   cp /root/fetpost/fetlife-poster/data/snapshots/2026-06-08/queue.json \
      /root/fetpost/fetlife-poster/data/queue.json
   ```
4. Sanity check the parse: `python3 -c "import json; json.load(open('/root/fetpost/fetlife-poster/data/queue.json'))"` — exit 0 means it parses.
5. Start the service: `systemctl start fetlife-poster.service`
6. Tail the journal until you see `[scheduler] Restored N scheduled job(s)`. N should match what the dashboard expects.

### "I just nuked a bunch of posts by accident, roll back"

Same procedure as parse-failure. Stop, copy snapshot's `queue.json` over live, start. The provider snapshot covers the catastrophic case; the local nightly snapshot covers the "I made a mistake at 11pm" case.

### "I need to surgically fix one post without restoring the whole queue"

1. `systemctl stop fetlife-poster.service` (the service holds no in-memory queue mutex — disk is the only mutex, but stopping prevents races during your edit).
2. `cp data/queue.json data/queue.json.editing-backup`
3. Edit `data/queue.json` with the editor of your choice. Validate the result: `python3 -m json.tool data/queue.json > /dev/null`.
4. If it doesn't parse, restore the backup. Don't start the service with a broken file.
5. `systemctl start fetlife-poster.service`

### "A post should have fired but didn't"

```sh
journalctl -u fetlife-poster.service --since "1 hour ago" | grep <postId>
```

Common findings:
- `deferred — license <reason>` — license server unreachable past grace. Banner should be showing this.
- `deferred — account X paused` — operator paused. Resume from Accounts UI.
- `Wall-clock budget exceeded` — Playwright stalled. Will auto-retry on connectivity-class sweep next boot.
- Nothing at all — timer probably never armed. Check `[scheduler] Restored N scheduled job(s)` on last boot.

## Manual snapshot before a risky change

Before any migration / mass edit / experimental code path:
```sh
curl -X POST http://127.0.0.1:3747/admin/snapshot -H "x-service-token: $FL_SERVICE_SECRET"
```
This creates a `data/snapshots/YYYY-MM-DD/` copy on demand (in addition to the nightly auto-snapshot). Restore procedure is identical.

## Things to never do

- **Never** edit `queue.json` while the service is running. The mutex is in-memory; your edit will be silently overwritten by the next mutation.
- **Never** delete `queue.json` and start the service "to reset state." It boots fine into an empty queue — and every scheduled post is gone forever.
- **Never** restore an old `queue.json` over a newer one without renaming the current one first. If the restore turns out to be wrong, you can't undo without backups of backups.
