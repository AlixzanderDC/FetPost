import { launchWithCookies, waitOutCloudflare } from './src/poster.js';
import fs from 'fs/promises';

const ACCOUNT = 'TheCrucible';

async function main() {
  // Try a couple events from our store — find ones with various states
  const stored = JSON.parse(await fs.readFile('/root/fetpost/fetlife-poster/data/venue-events/TheCrucible.json'));
  const sample = stored.events.slice(0, 3).map(e => e.eventUrl);
  console.log('Sampling these event URLs:', sample);

  const { browser, context } = await launchWithCookies(ACCOUNT, { headless: true });
  const page = await context.newPage();
  for (const url of sample) {
    console.log(`\n=== ${url} ===`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitOutCloudflare(page, 15000);
    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      // Look for every button, link with rsvp-related text
      const out = { buttons: [], rsvpish: [], aria: [] };
      Array.from(document.querySelectorAll('button, a')).forEach(el => {
        const txt = (el.textContent || '').trim();
        const tag = el.tagName;
        if (/^(Going|Interested|Maybe|RSVP|Attend|Cancel)/i.test(txt) && txt.length < 60) {
          out.buttons.push({
            tag,
            text: txt.slice(0, 50),
            href: el.getAttribute('href') || null,
            cls: (el.className || '').slice(0, 100),
            ariaPressed: el.getAttribute('aria-pressed'),
            ariaCurrent: el.getAttribute('aria-current'),
            disabled: el.disabled || el.hasAttribute('disabled'),
          });
        }
      });
      // Look for "You're" or "You are" patterns
      Array.from(document.querySelectorAll('span, div, p')).forEach(el => {
        const txt = (el.textContent || '').trim();
        if (/^(You'?re |You are |Your RSVP)/i.test(txt) && txt.length < 120) {
          out.rsvpish.push({tag: el.tagName, text: txt.slice(0, 100), cls: (el.className||'').slice(0, 80)});
        }
      });
      return out;
    });
    console.log(JSON.stringify(data, null, 2));
  }
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
