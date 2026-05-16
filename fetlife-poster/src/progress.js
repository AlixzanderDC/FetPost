/**
 * In-process progress-job tracker for long-running scrapes.
 *
 * A "job" is created up-front (returns a jobId), then the long-running work is started
 * fire-and-forget by the caller and reports stage transitions via the returned reporter.
 * Clients poll GET /jobs/:jobId to render a progress UI without holding an HTTP socket
 * open through the reverse-proxy chain.
 *
 * Stages are append-only. Each new stage call closes the previous in-progress stage
 * as 'done', then opens a fresh one. fail() / finish() seal the job.
 *
 * Records live in memory only — they're GC'd ~30 min after completion. This is fine
 * because the UI only ever cares about active jobs.
 */

import { randomBytes } from 'crypto';

const JOB_TTL_MS = 30 * 60 * 1000;
const jobs = new Map();

function gcStaleJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.endedAt && job.endedAt < cutoff) jobs.delete(id);
  }
}

export function createJob(label, meta = {}) {
  gcStaleJobs();
  const id = randomBytes(8).toString('hex');
  jobs.set(id, {
    id,
    label,
    status: 'running', // running | done | error
    stages: [],
    result: null,
    error: null,
    meta: { ...meta },
    startedAt: Date.now(),
    updatedAt: Date.now(),
    endedAt: null,
  });
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
    },
    done(detail = null) {
      const last = job.stages[job.stages.length - 1];
      if (last && last.status === 'in_progress') {
        last.status = 'done';
        last.endedAt = Date.now();
        if (detail) last.detail = detail;
      }
      job.updatedAt = Date.now();
    },
    setMeta(patch) {
      Object.assign(job.meta, patch);
      job.updatedAt = Date.now();
    },
    finish(result) {
      sealLastIfOpen();
      job.status = 'done';
      job.result = result || null;
      job.endedAt = Date.now();
      job.updatedAt = job.endedAt;
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
