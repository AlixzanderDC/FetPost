/**
 * iCal/ICS calendar generator for an organizer's upcoming FetLife events.
 * Reads from data/events/<accountId>.json (the discovery cache) and emits a
 * RFC-5545-flavored .ics body that Google/Outlook/Apple Calendar can subscribe to.
 *
 * Auth model: per-account iCalToken stored in account meta (random 24-byte b64),
 * generated on first request from the UI. The public /calendar/<accountId>/<token>.ics
 * route checks the token before generating.
 */

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getAccount, updateAccountFields } from './credentials.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_DIR = path.join(__dirname, '..', 'data', 'events');

function pad(n) { return String(n).padStart(2, '0'); }

// iCal datetime format: 20260611T200000 (UTC, no separators, suffix Z)
function toICalDateTime(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// All-day date format: 20260611
function toICalDate(yyyyMMdd) {
  return yyyyMMdd.replace(/-/g, '');
}

// Escape iCal-special chars in TEXT fields per RFC 5545 section 3.3.11
function escIcalText(s) {
  if (!s) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Fold long lines per RFC 5545 (75 chars per physical line, continuation with leading space)
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < line.length) {
    if (i === 0) {
      parts.push(line.slice(0, 75));
      i = 75;
    } else {
      parts.push(' ' + line.slice(i, i + 74));
      i += 74;
    }
  }
  return parts.join('\r\n');
}

/**
 * Try to parse FetLife's dateText "Thu, Jun 11 at 8:00 PM EDT" into a Date.
 * Falls back to the URL-encoded date with a 20:00 local-time assumption.
 */
function parseEventStart(event) {
  const dateText = event.dateText;
  if (dateText) {
    // Normalize: "Thu, Jun 11 at 8:00 PM EDT" -> "Jun 11 8:00 PM EDT" (drop dayname + "at")
    let cleaned = dateText.replace(/^[A-Za-z]+,\s*/, '').replace(/\s+at\s+/i, ' ');
    // JS Date parser is lenient enough to handle this format directly. Add the year
    // from the URL if dateText omits it (FetLife sometimes does).
    if (!/\b20\d{2}\b/.test(cleaned) && event.urlDate) {
      const yr = event.urlDate.slice(0, 4);
      cleaned = cleaned + ' ' + yr;
    }
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) return d;
  }
  // Fallback: use urlDate at 20:00 UTC (typical kink event start)
  if (event.urlDate) {
    const [y, m, d] = event.urlDate.split('-');
    return new Date(Date.UTC(+y, +m - 1, +d, 20, 0, 0));
  }
  return null;
}

async function loadEvents(accountId) {
  const upcomingFile = path.join(EVENTS_DIR, accountId + '.json');
  try {
    const raw = await fs.readFile(upcomingFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.events || [];
  } catch {
    return [];
  }
}

export async function generateIcsFor(accountId) {
  const account = await getAccount(accountId);
  if (!account) throw new Error('Unknown account');

  const events = await loadEvents(accountId);
  const calendarName = `FetPost — ${account.groupName || account.accountId} events`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FetPost//FetLife Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldLine('X-WR-CALNAME:' + escIcalText(calendarName)),
    foldLine('X-WR-CALDESC:' + escIcalText('Upcoming FetLife events organized by ' + (account.groupName || account.accountId) + '. Auto-synced from FetPost.')),
    'X-WR-TIMEZONE:UTC',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];

  const now = new Date();
  const stamp = toICalDateTime(now);

  for (const event of events) {
    const start = parseEventStart(event);
    if (!start || isNaN(start.getTime())) continue;
    // Skip events that ended >2 days ago (gives a small buffer for late-RSVP browsing)
    if (start.getTime() < now.getTime() - 2 * 86400000) continue;

    // Estimate 4-hour duration (typical kink-event window). Unknown is better than wrong.
    const end = new Date(start.getTime() + 4 * 3600 * 1000);
    const uid = (event.id || event.url || crypto.randomBytes(8).toString('hex')) + '@fetpost';

    const eventLines = [
      'BEGIN:VEVENT',
      foldLine('UID:' + escIcalText(uid)),
      'DTSTAMP:' + stamp,
      'DTSTART:' + toICalDateTime(start),
      'DTEND:' + toICalDateTime(end),
      foldLine('SUMMARY:' + escIcalText(event.title || 'FetLife Event')),
      event.location ? foldLine('LOCATION:' + escIcalText(event.location)) : null,
      event.url ? foldLine('URL:' + event.url) : null,
      event.url ? foldLine('DESCRIPTION:' + escIcalText('Full details on FetLife: ' + event.url)) : null,
      event.category ? foldLine('CATEGORIES:' + escIcalText(event.category)) : null,
      'END:VEVENT',
    ].filter(Boolean);
    lines.push(...eventLines);
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/**
 * Generate (or return existing) the per-account iCal token. The token gates
 * public-URL access to the calendar — anyone with the URL can subscribe; without
 * it, the calendar is inaccessible by accountId alone.
 */
export async function ensureIcalToken(accountId) {
  const account = await getAccount(accountId);
  if (!account) throw new Error('Unknown account');
  if (account.iCalToken && /^[A-Za-z0-9_-]{20,}$/.test(account.iCalToken)) return account.iCalToken;
  const token = crypto.randomBytes(24).toString('base64url');
  await updateAccountFields(accountId, { iCalToken: token });
  return token;
}

export async function validateIcalToken(accountId, token) {
  if (!token) return false;
  const account = await getAccount(accountId);
  if (!account || !account.iCalToken) return false;
  return crypto.timingSafeEqual(Buffer.from(account.iCalToken), Buffer.from(token));
}
