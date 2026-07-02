/**
 * Campaigns — per-account library of multi-post marketing campaigns for festival /
 * conference / hotel-takeover accounts.
 *
 * A campaign owns:
 *   - An EVENT LIST: the main festival plus any lead-up sub-events (meet & greet,
 *     interest workshop, hotel info night, etc.). One event is the primary.
 *   - A POST LIST (slots): each slot is one pre-written post. The slot's schedule
 *     is days/hours relative to whichever event it ANCHORS to — defaults to the
 *     primary, but can point at any of the lead-up sub-events so a post about the
 *     meet-and-greet uses the meet-and-greet's date for its "Days Until" math and
 *     its {Event Link} placeholder.
 *
 * Activation just realizes each slot into a real scheduled post via schedulePost().
 * No event-name/date inputs needed at activate time — the campaign already knows
 * everything. Records a "run" so the whole batch can be unscheduled with one click.
 *
 * Three campaign kinds (informational/organizational — all three use the same
 * schema; the split helps the operator keep their library organized):
 *   - 'drip' — rolling announcements (educators, special-event reveals)
 *   - 'reg'  — registration drive (early bird, tier transitions, last-call)
 *   - 'info' — recurring info posts (hotel, parking, schedule, FAQs)
 *
 * Schema:
 *   Campaign {
 *     id, name, kind, accountId,
 *     events: [{
 *       id, name, dateISO, fetlifeUrl
 *     }],
 *     primaryEventId,            // points into events[]
 *     slots: [{
 *       id,
 *       anchorEventId,           // defaults to primaryEventId if omitted
 *       offsetDays,              // relative to anchor event date; negative = before
 *       offsetHourLocal,         // 0-23, local time
 *       offsetMinuteLocal,       // 0-59, local time (defaults to 0 when absent)
 *       postType,                // 'status' | 'picture'
 *       body,                    // full pre-written post; placeholders resolved at activation
 *       images: [{ data, mimeType, name }],
 *     }],
 *     createdAt, updatedAt,
 *   }
 *
 *   Placeholders (each slot resolves against its anchor event):
 *     {Event Name}   {Event Date}   {Event Link}   {Days Until}
 *
 *   Run {
 *     runId, campaignId, postIds, activatedAt, activatedBy,
 *     // Snapshot of resolved events at activation time so the run record stays
 *     // intelligible even if the campaign is later edited:
 *     eventSnapshot: [{ id, name, dateISO, fetlifeUrl }],
 *     primaryEventIdSnapshot,
 *   }
 *
 * Storage: data/campaigns/<accountId>.json — { campaigns: [...], runs: [...] }
 * Atomic-write + per-account mutex (mirrors venue-events pattern).
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { writeJsonAtomic, readJsonStrict, createKeyedMutex } from './util/atomic-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'campaigns');

const fileFor = (accountId) => path.join(DATA_DIR, encodeURIComponent(accountId) + '.json');
const mutateStore = createKeyedMutex();

const VALID_KINDS = ['drip', 'reg', 'info'];

async function readStore(accountId) {
  const parsed = await readJsonStrict(fileFor(accountId), {
    defaultIfMissing: null,
    label: `campaigns/${accountId}.json`,
  });
  if (!parsed) return { campaigns: [], runs: [] };
  return {
    campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns : [],
    runs: Array.isArray(parsed.runs) ? parsed.runs : [],
  };
}

async function writeStore(accountId, store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeJsonAtomic(fileFor(accountId), store);
}

function newId(prefix) {
  return prefix + '-' + randomBytes(6).toString('hex');
}

function withEventIds(events) {
  return (events || []).map(e => ({
    id: e.id || newId('evt'),
    name: String(e.name || '').slice(0, 200),
    dateISO: e.dateISO || '',
    fetlifeUrl: e.fetlifeUrl || '',
  }));
}

function withSlotIds(slots) {
  return (slots || []).map(s => ({ ...s, id: s.id || newId('slot') }));
}

function validateEvents(events, primaryEventId) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('campaign must have at least one event (the primary).');
  }
  for (const [i, e] of events.entries()) {
    if (!e.name) throw new Error(`events[${i}].name required`);
    if (!e.dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(e.dateISO)) {
      throw new Error(`events[${i}].dateISO must be YYYY-MM-DD (got "${e.dateISO}")`);
    }
  }
  if (!events.some(e => e.id === primaryEventId)) {
    throw new Error('primaryEventId must reference one of the events');
  }
}

function validateSlots(slots, events) {
  if (!Array.isArray(slots)) throw new Error('slots must be an array');
  const eventIds = new Set(events.map(e => e.id));
  for (const [i, slot] of slots.entries()) {
    if (typeof slot.offsetDays !== 'number') throw new Error(`slots[${i}].offsetDays must be a number`);
    if (typeof slot.offsetHourLocal !== 'number' || slot.offsetHourLocal < 0 || slot.offsetHourLocal > 23) {
      throw new Error(`slots[${i}].offsetHourLocal must be 0-23`);
    }
    if (slot.offsetMinuteLocal !== undefined && slot.offsetMinuteLocal !== null &&
        (typeof slot.offsetMinuteLocal !== 'number' || slot.offsetMinuteLocal < 0 || slot.offsetMinuteLocal > 59)) {
      throw new Error(`slots[${i}].offsetMinuteLocal must be 0-59`);
    }
    if (slot.postType && !['status', 'picture', 'gallery_picture'].includes(slot.postType)) {
      throw new Error(`slots[${i}].postType must be status, picture, or gallery_picture`);
    }
    if (slot.anchorEventId && !eventIds.has(slot.anchorEventId)) {
      throw new Error(`slots[${i}].anchorEventId references an event that doesn't exist`);
    }
  }
}

// ── Library CRUD ──────────────────────────────────────────────────────────

export async function listCampaigns(accountId) {
  return (await readStore(accountId)).campaigns;
}

export async function listRuns(accountId) {
  return (await readStore(accountId)).runs;
}

export async function getCampaign(accountId, campaignId) {
  const store = await readStore(accountId);
  return store.campaigns.find(c => c.id === campaignId) || null;
}

export async function createCampaign(accountId, patch) {
  const kind = patch.kind || 'drip';
  if (!VALID_KINDS.includes(kind)) throw new Error('kind must be one of: ' + VALID_KINDS.join(', '));
  if (!patch.name) throw new Error('name required');

  const events = withEventIds(patch.events);
  // If primaryEventId wasn't supplied, default to first event's id.
  const primaryEventId = patch.primaryEventId || (events[0] && events[0].id);
  validateEvents(events, primaryEventId);

  const slots = withSlotIds(patch.slots || []);
  validateSlots(slots, events);

  return await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    const now = new Date().toISOString();
    const campaign = {
      id: newId('camp'),
      accountId,
      name: String(patch.name).slice(0, 120),
      kind,
      events,
      primaryEventId,
      slots,
      createdAt: now,
      updatedAt: now,
    };
    store.campaigns.push(campaign);
    await writeStore(accountId, store);
    return campaign;
  });
}

export async function updateCampaign(accountId, campaignId, patch) {
  // Validate the parts being patched against the merged future state.
  return await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    const idx = store.campaigns.findIndex(c => c.id === campaignId);
    if (idx === -1) throw new Error('Campaign not found: ' + campaignId);
    const existing = store.campaigns[idx];
    const merged = { ...existing, ...patch };

    if (patch.kind !== undefined && !VALID_KINDS.includes(patch.kind)) {
      throw new Error('kind must be one of: ' + VALID_KINDS.join(', '));
    }
    if (patch.events !== undefined) merged.events = withEventIds(patch.events);
    if (patch.slots !== undefined) merged.slots = withSlotIds(patch.slots);
    // Default primary if not specified or if the previous primary was removed.
    if (!merged.events.some(e => e.id === merged.primaryEventId)) {
      merged.primaryEventId = merged.events[0] && merged.events[0].id;
    }
    validateEvents(merged.events, merged.primaryEventId);
    validateSlots(merged.slots, merged.events);

    // Preserve immutable fields.
    merged.id = existing.id;
    merged.accountId = existing.accountId;
    merged.createdAt = existing.createdAt;
    merged.updatedAt = new Date().toISOString();

    store.campaigns[idx] = merged;
    await writeStore(accountId, store);
    return merged;
  });
}

export async function deleteCampaign(accountId, campaignId) {
  return await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    const before = store.campaigns.length;
    store.campaigns = store.campaigns.filter(c => c.id !== campaignId);
    if (store.campaigns.length === before) throw new Error('Campaign not found: ' + campaignId);
    await writeStore(accountId, store);
    return { removed: 1 };
  });
}

// ── Preview + activation ──────────────────────────────────────────────────

function formatEventDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Resolve {placeholders} in a slot body against its anchor event.
 *
 *   {Event Name}   -> anchor.name
 *   {Event Date}   -> anchor.dateISO formatted long
 *   {Event Link}   -> anchor.fetlifeUrl
 *   {Days Until}   -> -offsetDays when offsetDays < 0, else 0
 *
 * Unknown placeholders are left untouched so the scheduler's fire-time
 * placeholder-strip can drop the line if it never gets resolved.
 */
