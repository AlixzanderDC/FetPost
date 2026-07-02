import { launchWithCookies, waitOutCloudflare } from './src/poster.js';
import fs from 'fs/promises';
import path from 'path';

const ACCOUNT = process.argv[2] || 'Alixzander Main Account';
const KEYWORD = process.argv[3] || 'Crucible';
const OUT_DIR = '/tmp/mentions-recon';

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(`[recon] Account: ${ACCOUNT}`);
  console.log(`[recon] Test keyword: ${KEYWORD}`);

  const { browser, context } = await launchWithCookies(ACCOUNT, { headless: true });
  const page = await context.newPage();

  for (const probe of [
    { name: 'notifications',    url: 'https://fetlife.com/notifications' },
    { name: 'mentions',         url: 'https://fetlife.com/mentions' },
    { name: 'search-posts',     url: `https://fetlife.com/search?q=${encodeURIComponent(KEYWORD)}&type=Posts` },
    { name: 'search-writings',  url: `https://fetlife.com/search?q=${encodeURIComponent(KEYWORD)}&type=Writings` },
    { name: 'search-statuses',  url: `https://fetlife.com/search?q=${encodeURIComponent(KEYWORD)}&type=Statuses` },
    { name: 'search-default',   url: `https://fetlife.com/search?q=${encodeURIComponent(KEYWORD)}` },
  ]) {
    console.log(`[recon] ${probe.name} -> ${probe.url}`);
    try {
      await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitOutCloudflare(page, 15000);
      await page.waitForTimeout(2500);
      const html = await page.content();
      const url = page.url();
      const title = await page.title();
      await fs.writeFile(path.join(OUT_DIR, `${probe.name}.html`), html, 'utf8');
      await page.screenshot({ path: path.join(OUT_DIR, `${probe.name}.png`), fullPage: false });
      console.log(`  finalUrl: ${url}`);
      console.log(`  title:    ${title}`);
      console.log(`  htmlLen:  ${html.length}`);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }

  await browser.close();
  console.log('[recon] Done. Output dir:', OUT_DIR);
}

main().catch(err => { console.error(err); process.exit(1); });
