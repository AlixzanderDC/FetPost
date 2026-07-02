# FetPost operator documentation

This is the documentation an operator (or a future developer) needs to keep FetPost running when something breaks at 2am. It isn't a tutorial — it's an index of runbooks and reference material organized by the problem they solve.

If you're setting FetPost up for the first time, start with [`DEPLOYMENT.md`](../DEPLOYMENT.md) at the repo root. Once it's running, come here.

## When a thing is broken

| Symptom | Read |
|---|---|
| "Could not find title input on new-discussion form" / "selector not found" / FetLife shipped a UI change | [fetlife-ui-breakage.md](./fetlife-ui-breakage.md) |
| Posts failing with "Not logged in" / "FetLife session expired" / cookies look refreshed but posting fails | [cookie-recovery.md](./cookie-recovery.md) |
| `queue.json failed to parse` at boot, or you need to roll back to last night's queue state | [queue-runbook.md](./queue-runbook.md) |
| Service won't start with `FL_MACHINE_SECRET is required` or other env-var errors | [env-vars.md](./env-vars.md) |

## Reference (read before changing something)

| Topic | Read |
|---|---|
| What fields can live on an account (`autoSignature`, `websiteCalendarUrl`, `paused`, …) | [account-meta-schema.md](./account-meta-schema.md) |
| How data flows: browser → UI → backend → Playwright → FetLife | [data-flow.md](./data-flow.md) |
| Every `process.env.*` the codebase reads, what it defaults to, whether prod requires it | [env-vars.md](./env-vars.md) |
| When to use `writeJsonAtomic` vs raw `fs.writeFile` + the per-account mutex pattern | [atomic-writes.md](./atomic-writes.md) |

## Conventions used across these docs

- **`<droplet>`** — the production server. SSH: `root@100.64.110.8`.
- **`<droplet>/root/fetpost`** — the install prefix on the droplet.
- **`fetlife-poster`** — backend service on `127.0.0.1:3747` (systemd unit `fetlife-poster.service`).
- **`nexuspost-ui`** — UI service on `127.0.0.1:4000` (systemd unit `fetpost-ui.service`). The folder is still called `nexuspost-ui/` for historical reasons; the service itself is FetPost. There's an open intent to rename the folder when a release window allows.
- A "memory" referenced in these docs is a learned constraint stored by the assistant — not a runtime cache.