function renderBody(body, ctx) {
  if (!body) return '';
  return body
    .replace(/\{Event Name\}/g, ctx.anchorName || '')
    .replace(/\{Event Date\}/g, ctx.anchorDateFormatted || '')
    .replace(/\{Event Link\}/g, ctx.anchorUrl || '')
    .replace(/\{Days Until\}/g, ctx.daysUntil != null ? String(ctx.daysUntil) : '');
}

// Given a wall-clock time and an IANA timezone, return the UTC instant.
// Node's Date constructor uses the process TZ for local-time inputs (which is
// almost always UTC on the droplet) — so `setHours(16)` produces 16:00 UTC,
// not 16:00 in the operator's actual timezone. This helper resolves the offset
// for the target TZ at the target moment (handles DST) and adjusts.
function buildScheduledAt(year, month, day, hour, minute, tz) {
  if (!tz) {
    // Fallback to legacy behavior: process-local time. Wrong on a UTC droplet
    // but preserved so callers without a TZ don't silently shift.
    const d = new Date(year, month - 1, day, hour, minute, 0, 0);
    return d;
  }
  // Round 1 in UTC, then ask Intl what wall-clock that instant maps to in tz.
  // The delta between the requested wall-clock and the observed wall-clock IS
  // the offset minutes for that instant. Apply it once to get a near-correct
  // anchor (off by ≤ the DST jump), then re-check and adjust once for the rare
  // case where the first pass straddles a transition.
  const guess1 = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const offset1 = tzOffsetMinutes(guess1, tz);
  const guess2 = new Date(guess1.getTime() - offset1 * 60000);
  const offset2 = tzOffsetMinutes(guess2, tz);
  if (offset1 === offset2) return guess2;
  return new Date(guess1.getTime() - offset2 * 60000);
}

