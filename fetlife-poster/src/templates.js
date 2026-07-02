/**
 * Per-account post templates: saved {name, postType, content, images?} entries the user
 * can load into any composer. Image data is stored inline as base64 so a template is a
 * fully-rehydratable snapshot (text + image), not just a copy pattern. Capped at
 * MAX_TEMPLATE_BYTES total per entry so a runaway 4K screenshot doesn't blow up the file.
 *
 * Storage: data/templates/<accountId>.json — flat array of records.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { writeJsonAtomic, readJsonStrict, createKeyedMutex } from './util/atomic-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');

// Serialize read-modify-write per account. Without this, two concurrent add/update/
// remove calls for the same account both read the same list and the second write
// clobbers the first (lost update).
const withTemplateLock = createKeyedMutex();
const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024; // 8MB cap including base64 overhead

function templatesFile(accountId) {
  return path.join(TEMPLATES_DIR, `${accountId}.json`);
}

export async function listTemplates(accountId) {
  return await readJsonStrict(templatesFile(accountId), {
    defaultIfMissing: [],
    label: `templates/${accountId}.json`,
  });
}

async function saveTemplates(accountId, list) {
  await fs.mkdir(TEMPLATES_DIR, { recursive: true });
  await writeJsonAtomic(templatesFile(accountId), list);
}

export async function addTemplate(accountId, { name, postType, content, images }) {
  // Image-only templates with empty caption are valid (postType 'picture'); text-only
  // templates require content. So allow empty content only when at least one image is
  // attached.
  const hasImages = Array.isArray(images) && images.length > 0;
  if (!name) throw new Error('name required');
  if (!content && !hasImages) throw new Error('content or at least one image required');
  if (postType && !['status', 'picture', 'text', 'image'].includes(postType)) {
    throw new Error('postType must be status|picture|text|image');
  }
  let cleanImages = [];
  if (hasImages) {
    let bytes = 0;
    for (const img of images) {
      if (!img || typeof img !== 'object') continue;
      const data = String(img.data || '');
      const mimeType = String(img.mimeType || '');
      const fileName = String(img.name || 'image');
      if (!data || !mimeType.startsWith('image/')) continue;
      bytes += data.length;
      if (bytes > MAX_TEMPLATE_BYTES) {
        throw new Error('Template exceeds ' + Math.floor(MAX_TEMPLATE_BYTES / 1024 / 1024) + 'MB — images too large');
      }
      cleanImages.push({ data, mimeType, name: fileName.slice(0, 200) });
    }
  }
  const id = randomBytes(8).toString('hex');
  const entry = {
    id,
    name: String(name).slice(0, 100),
    postType: postType || 'status',
    content: String(content || ''),
    images: cleanImages,
    createdAt: new Date().toISOString(),
  };
  return await withTemplateLock(accountId, async () => {
    const list = await listTemplates(accountId);
    list.push(entry);
    await saveTemplates(accountId, list);
    return entry;
  });
}

export async function removeTemplate(accountId, id) {
  return await withTemplateLock(accountId, async () => {
    const list = await listTemplates(accountId);
    const filtered = list.filter(t => t.id !== id);
    await saveTemplates(accountId, filtered);
    return { removed: list.length - filtered.length, total: filtered.length };
  });
}

// Overwrite an existing template's name/content/postType/images. Preserves the
// original id and createdAt; adds updatedAt. Same validation rules as addTemplate
// so an update can't sneak past the "content or images required" / size cap.
export async function updateTemplate(accountId, id, { name, postType, content, images }) {
  return await withTemplateLock(accountId, async () => {
    const list = await listTemplates(accountId);
    const idx = list.findIndex(t => t.id === id);
    if (idx === -1) throw new Error('Template not found');
    const hasImages = Array.isArray(images) && images.length > 0;
    if (!name) throw new Error('name required');
    if (!content && !hasImages) throw new Error('content or at least one image required');
    if (postType && !['status', 'picture', 'text', 'image'].includes(postType)) {
      throw new Error('postType must be status|picture|text|image');
    }
    let cleanImages = [];
    if (hasImages) {
      let bytes = 0;
      for (const img of images) {
        if (!img || typeof img !== 'object') continue;
        const data = String(img.data || '');
        const mimeType = String(img.mimeType || '');
        const fileName = String(img.name || 'image');
        if (!data || !mimeType.startsWith('image/')) continue;
        bytes += data.length;
        if (bytes > MAX_TEMPLATE_BYTES) {
          throw new Error('Template exceeds ' + Math.floor(MAX_TEMPLATE_BYTES / 1024 / 1024) + 'MB — images too large');
        }
        cleanImages.push({ data, mimeType, name: fileName.slice(0, 200) });
      }
    }
    list[idx] = {
      ...list[idx],
      name: String(name).slice(0, 100),
      postType: postType || list[idx].postType || 'status',
      content: String(content || ''),
      images: cleanImages,
      updatedAt: new Date().toISOString(),
    };
    await saveTemplates(accountId, list);
    return list[idx];
  });
}
