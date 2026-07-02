/**
 * Nightly snapshot of the critical state files.
 *
 * Provider-level snapshots (e.g. DigitalOcean droplet snapshots) cover the
 * "droplet disk died" disaster case but typically run daily-to-weekly, leaving
 * a long window where intra-day mutations could be lost. This module captures
 * a fine-grained local snapshot once a day so the operator can roll back to
 * "yesterday's state" without waiting for the provider's next backup.
 *
 * What gets snapshotted (anything whose loss would meaningfully degrade service):
 *   queue.json, credentials.enc, accounts.json, license.json
 *   venue-events/ (per-account stores)
 *   campaigns/   (per-account stores)
 *   templates/, mentions/, tracked-events/, tracked-posts/  (per-account stores)
 *
 * Layout: data/snapshots/YYYY-MM-DD/<original-path-relative-to-data>
 * Retention: SNAPSHOT_KEEP_DAYS rolling. Older directories pruned at the same
 * time the new one's written.
 *
 * Restore (manual operator action — no auto-restore on purpose):
 *   systemctl stop fetlife-poster fetpost-ui
 *   cp -r data/snapshots/YYYY-MM-DD/* data/      # overwrites live state
 *   systemctl start fetlife-poster fetpost-ui
 *
 * The scheduler boot will refuse to start if loadQueue() can't parse the
 * restored file (Sprint 1 protection), so a bad restore fails loud.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');

const SNAPSHOT_KEEP_DAYS = 14;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;  // 24h

// Top-level files (one each) to copy.
const FILES = ['queue.json', 'credentials.enc', 'accounts.json', 'license.json'];
// Per-account directories. Snapshot mirrors the whole subtree.
const DIRS = ['venue-events', 'campaigns', 'templates', 'mentions', 'tracked-events', 'tracked-posts', 'events', 'groups'];

function todayUTC() {
  // UTC day boundary so snapshots stay timezone-agnostic and predictable.
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function copyFileIfExists(src, dst) {
  try {
    await fs.copyFile(src, dst);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function copyDirRecursive(src, dst) {
  let entries;
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  await fs.mkdir(dst, { recursive: true });
  let count = 0;
  for (const entry of entries) {
    // Skip .tmp leftovers from atomic-write crashes — they're never useful state.
    if (entry.name.endsWith('.tmp')) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) count += await copyDirRecursive(s, d);
    else if (entry.isFile()) { await fs.copyFile(s, d); count++; }
  }
  return count;
}

async function pruneOldSnapshots() {
  let dirs;
  try {
    dirs = await fs.readdir(SNAPSHOT_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { kept: 0, removed: 0 };
    throw err;
  }
  const datedDirs = dirs
    .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map(d => d.name)
    .sort()  // ISO date sorts chronologically
    .reverse();  // newest first
  const toKeep = datedDirs.slice(0, SNAPSHOT_KEEP_DAYS);
  const toRemove = datedDirs.slice(SNAPSHOT_KEEP_DAYS);
  for (const name of toRemove) {
    await fs.rm(path.join(SNAPSHOT_DIR, name), { recursive: true, force: true });
  }
  return { kept: toKeep.length, removed: toRemove.length };
}

/**
 * Take a snapshot. Safe to call repeatedly on the same day — the destination
 * folder gets overwritten, capturing the latest state. Returns a summary so
 * the caller can log it (and a future "manual snapshot" endpoint can surface
 * it to the operator).
 */
export async function runSnapshot() {
  const stamp = todayUTC();
  const targetDir = path.join(SNAPSHOT_DIR, stamp);
  // Clear any existing same-day snapshot before recreating. Copying over the top of
  // an earlier run leaves behind files that were deleted since (e.g. a removed account
  // or cleared data file), so the snapshot would no longer be a faithful point-in-time
  // capture and a restore could resurrect deleted state.
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  let copiedFiles = 0;
  for (const f of FILES) {
    const ok = await copyFileIfExists(path.join(DATA_DIR, f), path.join(targetDir, f));
    if (ok) copiedFiles++;
  }
  let copiedDirFiles = 0;
  for (const d of DIRS) {
    copiedDirFiles += await copyDirRecursive(path.join(DATA_DIR, d), path.join(targetDir, d));
  }

  const prune = await pruneOldSnapshots();

  // Touch a marker file so an operator can `ls data/snapshots/<date>` and immediately
  // see when the snapshot ran (filesystem mtime isn't always reliable across copies).
  await fs.writeFile(
    path.join(targetDir, '.snapshot-info'),
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      files: copiedFiles,
      perAccountFiles: copiedDirFiles,
    }, null, 2),
    'utf8',
  );

  return {
    stamp,
    targetDir,
    files: copiedFiles,
    perAccountFiles: copiedDirFiles,
    snapshotsKept: prune.kept,
    snapshotsRemoved: prune.removed,
  };
}

/**
 * Boot-time scheduler: run a snapshot 30s after start (gives the rest of the
 * service time to initialize and means a fresh restart always gets a snapshot
 * even if the daily cadence missed), then once per 24h.
 *
 * The interval timer drifts with process uptime — that's fine. We're not
 * promising "snapshot at 2:00 AM exactly", just "at least one per ~24h while
 * the service is up". Persistent timers would be over-engineering; if the
 * service is down the missed snapshot day is captured by the provider snapshot.
 */
export function startSnapshotScheduler() {
  setTimeout(() => {
    runSnapshot()
      .then(r => console.log(`[snapshot] ${r.stamp} captured ${r.files} top-level + ${r.perAccountFiles} per-account files (kept ${r.snapshotsKept}, pruned ${r.snapshotsRemoved})`))
      .catch(err => console.warn(`[snapshot] initial snapshot failed: ${err.message}`));
  }, 30 * 1000);
  setInterval(() => {
    runSnapshot()
      .then(r => console.log(`[snapshot] ${r.stamp} (24h) captured ${r.files} top-level + ${r.perAccountFiles} per-account files`))
      .catch(err => console.warn(`[snapshot] periodic snapshot failed: ${err.message}`));
  }, SNAPSHOT_INTERVAL_MS);
}
