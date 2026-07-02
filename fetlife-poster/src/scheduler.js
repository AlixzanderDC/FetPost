/**
 * Scheduler — persists the post queue to disk and fires jobs at the right time.
 * Handles text posts, image posts, and events.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCredentials, updateAccountStatus, getAccount } from './credentials.js';
import { postStatus, postPicture, postEvent, postToGroup, postPictureToGallery } from './poster.js';
import { logHistory } from './history.js';
import { addTrackedEvents } from './tracked-events.js';
import { isPostingAllowed } from './license.js';
import { writeJsonAtomic } from './util/atomic-json.js';

// How long to wait before re-checking the license when a due post is deferred because
// the license isn't currently valid. Short enough that a renewal flushes the backlog
// promptly, long enough not to hammer anything.
const LICENSE_DEFER_MS = 30 * 60 * 1000;
// Same defer window for account-paused. When the operator unpauses we also call
// rearmAccountSchedule(accountId) explicitly so the flush is immediate — this
// constant is only the fallback re-check window.
const PAUSE_DEFER_MS = 30 * 60 * 1000;

// Per-job wall-clock budget. A NordVPN flap that doesn't trip our explicit
// page.goto timeouts can still stall Playwright in the Cloudflare wait loops or in
// inter-action waitForTimeouts. Without an outer budget the executor can sit on a
// single job for an hour, blocking every other job behind it. Group posts (multi-
// stage Playwright + Cloudflare + paste) get a longer ceiling than status posts.
const POST_WALL_CLOCK_MS = {
  status: 4 * 60 * 1000,
  picture: 6 * 60 * 1000,
  gallery_picture: 6 * 60 * 1000,
  event: 8 * 60 * 1000,
  group_event: 8 * 60 * 1000,
};
const POST_WALL_CLOCK_DEFAULT_MS = 6 * 60 * 1000;

function withWallClockBudget(promise, budgetMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `Wall-clock budget exceeded (${Math.round(budgetMs / 1000)}s) for ${label}. ` +
      `Playwright likely stalled in Cloudflare wait or NordVPN flap. ` +
      `The browser was killed; the job is marked failed and will be auto-retried if it's a connectivity-class error.`
    )), budgetMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(__dirname, '..', 'data', 'queue.json');

const activeTimers = new Map();

async function loadQueue() {
  let raw;
  try {
    raw = await fs.readFile(QUEUE_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Refuse to recover silently — the previous behaviour returned `{}` on a parse
    // error, which then let the next mutateQueue save overwrite the damaged file
    // with empty state, permanently destroying every job that didn't make it into
    // that save. (See data-loss incident: 244 jobs nuked this way.) Fail loudly
    // so the operator can restore from backup before any writes happen.
    throw new Error(
      'queue.json failed to parse (' + err.message + '). Refusing to load empty state. ' +
      'Restore from a backup or fix the file manually before restarting the service.'
    );
  }
}

async function saveQueue(queue) {
  await fs.mkdir(path.dirname(QUEUE_FILE), { recursive: true });
  // Atomic write via the shared helper: stage to .tmp, fsync, then rename(2). The
  // fsync matters here — a crash right after a bare rename can still lose the bytes
  // if the OS hasn't flushed them, and losing queue.json means losing the schedule.
  await writeJsonAtomic(QUEUE_FILE, queue);
}

// Serialize every load+mutate+save so concurrent writers can't clobber each other.
// Without this, two near-simultaneous schedulePost calls both load the same snapshot,
// each add their own job, and the second saveQueue overwrites the first job. (Batch
// Compose with N rows lost N-1 of them — see queue-race bug.)
let queueOpChain = Promise.resolve();
function mutateQueue(mutator) {
  const next = queueOpChain.then(async () => {
    const queue = await loadQueue();
    const result = await mutator(queue);
    await saveQueue(queue);
    return result;
  });
  queueOpChain = next.catch(() => {});
  return next;
}

export async function getQueue() {
  const queue = await loadQueue();
  return Object.values(queue).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
}

const FL_MAX_CHARS = 369;

export async function schedulePost(job) {
  const {
    postId, accountId, content, scheduledAt, postType, eventDetails, images,
    groupId, title, body, eventUrl,
    // Source-tracking fields for the website→FetLife sync. When a post is
    // created from a website iCal event, we record the source title/date/URL so
    // a later refresh can find a matching FetLife event and rewrite the link.
    sourceEventTitle, sourceEventDate, sourceEventUrl, pendingFetlifeMatch,
  } = job;
  const type = postType || 'status';
  // FetLife's /home composer (status + picture caption) rejects anything over 369 chars.
  // Group posts and events use a separate page with a much higher limit.
  if ((type === 'status' || type === 'picture') && (content || '').length > FL_MAX_CHARS) {
    throw new Error(`Post exceeds FetLife limit of ${FL_MAX_CHARS} chars (got ${content.length})`);
  }
  const saved = await mutateQueue(queue => {
    queue[postId] = {
      postId, accountId, content: content || '',
      scheduledAt: scheduledAt instanceof Date ? scheduledAt.toISOString() : scheduledAt,
      postType: postType || 'status',
      eventDetails: eventDetails || null,
      images: images || [],
      groupId: groupId || null,
      title: title || null,
      body: body || null,
      eventUrl: eventUrl || null,
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      sourceEventTitle: sourceEventTitle || null,
      sourceEventDate: sourceEventDate || null,
      sourceEventUrl: sourceEventUrl || null,
      pendingFetlifeMatch: !!pendingFetlifeMatch,
    };
    return queue[postId];
  });
  armTimer(saved);
  console.log(`[scheduler] Post ${postId} (${saved.postType}) scheduled for ${saved.scheduledAt}`);
}

/**
 * Fan a single event out across N FetLife groups. When `groupsPerDay` is set
 * (e.g. 2), groups are spread across multiple days — N posts per day, advancing
 * by 24 hours. Within a day, slots are spaced ~3 hours apart with ±15 min jitter
 * so the cadence looks organic. Without `groupsPerDay`, falls back to the old
 * behaviour (all in one day, 60–120s apart) for backward compatibility.
 *
 * When `weekdaysOnly` is true, weekends are skipped when advancing — a Friday
 * batch is followed by a Monday batch. If the base date itself lands on a
 * weekend, the first batch is shifted to the next Monday.
 *
 * Batch-gap pacing: when a series exceeds BATCH_SIZE (6) groups, a
 * BATCH_GAP_DAYS (2)-day pause is inserted after every batch of 6. With the
 * default groupsPerDay=2 this looks like "3 active days → 2 quiet days → 3
 * active days → …". This keeps the per-account posting cadence below FetLife's
 * bot-detection thresholds for accounts that cross-post into 10+ groups.
 *
 * Example: 30 groups, groupsPerDay=2, weekdaysOnly=true, base = Mon Oct 6 10:00 →
 *   Mon Oct 6:  10:00, 13:00 (±15m)
 *   Tue Oct 7:  10:00, 13:00 (±15m)
 *   Wed Oct 8:  10:00, 13:00      ← end of batch 1 (6 groups)
 *   Mon Oct 13: 10:00, 13:00      ← 2-day gap (Thu/Fri) + weekend skip
 *   Tue Oct 14: 10:00, 13:00
 *   Wed Oct 15: 10:00, 13:00      ← end of batch 2 (12 groups)
 *   …
 */
