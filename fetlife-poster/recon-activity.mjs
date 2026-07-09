/**
 * Recon: what does the logged-in account's own /<nick>/activity page look like,
 * and how do we reliably discover the nickname from /home?
 * Run: node --env-file=/root/fetpost/.env recon-activity.mjs <accountId>
 */
import fs from 'fs/promises';
import { launchWithCookies, checkLoggedIn, waitOutCloudflare } from './src/poster.js';

const accountId = process.argv[2] || 'TheCrucible';
const { browser, context } = await launchWithCookies(accountId, { headless: true });

try {
  const page = await context.newPage();
  await page.goto('https://fetlife.com/home', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 3000));
  await checkLoggedIn(page);

  // Strategy dump: how can we find our own nickname on /home?
  const nickInfo = await page.evaluate(() => {
    const out = { profileLinks: [], jsonHits: [] };
    // Anchors that look like profile links and contain an <img> (avatar)
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/^\/[A-Za-z0-9_-]{3,30}$/.test(href) && !/^\/(home|login|search|events|groups|places|glossary|notifications|conversations|requests|settings|support|help|about|wallpapers)$/i.test(href)) {
        out.profileLinks.push({
          href,
          hasImg: !!a.querySelector('img'),
          text: (a.textContent || '').trim().slice(0, 40),
          imgAlt: a.querySelector('img')?.getAttribute('alt') || null,
        });
      }
    }
    // JSON blobs mentioning nickname
    const html = document.documentElement.innerHTML;
    for (const m of html.matchAll(/"(?:nickname|screen_name|username)"\s*:\s*"([^"]{2,40})"/g)) {
      out.jsonHits.push(m[0].slice(0, 80));
      if (out.jsonHits.length > 10) break;
    }
    return out;
  });
  console.log('=== /home nickname candidates ===');
  console.log(JSON.stringify(nickInfo, null, 1).slice(0, 3000));

  // Pick best guess nickname: most frequent profile-link href with an avatar img
  const counts = {};
  for (const l of nickInfo.profileLinks) counts[l.href] = (counts[l.href] || 0) + (l.hasImg ? 2 : 1);
  const guess = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]?.slice(1);
  console.log('=== best-guess nickname:', guess);

  const nick = guess || 'The-Crucible';
  await page.goto(`https://fetlife.com/${nick}/activity`, { waitUntil: 'domcontentloaded' });
  await waitOutCloudflare(page, 20000);
  await new Promise(r => setTimeout(r, 4000));

  const act = await page.evaluate(() => {
    const out = { url: location.href, title: document.title, groupPostLinks: [], stories: [] };
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      if (/\/groups\/\d+\/(group_)?posts\/\d+/.test(href)) {
        out.groupPostLinks.push({ href, text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100) });
      }
    }
    // Dump the first few feed story containers' structure (trimmed)
    const candidates = document.querySelectorAll('[class*="story"], article, [class*="feed"] > div, main li');
    let i = 0;
    for (const el of candidates) {
      const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length < 10) continue;
      out.stories.push(txt.slice(0, 200));
      if (++i >= 8) break;
    }
    return out;
  });
  console.log('=== /activity ===');
  console.log(JSON.stringify(act, null, 1).slice(0, 6000));

  const html = await page.content();
  await fs.writeFile(`/root/fetpost/.recon-activity-${accountId.replace(/[^a-z0-9]/gi, '_')}.html`, html, 'utf8');
  console.log('HTML dumped.');
} finally {
  await browser.close().catch(() => {});
}
process.exit(0);
