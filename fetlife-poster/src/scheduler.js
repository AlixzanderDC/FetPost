/**
 * Scheduler — persists the post queue to disk and fires jobs at the right time.
 * Handles text posts, image posts, and events.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCredentials, updateAccountStatus } from './credentials.js';
import { postStatus, postPicture, postEvent, postToGroup } from './poster.js';
import { logHistory } from './history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_FILE = path.join(__dirname, '..', 'data', 'queue.json');

const activeTimers = new Map();

async function loadQueue() {
  try { return JSON.parse(await fs.readFile(QUEUE_FILE, 'utf8')); } catch { return {}; }
}

async function saveQueue(queue) {
  await fs.mkdir(path.dirname(QUEUE_FILE), { recursive: true });
  await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

export async function getQueue() {
  const queue = await loadQueue();
  return Object.values(queue).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
}

export async function schedulePost(job) {
  const {
    postId, accountId, content, scheduledAt, postType, eventDetails, images,
    groupId, title, body, eventUrl,
  } = job;
  const queue = await loadQueue();
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
  };
  await saveQueue(queue);
  armTimer(queue[postId]);
  console.log(`[scheduler] Post ${postId} (${queue[postId].postType}) scheduled for ${queue[postId].scheduledAt}`);
}

/**
 * Fan a single event out across N FetLife groups, staggered 60–120s apart starting at
 * scheduledAt. Returns the per-group child job records.
 */
export async function scheduleGroupEventBatch({ parentId, accountId, eventUrl, title, body, groupIds, scheduledAt }) {
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    throw new Error('groupIds must be a non-empty array');
  }
  const baseTime = (scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt)).getTime();
  let cursor = baseTime;
  const fanout = [];
  for (let i = 0; i < groupIds.length; i++) {
    if (i > 0) cursor += 60_000 + Math.floor(Math.random() * 60_000); // 60–120s stagger
    const groupId = String(groupIds[i]);
    const childPostId = `${parentId}-g${groupId}`;
    await schedulePost({
      postId: childPostId,
      accountId,
      postType: 'group_event',
      scheduledAt: new Date(cursor),
      groupId,
      title,
      body,
      eventUrl,
    });
    fanout.push({ postId: childPostId, groupId, scheduledAt: new Date(cursor).toISOString() });
  }
  return fanout;
}

export async function cancelPost(postId) {
  const queue = await loadQueue();
  if (!queue[postId]) throw new Error(`Post ${postId} not found`);
  if (activeTimers.has(postId)) { clearTimeout(activeTimers.get(postId)); activeTimers.delete(postId); }
  queue[postId].status = 'cancelled';
  await saveQueue(queue);
}

export async function clearJobsByStatus(status) {
  const queue = await loadQueue();
  let removed = 0;
  for (const [postId, job] of Object.entries(queue)) {
    if (job.status === status) {
      if (activeTimers.has(postId)) { clearTimeout(activeTimers.get(postId)); activeTimers.delete(postId); }
      delete queue[postId];
      removed++;
    }
  }
  await saveQueue(queue);
  return removed;
}

function armTimer(job) {
  const msUntil = new Date(job.scheduledAt).getTime() - Date.now();
  if (msUntil <= 0) { executeJob(job); return; }
  if (msUntil > 2_000_000_000) return;
  const timer = setTimeout(() => executeJob(job), msUntil);
  activeTimers.set(job.postId, timer);
}

async function executeJob(job) {
  const queue = await loadQueue();
  const current = queue[job.postId];
  if (!current || current.status !== 'scheduled') return;

  queue[job.postId].status = 'running';
  await saveQueue(queue);
  activeTimers.delete(job.postId);

  console.log(`[scheduler] Executing ${job.postType} post ${job.postId} for ${job.accountId}`);
console.log(`[scheduler] Images: ${job.images ? job.images.length : 0}, postType: ${job.postType}`);

  try {
    const creds = await getCredentials(job.accountId);
    let result;

    if (job.postType === 'group_event') {
      if (!job.groupId || !job.title || !job.body) {
        throw new Error('group_event job missing groupId, title, or body');
      }
      result = await postToGroup(job.accountId, {
        groupId: job.groupId,
        title: job.title,
        body: job.body,
      });
    } else if (job.postType === 'event' && job.eventDetails) {
      result = await postEvent(creds.username, creds.password, job.eventDetails, job.accountId);
    } else if (job.postType === 'picture' && job.images && job.images.length > 0) {
      result = await postPicture(creds.username, creds.password, job.content, job.images, job.accountId);
    } else {
      result = await postStatus(creds.username, creds.password, job.content, job.accountId);
    }

    queue[job.postId].status = 'sent';
    queue[job.postId].sentAt = new Date().toISOString();
    queue[job.postId].result = result;
    await saveQueue(queue);
    await updateAccountStatus(job.accountId, 'ok');
    await logHistory(job, 'sent', result);
    console.log(`[scheduler] Post ${job.postId} sent successfully`);
  } catch (err) {
    console.error(`[scheduler] Post ${job.postId} failed:`, err.message);
    queue[job.postId].status = 'failed';
    queue[job.postId].error = err.message;
    queue[job.postId].failedAt = new Date().toISOString();
    await saveQueue(queue);
    await updateAccountStatus(job.accountId, 'post_failed');
    await logHistory(job, 'failed', { error: err.message });
  }
}

export async function restoreScheduledJobs() {
  const queue = await loadQueue();
  let restored = 0;
  let orphaned = 0;
  // Any job left in `running` state when the service comes up is an orphan from a previous
  // crash/kill. Mark it failed so it doesn't sit forever — the scheduler can't reason about
  // whether the actual post landed, but the queue state is now consistent.
  for (const job of Object.values(queue)) {
    if (job.status === 'running') {
      queue[job.postId].status = 'failed';
      queue[job.postId].error = 'Service restarted while job was executing — outcome unknown';
      queue[job.postId].failedAt = new Date().toISOString();
      orphaned++;
    }
  }
  if (orphaned > 0) {
    await saveQueue(queue);
    console.log(`[scheduler] Marked ${orphaned} orphaned running job(s) as failed`);
  }
  for (const job of Object.values(queue)) {
    if (job.status === 'scheduled') { armTimer(job); restored++; }
  }
  console.log(`[scheduler] Restored ${restored} scheduled job(s)`);
}

// Sweep every minute so a missed timer (from a service restart) fires within 60s, not 60 min.
setInterval(async () => {
  const queue = await loadQueue();
  for (const job of Object.values(queue)) {
    if (job.status === 'scheduled' && !activeTimers.has(job.postId)) armTimer(job);
  }
}, 60 * 1000);

restoreScheduledJobs().catch(err => console.error('[scheduler] Failed to restore jobs:', err.message));