export async function scheduleGroupEventBatch({ parentId, accountId, eventUrl, title, body, groupIds, scheduledAt, groupsPerDay, weekdaysOnly }) {
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    throw new Error('groupIds must be a non-empty array');
  }
  // Auto-track this event for future RSVP analysis. Best-effort — failure shouldn't block scheduling.
  if (eventUrl) {
    addTrackedEvents(accountId, [eventUrl], 'crosspost').catch(err =>
      console.warn(`[scheduler] Failed to auto-track ${eventUrl}: ${err.message}`)
    );
  }
  const baseDate = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  let baseTime = baseDate.getTime();
  const perDay = (typeof groupsPerDay === 'number' && groupsPerDay > 0) ? Math.floor(groupsPerDay) : 0;
  const skipWeekends = !!weekdaysOnly && perDay > 0;
  // If the base date itself is a weekend (and we're skipping weekends), shift
  // forward to the next Monday so the very first slot doesn't land on a weekend.
  if (skipWeekends) {
    const d = new Date(baseTime);
    const dow = d.getDay();
    if (dow === 0) baseTime += 24 * 3600 * 1000;      // Sun → Mon
    else if (dow === 6) baseTime += 2 * 24 * 3600 * 1000; // Sat → Mon
  }
  const fanout = [];
  // Anti-detection: shuffle group order so cross-posts don't fire in a deterministic
  // sequence (same content + same time + same group order = bot-pattern signature).
  // Fisher-Yates so each iteration is uniformly random.
  const shuffled = [...groupIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const DAY_MS = 24 * 3600 * 1000;
  const WITHIN_DAY_SPACING_MS = 3 * 3600 * 1000; // 3 hours between slots within a day
  // Batch-gap pacing: after every BATCH_SIZE groups, insert BATCH_GAP_DAYS of
  // silence. Only applies when the series exceeds BATCH_SIZE — short series
  // (≤6) keep the old contiguous cadence.
  const BATCH_SIZE = 6;
  const BATCH_GAP_DAYS = 2;
  const useBatchGaps = shuffled.length > BATCH_SIZE && perDay > 0;
  const daysPerBatch = useBatchGaps ? Math.ceil(BATCH_SIZE / perDay) : 0;
  // Pre-compute the start-of-day timestamp for each batch index. When skipping
  // weekends, each "day" advance skips Sat/Sun rather than just adding 24h.
  // When batch-gaps are on, the dayIndex passed in is the *logical* day; we
  // translate it to an *effective* day that includes the inserted gaps.
  function dayStartFor(dayIndex) {
    let effectiveDayIndex = dayIndex;
    if (useBatchGaps) {
      const batchIndex = Math.floor(dayIndex / daysPerBatch);
      effectiveDayIndex = dayIndex + (batchIndex * BATCH_GAP_DAYS);
    }
    if (!skipWeekends) return baseTime + effectiveDayIndex * DAY_MS;
    let t = baseTime;
    for (let d = 0; d < effectiveDayIndex; d++) {
      t += DAY_MS;
      let dow = new Date(t).getDay();
      // After incrementing, if we land on Sat (6) advance 2 more days; if Sun (0)
      // advance 1 more. Loop in case multiple adjustments are ever needed (won't
      // be — at most one of these branches runs).
      if (dow === 6) t += 2 * DAY_MS;
      else if (dow === 0) t += DAY_MS;
    }
    return t;
  }
  let cursor = baseTime; // only used in legacy (perDay === 0) branch
  for (let i = 0; i < shuffled.length; i++) {
    let scheduledMs;
    if (perDay > 0) {
      const dayIndex = Math.floor(i / perDay);
      const slotInDay = i % perDay;
      scheduledMs = dayStartFor(dayIndex);
      if (slotInDay > 0) {
        const jitter = (Math.random() - 0.5) * 30 * 60 * 1000; // ±15min
        scheduledMs += slotInDay * WITHIN_DAY_SPACING_MS + jitter;
      }
    } else {
      // Legacy single-day mode: 60–120s stagger
      if (i > 0) cursor += 60_000 + Math.floor(Math.random() * 60_000);
      scheduledMs = cursor;
    }
    const groupId = String(shuffled[i]);
    const childPostId = `${parentId}-g${groupId}`;
    await schedulePost({
      postId: childPostId,
      accountId,
      postType: 'group_event',
      scheduledAt: new Date(scheduledMs),
      groupId,
      title,
      body,
      eventUrl,
    });
    fanout.push({ postId: childPostId, groupId, scheduledAt: new Date(scheduledMs).toISOString() });
  }
  return fanout;
}