// Offset minutes between UTC and `tz` AT the moment of `date`. Positive = east.
function tzOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = +p.value;
  }
  // Intl reports hour=24 for midnight on some platforms — normalize to 0.
  if (parts.hour === 24) parts.hour = 0;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return (asUtc - date.getTime()) / 60000;
}

/**
 * Build the concrete post list this campaign would generate, without scheduling.
 * Pure function — used by the editor's "preview" tab and by the activate dialog.
 * Slots with empty bodies are skipped so drafts can coexist with ready posts.
 *
 * `opts.tz` is the operator's IANA timezone (e.g. "America/New_York"). When
 * provided, slot.offsetHourLocal + offsetMinuteLocal are interpreted in that
 * timezone — otherwise they fall back to the Node process TZ (almost always
 * UTC on the droplet, which produces visibly-wrong times for non-UTC operators).
 */
export function previewActivation(campaign, opts = {}) {
  if (!campaign) throw new Error('campaign required');
  const events = campaign.events || [];
  if (!events.length) throw new Error('campaign has no events configured');
  const eventsById = new Map(events.map(e => [e.id, e]));
  const primary = eventsById.get(campaign.primaryEventId) || events[0];
  const tz = opts.tz || null;

  const slots = campaign.slots || [];
  const posts = [];

  for (const [i, slot] of slots.entries()) {
    const body = (slot.body || '').trim();
    if (!body) continue;
    const anchor = eventsById.get(slot.anchorEventId) || primary;
    if (!anchor || !anchor.dateISO) continue;

    // Anchor is just a calendar date; combine with the slot's offset days,
    // hour, and minute, then resolve the absolute instant in tz (or process TZ).
    const [ay, am, ad] = anchor.dateISO.split('-').map(Number);
    const noon = new Date(Date.UTC(ay, am - 1, ad, 12, 0, 0));
    if (isNaN(noon.getTime())) continue;
    const shifted = new Date(noon.getTime() + slot.offsetDays * 86400000);
    const y = shifted.getUTCFullYear();
    const m = shifted.getUTCMonth() + 1;
    const d = shifted.getUTCDate();
    const scheduledAt = buildScheduledAt(
      y, m, d,
      slot.offsetHourLocal | 0,
      slot.offsetMinuteLocal | 0,
      tz
    );
    if (isNaN(scheduledAt.getTime())) continue;
    const daysUntil = slot.offsetDays >= 0 ? 0 : -slot.offsetDays;

    const content = renderBody(body, {
      anchorName: anchor.name,
      anchorDateFormatted: formatEventDate(anchor.dateISO),
      anchorUrl: anchor.fetlifeUrl || '',
      daysUntil,
    });

    let images = [];
    if ((slot.postType === 'picture' || slot.postType === 'gallery_picture') &&
        Array.isArray(slot.images) && slot.images.length) {
      images = slot.images;
    }

    posts.push({
      slotId: slot.id,
      slotIndex: i,
      anchorEventId: anchor.id,
      anchorEventName: anchor.name,
      anchorDateISO: anchor.dateISO,
      scheduledAt: scheduledAt.toISOString(),
      postType: slot.postType || 'status',
      content,
      images,
      offsetDays: slot.offsetDays,
    });
  }
  return posts;
}

