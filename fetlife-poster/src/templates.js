/**
 * Per-account post templates: saved {name, postType, content} entries the user can
 * load into the Compose form. Images are intentionally not saved — templates are for
 * recurring copy patterns, not full snapshots.
 *
 * Storage: data/templates/<accountId>.json — flat array of records.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');

function templatesFile(accountId) {
  return path.join(TEMPLATES_DIR, `${accountId}.json`);
}

export async function listTemplates(accountId) {
  try {
    const raw = await fs.readFile(templatesFile(accountId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveTemplates(accountId, list) {
  await fs.mkdir(TEMPLATES_DIR, { recursive: true });
  await fs.writeFile(templatesFile(accountId), JSON.stringify(list, null, 2));
}

export async function addTemplate(accountId, { name, postType, content }) {
  if (!name || !content) throw new Error('name and content required');
  if (postType && !['status', 'picture', 'text', 'image'].includes(postType)) {
    throw new Error('postType must be status|picture|text|image');
  }
  const list = await listTemplates(accountId);
  const id = randomBytes(8).toString('hex');
  const entry = {
    id,
    name: String(name).slice(0, 100),
    postType: postType || 'status',
    content: String(content),
    createdAt: new Date().toISOString(),
  };
  list.push(entry);
  await saveTemplates(accountId, list);
  return entry;
}

export async function removeTemplate(accountId, id) {
  const list = await listTemplates(accountId);
  const filtered = list.filter(t => t.id !== id);
  await saveTemplates(accountId, filtered);
  return { removed: list.length - filtered.length, total: filtered.length };
}