export async function cancelPost(postId) {
  await mutateQueue(queue => {
    if (!queue[postId]) throw new Error(`Post ${postId} not found`);
    if (activeTimers.has(postId)) { clearTimeout(activeTimers.get(postId)); activeTimers.delete(postId); }
    queue[postId].status = 'cancelled';
  });
}

// Edit fields of a scheduled job. Only allowed while status === 'scheduled' (already-sent or
// running jobs can't be changed). If scheduledAt changes, clear the old timer and re-arm.
// Updates pass through the same FetLife-composer 369-char limit check as schedulePost so a
// status/picture edit can't sneak past the validator.
export async function updateJob(postId, updates) {
  const job = await mutateQueue(queue => {
    const job = queue[postId];
    if (!job) throw new Error(`Post ${postId} not found`);
    if (job.status !== 'scheduled') throw new Error(`Cannot edit post in status "${job.status}" — only scheduled posts can be edited`);
    const allowed = ['title', 'body', 'content', 'scheduledAt', 'eventUrl', 'pendingFetlifeMatch'];
    const patch = {};
    for (const k of allowed) if (k in (updates || {})) patch[k] = updates[k];
    if ('content' in patch && (job.postType === 'status' || job.postType === 'picture' || job.postType === 'gallery_picture')) {
      if ((patch.content || '').length > FL_MAX_CHARS) {
        throw new Error(`Post exceeds FetLife limit of ${FL_MAX_CHARS} chars (got ${patch.content.length})`);
      }
    }
    if ('scheduledAt' in patch) {
      const dt = patch.scheduledAt instanceof Date ? patch.scheduledAt : new Date(patch.scheduledAt);
      if (isNaN(dt.getTime())) throw new Error('Invalid scheduledAt');
      if (dt.getTime() <= Date.now()) throw new Error('scheduledAt must be in the future');
      patch.scheduledAt = dt.toISOString();
    }
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return job;
  });
  // Re-arm timer so a new scheduledAt actually fires at the right moment.
  if (activeTimers.has(postId)) { clearTimeout(activeTimers.get(postId)); activeTimers.delete(postId); }
  armTimer(job);
  return job;
}

export async function retryJob(postId) {
  const job = await mutateQueue(queue => {
    const job = queue[postId];
    if (!job) throw new Error(`Post ${postId} not found`);
    // Allow retry from failed, sent, the new submitted_pending_moderation state
    // (operator looked on FetLife and it never appeared), outcome_unknown
    // (orphan from a service crash — operator chose "retry" instead of "confirm"),
    // and failed_moderation (operator confirmed rejection, then decided to give
    // it another shot — perhaps after editing the body in a different flow).
    const retryable = new Set(['failed', 'sent', 'submitted_pending_moderation', 'outcome_unknown', 'failed_moderation']);
    if (!retryable.has(job.status)) throw new Error(`Cannot retry post in status "${job.status}" — only failed, sent, submitted_pending_moderation, outcome_unknown, or failed_moderation posts can be retried`);
    job.status = 'scheduled';
    job.scheduledAt = new Date(Date.now() + 5000).toISOString();
    job.error = null;
    job.sentAt = null;
    job.result = null;
    job.moderationNote = null;
    job.rejectedAt = null;
    job.rejectedBy = null;
    job.updatedAt = new Date().toISOString();
    return job;
  });
  armTimer(job);
  return job;
}

