import { launchWithCookies, waitOutCloudflare } from './src/poster.js';
import fs from 'fs/promises';
import path from 'path';

const ACCOUNT = process.argv[2] || 'TheCrucible';
const OUT_DIR = '/tmp/events-recon';

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  console.log(`[recon] Account: ${ACCOUNT}`);

  const { browser, context } = await launchWithCookies(ACCOUNT, { headless: true });
  const page = await context.newPage();

  // Try several event-discovery URLs to learn FetLife's location-based event surface
  for (const probe of [
    { name: 'events-near',          url: 'https://fetlife.com/events/near' },
    { name: 'events-near-washington', url: 'https://fetlife.com/p/united-states/district-of-columbia/washington/events' },
    { name: 'events-cities',        url: 'https://fetlife.com/events/cities' },
    { name: 'events-rsvps',         url: 'https://fetlife.com/events/rsvps' },
    { name: 'search-events-crucible', url: 'https://fetlife.com/search/events?q=Crucible' },
    { name: 'search-events-dc',     url: 'https://fetlife.com/search/events?q=Washington' },
  ]) {
    console.log(`\n[recon] ${probe.name} -> ${probe.url}`);
    try {
      await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitOutCloudflare(page, 15000);
      await page.waitForTimeout(2000);
      const html = await page.content();
      const finalUrl = page.url();
      const title = await page.title();
      await fs.writeFile(path.join(OUT_DIR, `${probe.name}.html`), html, 'utf8');
      await page.screenshot({ path: path.join(OUT_DIR, `${probe.name}.png`), fullPage: false }).catch(() => {});
      console.log(`  finalUrl: ${finalUrl}`);
      console.log(`  title:    ${title}`);
      console.log(`  htmlLen:  ${html.length}`);

      const stats = await page.evaluate(() => {
        return {
          articleCount: document.querySelectorAll('article').length,
          eventLinkCount: document.querySelectorAll('a[href*="/events/"]').length,
          sampleEventLinks: Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/events/"]')).map(a => a.href))).slice(0, 8),
          h1s: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 5).map(h => h.tagName + ': ' + (h.textContent || '').trim().slice(0, 80)),
        };
      });
      console.log(`  articles: ${stats.articleCount}, eventLinks: ${stats.eventLinkCount}`);
      console.log(`  headings: ${JSON.stringify(stats.h1s)}`);
      console.log(`  sampleLinks:`);
      stats.sampleEventLinks.forEach(u => console.log(`    ${u}`));
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
    }
  }

  await browser.close();
  console.log('\n[recon] Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
