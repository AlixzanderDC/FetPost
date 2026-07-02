I'm the owner and operator of this self-hosted project and I'd like a thorough,
senior-level review and cleanup. Please do the work, not just a list of findings —
but pause and show me a plan before deleting any file or deploying to the live
server.

Context: FetPost is a personal tool I run to schedule event-marketing posts for my
own event on FetLife, using my own accounts and only in groups I belong to. It's
ordinary posting/scheduling automation — reliability and correctness are the whole
goal. A few things in the code exist purely for stability (a VPN for a steady
outbound IP, saved login sessions, and polite spacing between posts so I don't hit
rate limits); please treat those as normal and in-scope for quality work. This is
strictly a code-quality and reliability review.

Please cover four tracks:

1. Architecture — the two services (UI gateway + posting engine), the storage
   model, and the scheduler/job state machine. Flag structural risk and fragility.
2. UX — the operator workflows (composing, scheduling, campaigns, queue, accounts).
   Flag confusing or redundant flows.
3. UI — the single-page front end: layout, consistency, accessibility, dead
   controls, stale text.
4. Code — real bugs, races, resource leaks, crash risks, security hardening, dead
   code, duplication, and anything causing slowdowns. Fix what you find.

Method: give me the birds-eye view first, verify each finding in the real code
before editing, and syntax-check anything you change.

A few pieces are load-bearing even though they look removable — please don't remove
or "simplify" these without asking, and ask me if you're unsure whether something
is a bug or intentional:

- The VPN stays running.
- queue.json fails loud on a corrupt file instead of loading empty state (a past
  bug wiped the queue) — keep that.
- Atomic file writes (tmp -> fsync -> rename) — keep them.
- Group posts that land on the group URL are treated as success/pending-moderation,
  not failure — intentional.
- The dormant non-primary platform integrations are kept on purpose.
- Auth is enforced server-side; the front end only hides controls — intentional.