/**
 * Operator says "I checked FetLife — moderators rejected this (or it never
 * appeared after the moderation window)". Flips a submitted_pending_moderation
 * or outcome_unknown job into the terminal `failed_moderation` state. Distinct
 * from the technical `failed` status (which covers network errors, login
 * failures, etc.) because the post DID reach FetLife — it's the content the
 * moderators (or the silent-drop logic) said no to.
 */
export async function markFailedModeration(postId, reason) {
  return await mutateQueue(queue => {
    const job = queue[postId];
    if (!job) throw new Error(`Post ${postId} not found`);
    const flippable = new Set(['submitted_pending_moderation', 'outcome_unknown', 'failed_moderation']);
    if (!flippable.has(job.status)) {
      throw new Error(`Cannot mark a post in status "${job.status}" as rejected — only submitted_pending_moderation, outcome_unknown, or already-rejected posts can be flipped`);
    }
    if (activeTimers.has(postId)) { clearTimeout(activeTimers.get(postId)); activeTimers.delete(postId); }
    job.status = 'failed_moderation';
    job.rejectedAt = new Date().toISOString();
    job.rejectedBy = 'operator';
    job.moderationNote = reason ? String(reason).slice(0, 500) : null;
    job.updatedAt = new Date().toISOString();
    return job;
  });
}

/**
 * Operator says "yes, I checked FetLife, the post actually landed" — flip a
 * submitted_pending_moderation or outcome_unknown job into the final `sent` state
 * so it stops showing as needing attention. Idempotent for already-sent posts.
 */
export async function confirmJobSent(postId) {
  return await mutateQueue(queue => {
    const job = queue[postId];
    if (!job) throw new Error(`Post ${postId} not found`);
    const confirmable = new Set(['submitted_pending_moderation', 'outcome_unknown', 'sent']);
    if (!confirmable.has(job.status)) {
      throw new Error(`Cannot confirm a post in status "${job.status}" — only submitted_pending_moderation, outcome_unknown, or sent can be confirmed`);
    }
    job.status = 'sent';
    if (!job.sentAt) job.sentAt = new Date().toISOString();
    job.confirmedAt = new Date().toISOString();
    job.confirmedBy = 'operator';
    job.moderationNote = null;
    job.error = null; // clear any stale outcome_unknown/failed error now that it's confirmed sent
    job.updatedAt = new Date().toISOString();
    return job;
  });
}

export async function clearJobsByStatus(status) {
  return await mutateQueue(queue => {
    let removed = 0;
    for (const [postId, job] of Object.entries(queue)) {
      if (job.status === status) {
        if (activeTimers.has(postId)) { clearTimeout(activeTimers.get(postId)); activeTimers.delete(postId); }
        delete queue[postId];
        removed++;
      }
    }
    return removed;
  });
}

function armTimer(job) {
  // Clear any timer already armed for this postId. Without this, re-arming a job
  // (e.g. after a content rewrite or restore) can leave a stale closure holding an
  // old job snapshot that still fires — a double-fire risk.
  if (activeTimers.has(job.postId)) { clearTimeout(activeTimers.get(job.postId)); activeTimers.delete(job.postId); }
  const msUntil = new Date(job.scheduledAt).getTime() - Date.now();
  if (msUntil <= 0) { executeJob(job).catch(err => console.error(`[scheduler] executeJob(${job.postId}) threw:`, err.message)); return; }
  if (msUntil > 2_000_000_000) return;
  const timer = setTimeout(() => executeJob(job).catch(err => console.error(`[scheduler] executeJob(${job.postId}) threw:`, err.message)), msUntil);
  activeTimers.set(job.postId, timer);
}