/**
 * Schedule every non-empty slot's resolved post. Snapshots the event list into
 * the run record so historical runs stay intelligible even after the campaign
 * is later edited.
 */
export async function activateCampaign(accountId, campaignId, schedulePostFn, opts = {}) {
  const campaign = await getCampaign(accountId, campaignId);
  if (!campaign) throw new Error('Campaign not found: ' + campaignId);
  const posts = previewActivation(campaign, { tz: opts.tz });
  if (!posts.length) {
    throw new Error('Campaign has no posts to schedule — write body content for at least one slot before activating.');
  }

  const runId = newId('run');
  const postIds = [];
  const failures = [];

  for (const [i, p] of posts.entries()) {
    const postId = `fetlife-${accountId}-${runId}-${i}`;
    try {
      await schedulePostFn({
        postId,
        accountId,
        content: p.content,
        scheduledAt: p.scheduledAt,
        postType: p.postType,
        images: p.images || [],
      });
      postIds.push(postId);
    } catch (err) {
      failures.push({ slotIndex: i, error: err.message });
    }
  }

  await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    const c = await getCampaign(accountId, campaignId);
    store.runs.push({
      runId,
      campaignId,
      campaignName: campaign.name,
      campaignKind: campaign.kind,
      eventSnapshot: (c && c.events) || campaign.events,
      primaryEventIdSnapshot: (c && c.primaryEventId) || campaign.primaryEventId,
      postIds,
      activatedAt: new Date().toISOString(),
      activatedBy: 'operator',
    });
    await writeStore(accountId, store);
  });

  return { runId, scheduled: postIds.length, postIds, failures };
}

/**
 * Detect-and-schedule new slots that were added to a campaign template after
 * its run was activated. The classic flow: operator activates a campaign with
 * N slots → run gets N posts → operator opens the editor, adds a 14th slot,
 * fills the body, saves → run still has 13 posts, calendar is missing one.
 *
 * Resolution strategy is count-based on previewActivation length (slots with
 * blank bodies are skipped by the preview, mirroring activateCampaign). The
 * NEW slots are assumed to be the trailing ones — true for the editor's
 * "+ Add post" button which always appends, false only if the operator
 * manually edited slot order, in which case they need to re-activate anyway.
 *
 * Schedules each new slot at the offset the slot itself carries (so a slot
 * with offsetDays = -30 lands 30 days before the anchor event, just like a
 * normal activation). Skips when nothing's new.
 */
