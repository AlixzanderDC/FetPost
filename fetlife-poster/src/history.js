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
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const entries = lines.map(l => JSON.parse(l)).reverse(); // newest first

    const filtered = accountId
      ? entries.filter(e => e.accountId === accountId)
      : entries;

    return filtered.slice(0, limit);
  } catch {
    return [];
  }
}