async function executeJob(job) {
  // License gate: if posting isn't allowed right now, DON'T fire and DON'T fail the job —
  // leave it scheduled and re-arm a short timer so it flushes automatically once the
  // license is renewed/restored. Burning the post on a billing lapse would be the worst
  // possible behavior for a paying customer who just forgot to renew.
  const lic = isPostingAllowed();
  if (!lic.allowed) {
    await mutateQueue(queue => {
      if (!queue[job.postId] || queue[job.postId].status !== 'scheduled') return;
      queue[job.postId].deferredUntil = new Date(Date.now() + LICENSE_DEFER_MS).toISOString();
      queue[job.postId].deferReason = 'license_' + lic.reason;
    });
    if (activeTimers.has(job.postId)) { clearTimeout(activeTimers.get(job.postId)); activeTimers.delete(job.postId); }
    const timer = setTimeout(() => executeJob(job).catch(err => console.error(`[scheduler] executeJob(${job.postId}) threw:`, err.message)), LICENSE_DEFER_MS);
    activeTimers.set(job.postId, timer);
    console.warn(`[scheduler] Post ${job.postId} deferred — license ${lic.reason} (retry in 30m)`);
    return;
  }

  // Per-account pause gate: if the operator paused the account, defer rather
  // than fire. Same shape as license defer — post stays scheduled, queue
  // records why it was deferred. The PATCH /accounts unpause path also calls
  // rearmAccountSchedule(accountId) so the flush is immediate on resume.
  const acct = await getAccount(job.accountId).catch(() => null);
  if (acct && acct.paused) {
    await mutateQueue(queue => {
      if (!queue[job.postId] || queue[job.postId].status !== 'scheduled') return;
      queue[job.postId].deferredUntil = new Date(Date.now() + PAUSE_DEFER_MS).toISOString();
      queue[job.postId].deferReason = 'account_paused';
    });
    if (activeTimers.has(job.postId)) { clearTimeout(activeTimers.get(job.postId)); activeTimers.delete(job.postId); }
    const timer = setTimeout(() => executeJob(job).catch(err => console.error(`[scheduler] executeJob(${job.postId}) threw:`, err.message)), PAUSE_DEFER_MS);
    activeTimers.set(job.postId, timer);
    console.warn(`[scheduler] Post ${job.postId} deferred — account ${job.accountId} paused (retry in 30m or on unpause)`);
    return;
  }

  // Atomic check-and-claim: only proceed if the job is still scheduled. Mark it
  // running in the same lock so two concurrent timers can't both fire the same post.
  const claimed = await mutateQueue(queue => {
    const current = queue[job.postId];
    if (!current || current.status !== 'scheduled') return false;
    queue[job.postId].status = 'running';
    return true;
  });
  if (!claimed) return;
  activeTimers.delete(job.postId);

  console.log(`[scheduler] Executing ${job.postType} post ${job.postId} for ${job.accountId}`);
console.log(`[scheduler] Images: ${job.images ? job.images.length : 0}, postType: ${job.postType}`);

  try {
    const creds = await getCredentials(job.accountId);

    // Marketing fail-safe: strip any line still containing an unresolved
    // placeholder before firing. If a post was scheduled with {Insert Event
    // Link} (or any other placeholder) that never got resolved by auto-sync or
    // the manual-link picker, the entire line gets dropped so the post doesn't
    // fire with literal "{Insert Event Link}" text in it — promotional
    // integrity > completeness. Applies to body/content depending on postType.
    const stripPlaceholderLines = (s) => {
      if (!s) return s;
      const PLACEHOLDER = /\{[^}]*\b(?:link|url|event|day|name|title|next|insert)\b[^}]*\}/i;
      const kept = s.split('\n').filter(line => !PLACEHOLDER.test(line));
      return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    };
    if (job.postType === 'group_event') job.body = stripPlaceholderLines(job.body);
    else if (job.postType === 'event' && job.eventDetails) job.eventDetails.body = stripPlaceholderLines(job.eventDetails.body);
    else if (job.postType === 'picture' || job.postType === 'gallery_picture' || job.postType === 'status' || !job.postType) {
      job.content = stripPlaceholderLines(job.content);
      // Empty content after stripping is a hard fail — better to surface as a
      // failure the operator can see than to fire a blank post on FetLife.
      // picture + gallery_picture both allow empty captions (the image is the post).
      if (job.postType !== 'picture' && job.postType !== 'gallery_picture' && (!job.content || !job.content.trim())) {
        throw new Error('Post content is empty after stripping unresolved placeholder lines — link the post to a FetLife event or edit the content before retry');
      }
    }

    // Auto-signature: per-account string appended to the post body if the account
    // has one configured AND the body doesn't already contain it (avoids
    // duplicating when the user pasted the signature manually). Per-post opt-out
    // via job.skipAutoSignature.
    if (!job.skipAutoSignature) {
      const acct = await getAccount(job.accountId).catch(() => null);
      const sig = acct?.autoSignature && String(acct.autoSignature).trim();
      if (sig) {
        const appendIfMissing = (body) => {
          if (!body) return sig;
          if (body.includes(sig)) return body;
          return body.replace(/\s+$/, '') + '\n\n' + sig;
        };
        if (job.postType === 'group_event') job.body = appendIfMissing(job.body);
        else if (job.postType === 'event' && job.eventDetails) job.eventDetails.body = appendIfMissing(job.eventDetails.body);
        else if (job.postType === 'picture' || job.postType === 'gallery_picture' || job.postType === 'status' || !job.postType) job.content = appendIfMissing(job.content);
      }
    }

    let result;

    // Pick the wall-clock ceiling for this post type and race the actual posting
    // promise against it. If the budget fires the executor returns control to the
    // catch block below — the browser may leak (Playwright's `browser.close()` is
    // in poster.js's `finally`, which won't run if we abandon the promise). That's
    // an acceptable trade for not blocking the queue indefinitely; the browser is
    // OS-level garbage-collected and the next job opens a fresh context.
    const budgetMs = POST_WALL_CLOCK_MS[job.postType] || POST_WALL_CLOCK_DEFAULT_MS;
    const postLabel = `${job.postType} ${job.postId}`;

    if (job.postType === 'group_event') {
      if (!job.groupId || !job.title || !job.body) {
        throw new Error('group_event job missing groupId, title, or body');
      }
      result = await withWallClockBudget(
        postToGroup(job.accountId, { groupId: job.groupId, title: job.title, body: job.body }),
        budgetMs, postLabel,
      );
    } else if (job.postType === 'event' && job.eventDetails) {
      result = await withWallClockBudget(
        postEvent(creds.username, creds.password, job.eventDetails, job.accountId),
        budgetMs, postLabel,
      );
    } else if (job.postType === 'picture' && job.images && job.images.length > 0) {
      result = await withWallClockBudget(
        postPicture(creds.username, creds.password, job.content, job.images, job.accountId),
        budgetMs, postLabel,
      );
    } else if (job.postType === 'gallery_picture' && job.images && job.images.length > 0) {
      result = await withWallClockBudget(
        postPictureToGallery(creds.username, creds.password, job.content, job.images, job.accountId),
        budgetMs, postLabel,
      );
    } else {
      result = await withWallClockBudget(
        postStatus(creds.username, creds.password, job.content, job.accountId),
        budgetMs, postLabel,
      );
    }

    // When postToGroup lands on the group page rather than the new post URL it means
    // FetLife accepted the submission but held it for moderation. The post is NOT live
    // yet — calling it `sent` masks the silent-rejection case (rate-limit / shadow-block
    // can also redirect to the group page with no error). Track these as a distinct
    // state so the UI shows "Awaiting moderation" and the operator can manually confirm
    // (or retry) once they've checked the group on FetLife.
    const isModerated = !!(result && result.moderated);
    const newStatus = isModerated ? 'submitted_pending_moderation' : 'sent';
    await mutateQueue(queue => {
      if (!queue[job.postId]) return;
      queue[job.postId].status = newStatus;
      queue[job.postId].sentAt = new Date().toISOString();
      queue[job.postId].result = result;
      if (isModerated) queue[job.postId].moderationNote = 'Submitted but redirected to group page — could be in moderation queue OR silently rejected. Confirm on FetLife.';
    });
    // Post-send bookkeeping is best-effort: the post already landed (status is
    // committed above). If updateAccountStatus/logHistory throws, it must NOT fall
    // through to the catch block below and flip a live post to `failed`.
    try {
      await updateAccountStatus(job.accountId, 'ok');
      await logHistory(job, newStatus, result);
    } catch (bookkeepErr) {
      console.error(`[scheduler] Post ${job.postId} landed but post-send bookkeeping failed:`, bookkeepErr.message);
    }
    console.log(`[scheduler] Post ${job.postId} ${isModerated ? 'submitted (awaiting moderation)' : 'sent successfully'}`);
    // Best-effort Telegram notification — failures must not affect the scheduler.
    // Dynamic import so the scheduler still works if the module is removed.
    import('./telegram-bot.js').then(t => t.notifyPostPublished(job, result)).catch(err =>
      console.warn(`[scheduler] Telegram notify (sent) failed: ${err.message}`)
    );
  } catch (err) {
    console.error(`[scheduler] Post ${job.postId} failed:`, err.message);
    await mutateQueue(queue => {
      if (!queue[job.postId]) return;
      queue[job.postId].status = 'failed';
      queue[job.postId].error = err.message;
      queue[job.postId].failedAt = new Date().toISOString();
    });
    await updateAccountStatus(job.accountId, 'post_failed');
    await logHistory(job, 'failed', { error: err.message });
    // Failure + cookie-expiry alerts go to TELEGRAM only (private DM-style ops).
    // Discord is treated as a content channel — community-facing audience
    // shouldn't see internal failures or cookie noise.
    const cookieExpired = /not logged in|cookies? may have expired|session expired/i.test(err.message);
    if (cookieExpired) {
      import('./telegram-bot.js').then(t => t.notifyCookieExpired(job.accountId,
        `Post "${job.title || (job.content || '').slice(0, 60)}" failed — FetLife session no longer valid. Refresh cookies to resume.`
      )).catch(() => {});
    } else {
      import('./telegram-bot.js').then(t => t.notifyPostFailed(job, err.message)).catch(err2 =>
        console.warn(`[scheduler] Telegram notify (failed) failed: ${err2.message}`)
      );
    }
  }
}

