/**
 * Atomic JSON store for the UI server (mirrors fetlife-poster/src/util/atomic-json.js).
 * See that file for the rationale — staged write + fsync + rename so the live file is
 * never partial, and readJsonStrict throws on parse failure instead of silently
 * collapsing back to the default.
 */

import fs from 'fs/promises';

export async function writeJsonAtomic(filePath, value, { pretty = true } = {}) {
  const json = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  const tmp = filePath + '.tmp';
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(json, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

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
      `restore from backup or fix the file manually before restarting.`
    );
  }
}
