import { launchWithCookies, waitOutCloudflare } from './src/poster.js';
import fs from 'fs/promises';

const ACCOUNT = 'TheCrucible';
// Use a known event at The Crucible to find the "where" structure
const EVENT_URL = process.argv[2] || 'https://fetlife.com/events/2026/06/05/dungeon-101-june-tsdp1s';

async function main() {
  const { browser, context } = await launchWithCookies(ACCOUNT, { headless: true });
  const page = await context.newPage();
  await page.goto(EVENT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitOutCloudflare(page, 15000);
  await page.waitForTimeout(2500);

  const stats = await page.evaluate(() => {
    const out = {};
    // h2/h3 headings that might mark sections
    out.headings = Array.from(document.querySelectorAll('h2, h3')).map(h => h.textContent.trim()).slice(0, 12);
    // Any link to a /p/... venue page
    out.placeLinks = Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/p/"]')).map(a => a.href))).slice(0, 8);
    // Any text containing the address "412 V St" or "V Street"
    const addrMatches = [];
    document.querySelectorAll('*').forEach(el => {
      const t = (el.textContent || '').trim();
      if (/412\s*V\s*St|V\s*Street/i.test(t) && t.length < 200) {
        addrMatches.push({tag: el.tagName, txt: t.slice(0, 120)});
      }
    });
    out.addressHits = addrMatches.slice(0, 8);

    // Find "Where" heading and look at nearby text
    const whereH = Array.from(document.querySelectorAll('h2, h3')).find(h => /^where$/i.test(h.textContent.trim()));
    if (whereH) {
      const parent = whereH.parentElement;
      out.whereSectionText = (parent?.textContent || '').trim().slice(0, 500);
      out.whereSectionHtml = (parent?.outerHTML || '').slice(0, 1500);
    } else {
      out.whereSectionText = 'NO "Where" heading found';
    }
    return out;
  });

  console.log(JSON.stringify(stats, null, 2));
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