function isConnectivityError(errMsg) {
  if (!errMsg) return false;
  const patterns = [
    /cookie/i, /not logged in/i, /timeout/i, /timed out/i, /network/i,
    /cloudflare/i, /challenge/i, /unauthorized/i, /\b401\b/,
    /ECONN/i, /ETIMEDOUT/i, /ENETDOWN/i, /ENOTFOUND/i, /EAI_AGAIN/i,
    /net::/i, /protocol error/i,
    /wall-clock budget exceeded/i,
    // Note: "service restarted while job was executing" used to flow through here as
    // a connectivity-class auto-retry, but that produced duplicate posts on FetLife
    // when the post had actually landed before the crash. Those orphans are now
    // marked `outcome_unknown` and require operator confirmation — see
    // restoreScheduledJobs().
  ];
  return patterns.some(rx => rx.test(errMsg));
}

export async function restoreScheduledJobs() {
  let restored = 0;
  const queue = await mutateQueue(queue => {
    let orphaned = 0;
    // Any job left in `running` state at boot is an orphan from a previous crash/kill.
    // CRITICAL: we cannot tell whether the post made it to FetLife or not — the crash
    // window is between `await postToGroup(...)` returning and the queue.json save
    // flushing. Blind auto-retry risked duplicate posts on FetLife. Mark these
    // `outcome_unknown` and require operator resolution (Confirm sent / Retry) so the
    // worst case is a stuck job that needs a click, not a duplicate post in front of
    // the customer's audience.
    for (const job of Object.values(queue)) {
      if (job.status === 'running') {
        queue[job.postId].status = 'outcome_unknown';
        queue[job.postId].error = 'Service restarted while job was executing — outcome unknown. Check FetLife: if the post landed, click "Confirm sent"; if not, click "Retry".';
        queue[job.postId].outcomeUnknownAt = new Date().toISOString();
        orphaned++;
      }
    }
    if (orphaned > 0) {
      console.warn(`[scheduler] Marked ${orphaned} orphaned running job(s) as outcome_unknown — operator confirmation required`);
    }

    // Auto-retry: any failed post whose error looks connectivity-related AND whose original
    // scheduled time was less than 3 days ago — flip back to scheduled, staggered 30–60s apart
    // so we don't spike FetLife on startup. outcome_unknown is INTENTIONALLY excluded — those
    // require operator decision, not blind retry, to avoid duplicate posts.
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const failedRecent = Object.values(queue)
      .filter(j => j.status === 'failed' && isConnectivityError(j.error))
      .filter(j => Date.now() - new Date(j.scheduledAt).getTime() < THREE_DAYS_MS)
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
    let cursor = Date.now() + 10_000;
    let autoRetried = 0;
    for (const j of failedRecent) {
      queue[j.postId].status = 'scheduled';
      queue[j.postId].scheduledAt = new Date(cursor).toISOString();
      queue[j.postId].error = null;
      queue[j.postId].autoRetriedAt = new Date().toISOString();
      cursor += 30_000 + Math.floor(Math.random() * 30_000);
      autoRetried++;
    }
    if (autoRetried > 0) {
      console.log(`[scheduler] Auto-retrying ${autoRetried} connectivity-failed post(s) from the last 3 days`);
    }
    return queue;
  });

  for (const job of Object.values(queue)) {
    if (job.status === 'scheduled') { armTimer(job); restored++; }
  }
  console.log(`[scheduler] Restored ${restored} scheduled job(s)`);
}

