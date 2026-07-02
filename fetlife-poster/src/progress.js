/**
 * Progress-job tracker for long-running scrapes.
 *
 * A "job" is created up-front (returns a jobId), then the long-running work is started
 * fire-and-forget by the caller and reports stage transitions via the returned reporter.
 * Clients poll GET /jobs/:jobId to render a progress UI without holding an HTTP socket
 * open through the reverse-proxy chain.
 *
 * Stages are append-only. Each new stage call closes the previous in-progress stage
 * as 'done', then opens a fresh one. fail() / finish() seal the job.
 *
 * Persistence: every state change is async-mirrored to `data/jobs/<jobId>.json`. On boot
 * we replay any jobs whose disk file is still `running` and mark them `interrupted` so
 * the UI sees "the scrape was killed mid-run" instead of polling forever against a job
 * that no longer exists in memory (which used to 404 until the 30-min GC). The disk
 * mirror is best-effort — write failures are logged but never block the reporter.
 *
 * Records still live in memory as the hot path so getJob() is O(1) with no disk hit.
 * Completed-job records are GC'd ~30 min after completion to keep the Map small.
 */

import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { writeJsonAtomic, createKeyedMutex } from './util/atomic-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = path.join(__dirname, '..', 'data', 'jobs');
const JOB_TTL_MS = 30 * 60 * 1000;
const jobs = new Map();

// Per-job-id mutex. Reporter methods (stage/done/finish) fire persistJob in rapid
// succession; without serialization two writes for the same jobId race on the
// shared <id>.json.tmp path — the first one's rename succeeds and removes .tmp,
// the second's rename then ENOENTs. Serializing per job preserves write-latest
// semantics while letting different jobs persist in parallel.
const mutatePersist = createKeyedMutex();

function gcStaleJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.endedAt && job.endedAt < cutoff) {
      jobs.delete(id);
      // Best-effort disk cleanup. Missing/locked file is fine — periodic cleanup
      // happens whenever this fires.
      fs.unlink(path.join(JOBS_DIR, id + '.json')).catch(() => {});
    }
  }
}

// Async mirror to disk. Never throws — a write failure logs but the reporter
// continues. The atomic helper makes a crash-mid-write safe (tmp + rename(2)).
// Writes for the same job id serialize through mutatePersist so back-to-back
// reporter calls don't race on the shared <id>.json.tmp path. The mutex captures
// `job` by reference; each queued write re-stringifies inside the critical
// section, so the on-disk file converges to the latest in-memory state without
// needing to snapshot at call time.
function persistJob(job) {
  mutatePersist(job.id, async () => {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    await writeJsonAtomic(path.join(JOBS_DIR, job.id + '.json'), job);
  }).catch(err => console.warn(`[progress] persist ${job.id} failed: ${err.message}`));
}

export function createJob(label, meta = {}) {
  gcStaleJobs();
  const id = randomBytes(8).toString('hex');
  const job = {
    id,
    label,
    status: 'running', // running | done | error | interrupted
    stages: [],
    result: null,
    error: null,
    meta: { ...meta },
    startedAt: Date.now(),
    updatedAt: Date.now(),
    endedAt: null,
  };
  jobs.set(id, job);
  persistJob(job);
  return id;
}

export function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  return { ...job, elapsedMs: (job.endedAt || Date.now()) - job.startedAt };
}

// No-op reporter for code paths invoked without a progress job (cron, auto-recovery, etc.)
// so callers can pass `reporter` unconditionally without null-checks.
export function noopReporter() {
  return {
    stage() {}, done() {}, fail() {}, finish() {}, setMeta() {},
  };
}

export function getReporter(jobId) {
  const job = jobs.get(jobId);
  if (!job) return noopReporter();
  function sealLastIfOpen() {
    const last = job.stages[job.stages.length - 1];
    if (last && last.status === 'in_progress') {
      last.status = 'done';
      last.endedAt = Date.now();
    }
  }
  return {
    stage(name, detail = null) {
      sealLastIfOpen();
      job.stages.push({ name, detail, status: 'in_progress', startedAt: Date.now(), endedAt: null, error: null });
      job.updatedAt = Date.now();
      persistJob(job);
    },
    done(detail = null) {
      const last = job.stages[job.stages.length - 1];
      if (last && last.status === 'in_progress') {
        last.status = 'done';
        last.endedAt = Date.now();
        if (detail) last.detail = detail;
      }
      job.updatedAt = Date.now();
      persistJob(job);
    },
    setMeta(patch) {
      Object.assign(job.meta, patch);
      job.updatedAt = Date.now();
      persistJob(job);
    },
    finish(result) {
      sealLastIfOpen();
      job.status = 'done';
      job.result = result || null;
      job.endedAt = Date.now();
      job.updatedAt = job.endedAt;
      persistJob(job);
    },
    fail(err) {
      const last = job.stages[job.stages.length - 1];
      const msg = String((err && err.message) || err || 'unknown error');
      if (last && last.status === 'in_progress') {
        last.status = 'error';
        last.endedAt = Date.now();
        last.error = msg;
      }
      job.status = 'error';
      job.error = msg;
      job.endedAt = Date.now();
      job.updatedAt = job.endedAt;
      persistJob(job);
    },
  };
}

// Convenience wrapper for endpoints: create job, run async with reporter, return jobId.
// Caller is responsible for the 'first stage' message if the work doesn't start one itself.
export function startBackgroundJob(label, meta, runner) {
  const jobId = createJob(label, meta);
  const reporter = getReporter(jobId);
  // Fire and forget — never awaited at this layer.
  Promise.resolve()
    .then(() => runner(reporter))
    .then(result => reporter.finish(result))
    .catch(err => reporter.fail(err));
  return jobId;
}

/**
 * Boot-time replay: any `running` job on disk represents a scrape that was killed by
 * the service restart. The Playwright/browser context is gone — we can't resume the
 * work — but the UI may still be polling the jobId waiting for a result. Load these
 * into the in-memory Map with status `interrupted` so the next poll surfaces the
 * killed-mid-run state cleanly instead of 404'ing 30 min later.
 *
 * Completed jobs on disk (done / error) are also loaded so a UI that holds a stale
 * jobId for a few minutes after a restart still sees the final result instead of 404.
 */
export async function rehydrateProgressJobs() {
  let loaded = 0, interrupted = 0;
  let entries = [];
  try {
    entries = await fs.readdir(JOBS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return { loaded: 0, interrupted: 0 };
    throw err;
  }
  for (const entry of entries) {
    // Only real <id>.json files. A staged <id>.json.tmp doesn't end in .json, so
    // the .json check alone already excludes it.
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(JOBS_DIR, entry), 'utf8');
      const job = JSON.parse(raw);
      if (!job || !job.id) continue;
      if (job.status === 'running') {
        job.status = 'interrupted';
        job.error = 'Service restarted while this scrape was running — the work was killed, not resumed. Click the action again to retry.';
        job.endedAt = Date.now();
        job.updatedAt = job.endedAt;
        interrupted++;
        // Re-persist so a fresh boot doesn't re-rehydrate it as running.
        persistJob(job);
      }
      jobs.set(job.id, job);
      loaded++;
    } catch (err) {
      console.warn(`[progress] rehydrate ${entry} failed: ${err.message}`);
    }
  }
  if (loaded > 0) {
    console.log(`[progress] Rehydrated ${loaded} progress job(s) from disk (${interrupted} marked interrupted)`);
  }
  return { loaded, interrupted };
}
