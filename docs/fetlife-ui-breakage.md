# FetLife UI breakage runbook

FetLife ships UI changes without notice. When they do, FetPost's Playwright selectors break and posting starts failing. This runbook is the diagnostic + patch procedure.

## Recognize the symptom

| In the dashboard | In the logs |
|---|---|
| Posts marked `failed` with `Could not find title input on new-discussion form` (or any "could not find X" error) | `[poster] Submit landed on group page (moderation queue likely)` repeatedly across normally-working groups |
| Multiple posts to multiple groups all fail in the same hour with the same error | `[poster] dumped form HTML to data/post-screenshots/group-*-no-title-*.html for diagnosis` |
| `data/post-screenshots/` filling up with PNG/HTML files | `Could not find a "going" RSVP button on the event page` from venue-events |

A single failure of this kind is usually transient (NordVPN flap, Cloudflare). Three or more across different accounts in an hour means FetLife changed something.

## Diagnostic flow

### Step 1: confirm it isn't session expiry

Cookies failing look similar to selector failures. Distinguish:

```sh
ssh root@<droplet>
journalctl -u fetlife-poster.service --since "1 hour ago" | \
  grep -E "session expired|Could not find|Cloudflare" | tail -30
```

- `session expired` / `landed on the login form` → see [cookie-recovery.md](./cookie-recovery.md). Different problem.
- `Could not find ... input/button` → continue here.

### Step 2: pull the HTML dump

When poster.js can't find the title input it dumps the rendered HTML for diagnosis. Find the dump:

```sh
ls -lt /root/fetpost/fetlife-poster/data/post-screenshots/ | grep "no-title\|block-" | head -10
```

Pull the most recent matching one locally:
```sh
scp root@<droplet>:/root/fetpost/fetlife-poster/data/post-screenshots/group-<id>-no-title-<timestamp>.html /tmp/
```

Open it in a browser. The page should show what FetLife actually rendered when the post tried to fire — that's the source of truth.

### Step 3: figure out what changed

In the dump, find the equivalent of what the selector was looking for:

| Module | Selector that broke | Where it lives |
|---|---|---|
| Group post title | `input[name="group_post[title]"]` (+ fallbacks) | `poster.js:postToGroup` — multi-strategy probe |
| Status composer body | `textarea` variants in `postStatus` | `poster.js` |
| RSVP buttons | `Going` / `Maybe` / `Interested In` labels | `venue-events.js:setRsvp` |
| Add Pictures button | `button:has-text("Add Pictures")` etc. | `poster.js:postPicture` |
| Multi-image add button | `[class*="container/add-more"]` (single-strategy!) | `poster.js:postPicture` |
| Venue events search results | `a[href*="/events/"]` filter on `/events/YYYY/MM/DD/slug` | `venue-events.js:scanSearchForEvents` |

Inspect the dump and identify the new selector — usually a renamed `name=` attribute, a wrapper `div` with different classes, or a new label string.

### Step 4: patch the selector list, don't replace

The existing code is structured as a probe list that tries each selector in order until one matches. **Add** to the list; do not replace.

Example: `postToGroup` title input. The current list (in `poster.js`) is:
```js
let titleHandle = await findFirstSelector(page, [
  'input[name="group_post[title]"]',
  'input[name="post[title]"]',
  'input[name="discussion[title]"]',
  'input[name="thread[title]"]',
  'input[id*="title" i]',
  'input[placeholder="Title"]',
  'input[placeholder*="Title" i]',
  'input[aria-label*="title" i]',
], 3000);
```

If FetLife now uses `input[name="forum_post[title]"]`, add it to the top of the list. Old selectors stay so the rollback works if FetLife reverts.

### Step 5: deploy and verify

```sh
# From local repo, after editing src/poster.js (or wherever):
rsync -avc fetlife-poster/src/poster.js root@<droplet>:/root/fetpost/fetlife-poster/src/poster.js
ssh root@<droplet> 'systemctl restart fetlife-poster.service'

# Then trigger one failing post's retry from the dashboard — verify it succeeds.
journalctl -u fetlife-poster.service -f | grep <postId>
```

If the retry succeeds, mass-retry the failures from the Queue → Failed tab.

## Fallback: DOM-walk for the right element

When the selector probe list still can't find the right element, several functions already have a DOM-evaluate fallback that handles nested-span / wrapped layouts (`postToGroup` title-input fallback, `setRsvp`'s label normalization, the membership-gate Join-button detector). Add the same style of fallback to the failing module — match by normalized text content rather than exact selector.

The pattern (from `poster.js:postToGroup`):
```js
titleHandle = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll('input'));
  for (const el of inputs) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (!['text', '', 'search'].includes(type)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const name = (el.getAttribute('name') || '').toLowerCase();
    if (/search|filter|query/.test(name)) continue;  // skip header search
    el.setAttribute('data-fp-title', '1');
    return 'input[data-fp-title="1"]';
  }
  return null;
});
```

When the page-evaluate fallback ALSO can't find the element, the system dumps the HTML and throws a structured error — see step 2.

## When the problem isn't a selector

Some "could not find X" errors are actually membership / permission errors:

| Message | Real cause |
|---|---|
| `Account "X" is not a member of group N — FetLife redirected ...` | Account isn't in that group. Operator joins it on FetLife, or removes that group from the cross-post target. |
| `Group composer URL redirected to ... Group may be private/deleted/moved` | Group was deleted, made private, or moved. Update the cross-post target list. |
| `Could not find any way to un-RSVP on this event page` | Event was deleted, or FetLife's RSVP UI now requires a different control. Un-RSVP on FetLife directly. |

The membership detector in `postToGroup` runs BEFORE the title-input probe, so these throw with their specific messages rather than the generic "selector not found." If a new failure mode appears that should be its own error category, add a detector in the same pattern before the generic probe — easier triage for the next operator.

## Things to never do

- **Never** auto-deploy a selector patch without testing on at least one retry. Untested patches can lock out an entire account from posting.
- **Never** remove a selector from a probe list "because it doesn't match anymore" — keep the historical ones so rollback works.
- **Never** dump *credentials* into HTML dumps. The current dumps are HTML of the page state — they shouldn't contain passwords, but if you add a new dump path, sanitize first.
- **Never** swallow the selector-miss error silently with a catch. Always throw a structured error referencing the dump file path so the next operator can find it.
