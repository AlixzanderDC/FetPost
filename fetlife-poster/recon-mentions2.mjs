import { launchWithCookies, waitOutCloudflare } from './src/poster.js';
import fs from 'fs/promises';
import path from 'path';

const ACCOUNT = 'Alixzander Main Account';
const KEYWORD = 'Crucible';
const OUT_DIR = '/tmp/mentions-recon2';

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const { browser, context } = await launchWithCookies(ACCOUNT, { headless: true });
  const page = await context.newPage();

  for (const probe of [
    { name: 'sw',  url: `https://fetlife.com/search/writings?q=${encodeURIComponent(KEYWORD)}` },
    { name: 'ss',  url: `https://fetlife.com/search/statuses?q=${encodeURIComponent(KEYWORD)}` },
  ]) {
    console.log(`\n[recon] ${probe.name} -> ${probe.url}`);
    try {
      await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitOutCloudflare(page, 15000);
      await page.waitForTimeout(2500);
      const html = await page.content();
      await fs.writeFile(path.join(OUT_DIR, `${probe.name}.html`), html, 'utf8');
      await page.screenshot({ path: path.join(OUT_DIR, `${probe.name}.png`), fullPage: false });
      console.log(`  finalUrl: ${page.url()}`);
      console.log(`  title: ${await page.title()}`);
      console.log(`  htmlLen: ${html.length}`);

      // Quick eval: count things that look like result items
      const stats = await page.evaluate(() => {
        const out = {};
        // Common patterns
        out.h3Count = document.querySelectorAll('h3').length;
        out.postLinks = Array.from(document.querySelectorAll('a[href*="/posts/"], a[href*="/s/"]')).map(a => a.href).slice(0, 12);
        out.articleCount = document.querySelectorAll('article').length;
        return out;
      });
      console.log(`  h3 count: ${stats.h3Count}`);
      console.log(`  article count: ${stats.articleCount}`);
      console.log(`  sample post links:`);
      stats.postLinks.forEach(u => console.log(`    ${u}`));
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }

  await browser.close();
  console.log('\n[recon] Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
