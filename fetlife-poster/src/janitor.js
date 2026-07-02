/**
 * Janitor — background cleanup loops for things that grow unbounded otherwise.
 *
 * Today this just caps the post-screenshots directory. Add new cleanup tasks
 * here as new unbounded-growth surfaces show up (e.g. metrics debug dumps,
 * stale .tmp files, HTML form dumps from selector-miss diagnoses).
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const SCREENSHOTS_DIR = path.join(DATA_DIR, 'post-screenshots');
// Cap: keep the most recent N files OR everything younger than M days,
// whichever is *more* permissive. So you always have at least 200 to look at
// even if you've been posting heavily, AND you always keep anything <= 30 days
// old even if you've been quiet.
const SCREENSHOT_MAX_FILES = 200;
const SCREENSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const JANITOR_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function cleanupScreenshots() {
  let entries;
  try {
    entries = await fs.readdir(SCREENSHOTS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { kept: 0, removed: 0 };
    throw err;
  }
  // Collect file stats so we can sort by mtime and apply age + count caps.
  const stats = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(SCREENSHOTS_DIR, e.name);
    try {
      const st = await fs.stat(full);
      stats.push({ path: full, mtime: st.mtimeMs, age: Date.now() - st.mtimeMs });
    } catch { /* file vanished mid-scan, skip */ }
  }
  // Sort newest first so slice(0, N) keeps the most recent.
  stats.sort((a, b) => b.mtime - a.mtime);
  const keepByCount = new Set(stats.slice(0, SCREENSHOT_MAX_FILES).map(s => s.path));
  const keepByAge = new Set(stats.filter(s => s.age < SCREENSHOT_MAX_AGE_MS).map(s => s.path));
  let removed = 0;
  for (const s of stats) {
    if (keepByCount.has(s.path) || keepByAge.has(s.path)) continue;
    try { await fs.unlink(s.path); removed++; } catch { /* concurrent delete is fine */ }
  }
  return { kept: stats.length - removed, removed };
}

export async function runJanitor() {
  const ss = await cleanupScreenshots().catch(err => ({ error: err.message }));
  return { screenshots: ss };
}

export function startJanitor() {
  // First sweep 60s after boot (let the service stabilize first), then daily.
  setTimeout(() => {
    runJanitor()
      .then(r => {
        if (r.screenshots && r.screenshots.removed > 0) {
          console.log(`[janitor] screenshots: kept ${r.screenshots.kept}, removed ${r.screenshots.removed}`);
        }
      })
      .catch(err => console.warn(`[janitor] initial sweep failed: ${err.message}`));
  }, 60 * 1000);
  setInterval(() => {
    runJanitor()
      .then(r => {
        if (r.screenshots && r.screenshots.removed > 0) {
          console.log(`[janitor] (24h) screenshots: kept ${r.screenshots.kept}, removed ${r.screenshots.removed}`);
        }
      })
      .catch(err => console.warn(`[janitor] periodic sweep failed: ${err.message}`));
  }, JANITOR_INTERVAL_MS);
}
