/**
 * Append-only audit log of all posting attempts.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.jsonl');

export async function logHistory(job, outcome, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    postId: job.postId,
    accountId: job.accountId,
    postType: job.postType || 'status',
    scheduledAt: job.scheduledAt,
    outcome,   // 'sent' | 'failed' | 'cancelled'
    ...details,
  };

  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await fs.appendFile(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

export async function getPostHistory(accountId = null, limit = 50) {
  // Callers pass parseInt(req.query.limit), which is NaN for a bad/absent value —
  // and slice(0, NaN) returns [], silently hiding all history. Fall back to 50.
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  let raw;
  try {
    raw = await fs.readFile(HISTORY_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // history.jsonl is append-only — a single corrupt line shouldn't hide every other
  // entry. Parse line-by-line and log (but don't suppress) the bad ones so the
  // operator can see corruption in the journal instead of "history is empty".
  const lines = raw.trim().split('\n').filter(Boolean);
  const entries = [];
  let badLines = 0;
  for (const l of lines) {
    try { entries.push(JSON.parse(l)); }
    catch { badLines++; }
  }
  if (badLines > 0) {
    console.warn(`[history] ${badLines}/${lines.length} lines in history.jsonl failed to parse — possible mid-write corruption`);
  }
  entries.reverse(); // newest first
  const filtered = accountId
    ? entries.filter(e => e.accountId === accountId)
    : entries;
  return filtered.slice(0, safeLimit);
}