// Sweep every minute so a missed timer (from a service restart) fires within 60s, not 60 min.
// Wrapped so a transient loadQueue failure (e.g. a momentarily unreadable/locked
// queue.json) logs and retries next minute instead of throwing out of the interval
// callback — an unhandled rejection there would take down the whole process.
setInterval(async () => {
  try {
    const queue = await loadQueue();
    for (const job of Object.values(queue)) {
      if (job.status === 'scheduled' && !activeTimers.has(job.postId)) armTimer(job);
    }
  } catch (err) {
    console.error('[scheduler] 60s sweep failed (will retry next minute):', err.message);
  }
}, 60 * 1000);

restoreScheduledJobs().catch(err => console.error('[scheduler] Failed to restore jobs:', err.message));

// Re-arm every scheduled post for an account. Used after the operator unpauses
// the account so deferred posts fire promptly instead of waiting for the
// fallback 30-min recheck. Clears any existing defer/pending timer first to
// avoid double-fire.
export async function rearmAccountSchedule(accountId) {
  const queue = await loadQueue();
  let rearmed = 0;
  for (const job of Object.values(queue)) {
    if (job.accountId !== accountId) continue;
    if (job.status !== 'scheduled') continue;
    if (activeTimers.has(job.postId)) {
      clearTimeout(activeTimers.get(job.postId));
      activeTimers.delete(job.postId);
    }
    armTimer(job);
    rearmed++;
  }
  if (rearmed > 0) console.log(`[scheduler] rearmAccountSchedule · ${accountId}: ${rearmed} jobs re-armed`);
  return rearmed;
}

