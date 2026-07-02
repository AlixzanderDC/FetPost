/**
 * Atomic JSON store helpers.
 *
 * Critical persistent stores (credentials.enc, accounts.json, license.json, queue.json,
 * venue-events, templates, mentions, tracked-*, discovery caches) all live as flat files
 * under fetlife-poster/data/. A naïve `fs.writeFile(path, data)` is NOT crash-safe: a
 * SIGKILL or power loss mid-write leaves a truncated file. Next boot the truncated file
 * parses as garbage; if the loader silently fell back to "empty state" the next save
 * would overwrite the original — silent data loss.
 *
 * This module gives every store one well-tested pair:
 *
 *   writeJsonAtomic(filePath, value)
 *      — staged write to <filePath>.tmp, fsync, then rename(2) over the live file.
 *        rename(2) is atomic within the same filesystem on POSIX, so the live file
 *        is either fully-old or fully-new — never partial.
 *
 *   readJsonStrict(filePath, { defaultIfMissing })
 *      — returns the parsed contents. If the file doesn't exist returns the supplied
 *        default (use this only for "no state yet" cases). If the file EXISTS but
 *        fails to parse it THROWS. Quietly returning `{}` is the bug that destroyed
 *        244 queue jobs in the past — never do it.
 *
 *   writeRawAtomic(filePath, stringOrBuffer)
 *      — same atomic discipline but for non-JSON payloads (e.g. credentials.enc base64).
 *
 * Conventions:
 *   - Caller is responsible for `fs.mkdir(dir, { recursive: true })` of the parent
 *     directory if it may not exist. (Calling it here on every write would mask the
 *     "directory disappeared under me" failure mode.)
 *   - .tmp files left over from a crash mid-write are harmless: they're never read,
 *     and the next successful write overwrites them. A periodic cleanup at boot is
 *     a nicety, not a requirement.
 */

import fs from 'fs/promises';

export async function writeJsonAtomic(filePath, value, { pretty = true } = {}) {
  const json = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  return writeRawAtomic(filePath, json);
}

export async function writeRawAtomic(filePath, contents) {
  const tmp = filePath + '.tmp';
  // open + write + fsync + close so the OS has actually flushed the bytes to disk
  // before we rename. Without fsync, rename(2) is still atomic for the directory
  // entry, but a power loss after rename could leave the new file pointing at
  // unwritten-data sectors. This is belt + suspenders for the credentials path.
  const handle = await fs.open(tmp, 'w');
  try {
    if (typeof contents === 'string') {
      await handle.writeFile(contents, 'utf8');
    } else {
      await handle.writeFile(contents);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

/**
 * Read + JSON.parse a file. If the file is missing return `defaultIfMissing`.
 * If the file exists but parsing fails, THROW with a labeled error so the operator
 * can restore from backup before any caller overwrites the damaged state.
 *
 * Pass `label` to make the error attributable in logs ("credentials.enc failed to
 * parse" beats "Unexpected token in JSON at position 0").
 */
export async function readJsonStrict(filePath, { defaultIfMissing, label } = {}) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (defaultIfMissing !== undefined) return defaultIfMissing;
      throw err;
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const tag = label || filePath;
    throw new Error(
      `${tag} failed to parse (${err.message}). Refusing to load empty state — ` +
      `restore from backup or fix the file manually before restarting the service.`
    );
  }
}

/**
 * Per-key mutex. Returns a function `mutate(key, work)` that serializes `work(key)`
 * for the same key while letting different keys run in parallel. Modeled on
 * scheduler.js's queueOpChain pattern (one chain there because there's a single
 * queue.json; here each accountId / store gets its own chain).
 *
 * Usage:
 *   const mutateVenue = createKeyedMutex();
 *   await mutateVenue(accountId, async () => {
 *     const store = await readStore(accountId);
 *     // ...mutate...
 *     await writeStore(accountId, store);
 *   });
 */
export function createKeyedMutex() {
  const chains = new Map();
  return function mutate(key, work) {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(async () => work());
    const guarded = next.catch(() => {});
    chains.set(key, guarded);
    // Evict the key once this link settles, but only if nothing else has queued
    // behind it (i.e. we're still the tail). Without this the map grows without
    // bound as new keys arrive — per-scrape jobIds are effectively unbounded.
    guarded.then(() => {
      if (chains.get(key) === guarded) chains.delete(key);
    });
    return next;
  };
}