export async function syncNewSlotsToRun(accountId, campaignId, schedulePostFn, opts = {}) {
  const campaign = await getCampaign(accountId, campaignId);
  if (!campaign) throw new Error('Campaign not found: ' + campaignId);
  const posts = previewActivation(campaign, { tz: opts.tz });
  const store = await readStore(accountId);
  const activeRuns = store.runs
    .filter(r => r.campaignId === campaignId && !r.unscheduledAt)
    .sort((a, b) => new Date(b.activatedAt) - new Date(a.activatedAt));
  if (!activeRuns.length) {
    throw new Error('No active runs — activate the campaign first, then sync future additions');
  }
  const targetRun = activeRuns[0];
  const existingCount = (targetRun.postIds || []).length;
  if (posts.length <= existingCount) {
    return { synced: 0, skipped: posts.length, runId: targetRun.runId };
  }
  const newPosts = posts.slice(existingCount);
  const scheduledIds = [];
  const failures = [];
  for (const [offset, p] of newPosts.entries()) {
    const i = existingCount + offset;
    const postId = `fetlife-${accountId}-${targetRun.runId}-${i}`;
    try {
      await schedulePostFn({
        postId,
        accountId,
        content: p.content,
        scheduledAt: p.scheduledAt,
        postType: p.postType,
        images: p.images || [],
      });
      scheduledIds.push(postId);
    } catch (err) {
      failures.push({ slotIndex: i, error: err.message });
    }
  }
  await mutateStore(accountId, async () => {
    const s = await readStore(accountId);
    const r = s.runs.find(rr => rr.runId === targetRun.runId);
    if (!r) throw new Error('Run vanished between read and update: ' + targetRun.runId);
    r.postIds = [...(r.postIds || []), ...scheduledIds];
    r.lastSyncedAt = new Date().toISOString();
    await writeStore(accountId, s);
  });
  return { synced: scheduledIds.length, runId: targetRun.runId, failures, postIds: scheduledIds };
}

/**
 * Append an ad-hoc post id to an existing run so "Unschedule all" still cancels
 * it. Used by the per-campaign "slot in a post" UI: the caller schedules the
 * post first (so a failure there doesn't pollute the run record), then registers
 * the resulting postId here.
 */
export async function addPostToRun(accountId, runId, postId) {
  return await mutateStore(accountId, async () => {
    const store = await readStore(accountId);
    const run = store.runs.find(r => r.runId === runId);
    if (!run) throw new Error('Run not found: ' + runId);
    if (run.unscheduledAt) throw new Error('Run was already unscheduled — slot into a fresh activation instead');
    if (!Array.isArray(run.postIds)) run.postIds = [];
    if (!run.postIds.includes(postId)) run.postIds.push(postId);
    await writeStore(accountId, store);
    return { runId, postIds: run.postIds.length };
  });
}

/**
 * Cancel every queue.json job generated by a previous activation. Run record
 * is kept (audit trail), just stamped with unscheduledAt so the UI hides it.
 */
export async function unscheduleRun(accountId, runId, cancelPostFn) {
  const store = await readStore(accountId);
  const run = store.runs.find(r => r.runId === runId);
  if (!run) throw new Error('Run not found: ' + runId);
  const results = [];
  for (const postId of run.postIds || []) {
    try {
      await cancelPostFn(postId);
      results.push({ postId, cancelled: true });
    } catch (err) {
      results.push({ postId, cancelled: false, error: err.message });
    }
  }
  await mutateStore(accountId, async () => {
    const s = await readStore(accountId);
    const r = s.runs.find(rr => rr.runId === runId);
    if (r) {
      r.unscheduledAt = new Date().toISOString();
      r.unscheduledCount = results.filter(x => x.cancelled).length;
    }
    await writeStore(accountId, s);
  });
  return { cancelled: results.filter(x => x.cancelled).length, results };
}