// ── Website → FetLife sync ───────────────────────────────────────────────────
// Post created from a website iCal event (TheCrucible's own calendar) carries
// pendingFetlifeMatch=true plus sourceEventTitle/Date/Url. When the venue
// finally publishes the FetLife version of that event and we refresh the
// account's hosted/attending event lists, this sweep finds those scheduled
// posts and rewrites their eventUrl + replaces the placeholder URL in content.
function normalizeTitle(s) {
  return String(s || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Score how similar two event titles are. 1.0 = identical, 0.9 = one fully
// contained in the other (e.g. "QINK" inside "QINK: Naughty Pajamas"), then
// drops to a token-overlap ratio (Jaccard-style) with a minimum-distinctive-
// -token guard so common words like "the" don't trigger false matches.
function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(/\s+/).filter(Boolean));
  const tb = new Set(nb.split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  // Require at least one distinctive token (>2 chars) in common — keeps "the"
  // / "and" / "of" / "in" from carrying a match.
  const sharedDistinctive = [...ta].some(t => t.length > 2 && tb.has(t));
  if (!sharedDistinctive) return 0;
  return common / Math.min(ta.size, tb.size);
}

// Auto-sync threshold: be conservative. 0.6 means roughly "more than half the
// tokens of the shorter title appear in the longer one, and at least one of
// those tokens is distinctive." Ambiguous matches (below threshold) get left
// for the user to resolve via the manual-link picker.
const TITLE_SIMILARITY_THRESHOLD = 0.6;

function titlesMatch(a, b) {
  return titleSimilarity(a, b) >= TITLE_SIMILARITY_THRESHOLD;
}

// Export for endpoint use: list ALL candidate matches for a pending post, ranked
// by similarity * date-proximity. Used by the manual-link picker so the user can
// confirm matches that fell below the auto-sync threshold.
export function findCandidateFetlifeEvents(post, fetlifeEvents) {
  if (!post || !post.sourceEventTitle) return [];
  const sourceDate = post.sourceEventDate;
  const scored = [];
  for (const ev of fetlifeEvents) {
    if (!ev.url || !ev.urlDate) continue;
    const titleScore = titleSimilarity(post.sourceEventTitle, ev.title);
    // Date proximity score: 1.0 same day, 0.7 ±1 day, 0.3 ±2 days, else 0.
    let dateScore = 0;
    if (sourceDate && ev.urlDate) {
      const ms = Math.abs(new Date(sourceDate + 'T12:00').getTime() - new Date(ev.urlDate + 'T12:00').getTime());
      const days = Math.round(ms / (24 * 3600 * 1000));
      dateScore = days === 0 ? 1.0 : days === 1 ? 0.7 : days === 2 ? 0.3 : 0;
    }
    if (titleScore > 0 && dateScore > 0) {
      scored.push({ event: ev, titleScore, dateScore, combined: titleScore * dateScore });
    }
  }
  return scored.sort((a, b) => b.combined - a.combined).slice(0, 10);
}

export async function syncWebsiteUrlsToFetlife(accountId, fetlifeEvents) {
  if (!Array.isArray(fetlifeEvents) || fetlifeEvents.length === 0) return { synced: 0, checked: 0 };
  // Build a date-bucketed lookup: { 'YYYY-MM-DD': [ev, ev, ...] }
  const byDate = {};
  for (const ev of fetlifeEvents) {
    if (!ev.url || !ev.urlDate) continue;
    if (!byDate[ev.urlDate]) byDate[ev.urlDate] = [];
    byDate[ev.urlDate].push(ev);
  }
  let synced = 0, checked = 0;
  const syncedIds = [];
  await mutateQueue(queue => {
    for (const post of Object.values(queue)) {
      if (post.status !== 'scheduled') continue;
      if (!post.pendingFetlifeMatch) continue;
      if (post.accountId !== accountId) continue;
      if (!post.sourceEventTitle || !post.sourceEventDate) continue;
      checked++;
      // Look on the exact source date first, then ±1 day for safety (some venues
      // publish FetLife events with a slightly off date).
      const candidates = [post.sourceEventDate]
        .concat(adjacentDate(post.sourceEventDate, -1), adjacentDate(post.sourceEventDate, 1))
        .flatMap(d => byDate[d] || []);
      const match = candidates.find(ev => titlesMatch(ev.title, post.sourceEventTitle));
      if (!match) continue;
      const oldUrl = post.eventUrl;
      post.eventUrl = match.url;
      if (post.content) {
        // Replace the literal {Insert Event Link} placeholder (lenient match)
        // with the FetLife URL — covers website-sourced posts that never had
        // the URL substituted at submit time.
        post.content = post.content.replace(/\{[^}]*\b(?:link|url)\b[^}]*\}/gi, match.url);
        // Also rewrite any inlined iCal URL from legacy/edited posts.
        if (post.sourceEventUrl && post.content.includes(post.sourceEventUrl)) {
          post.content = post.content.split(post.sourceEventUrl).join(match.url);
        } else if (oldUrl && oldUrl !== match.url && post.content.includes(oldUrl)) {
          post.content = post.content.split(oldUrl).join(match.url);
        }
      }
      post.pendingFetlifeMatch = false;
      post.fetlifeMatchedAt = new Date().toISOString();
      synced++;
      syncedIds.push(post.postId);
    }
  });
  // Re-arm the synced posts. executeJob fires from the job object captured by armTimer,
  // NOT from a fresh queue read, so a post that was already armed would otherwise still
  // fire its pre-sync snapshot (the {Insert Event Link} placeholder or the old URL). Re-
  // arming replaces that stale closure with the rewritten row.
  if (syncedIds.length > 0) {
    const queue = await loadQueue();
    for (const id of syncedIds) {
      const job = queue[id];
      if (job && job.status === 'scheduled') armTimer(job);
    }
  }
  if (synced > 0) console.log(`[scheduler] website→FetLife sync · ${accountId}: ${synced}/${checked} posts upgraded (timers re-armed)`);
  return { synced, checked };
}

function adjacentDate(isoDate, offsetDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return [];
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  d.setDate(d.getDate() + offsetDays);
  const pad = n => String(n).padStart(2, '0');
  return [d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())];
}
