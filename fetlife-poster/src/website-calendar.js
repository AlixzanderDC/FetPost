/**
 * Pulls events from a venue's own website calendar (iCal/.ics feed). Useful when
 * the venue hasn't yet posted events on FetLife but they're already on their
 * primary calendar — operator can pre-schedule the FetLife promo posts using the
 * website events as the source of truth.
 *
 * Most calendar plugins (The Events Calendar, Sugar Calendar, Google/Microsoft
 * calendars) expose an .ics feed. The user pastes that URL once per account; we
 * fetch and parse on demand. No RRULE expansion in this MVP — recurring events
 * surface once at their next DTSTART.
 */

function parseIcsDate(s) {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(s);
  if (!m) return null;
  if (m[7] === 'Z') {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0));
  } else if (m[4]) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  } else {
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
}

function unescapeIcsText(s) {
  return (s || '')
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseVevent(block) {
  const out = { exdates: [] };
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const m = /^([A-Z-]+)(;[^:]*)?:(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const val = m[3];
    if (key === 'SUMMARY') out.title = unescapeIcsText(val);
    else if (key === 'URL') out.url = val;
    else if (key === 'DTSTART') out.dtStart = val;
    else if (key === 'DTEND') out.dtEnd = val;
    else if (key === 'UID') out.uid = val;
    else if (key === 'DESCRIPTION') out.description = unescapeIcsText(val);
    else if (key === 'LOCATION') out.location = unescapeIcsText(val);
    else if (key === 'RRULE') out.rrule = val;
    else if (key === 'EXDATE') {
      // EXDATE can be comma-separated and have a TZID prefix on the property name
      val.split(',').forEach(d => { if (d) out.exdates.push(d.trim()); });
    }
  }
  return out;
}

// Expand a (possibly recurring) VEVENT into one date per occurrence in the
// future, up to the given horizon. Returns an array of Date objects in
// chronological order. For a single-occurrence event with DTSTART in the
// future, returns [start]. For a weekly recurring event, returns every
// future weekday match up to the horizon (e.g. every Friday between now and
// Dec 31 → ~28 entries). For a past, non-recurring event, returns [].
//
// Handles the common patterns venue calendars actually use:
//   • FREQ=DAILY [;INTERVAL=N]
//   • FREQ=WEEKLY [;INTERVAL=N] [;BYDAY=MO,WE,FR]
//   • FREQ=MONTHLY [;INTERVAL=N] [;BYDAY=2FR] (position prefix matched loosely)
//   • FREQ=YEARLY [;INTERVAL=N]
//   • UNTIL=… termination
//   • COUNT=… termination
//   • EXDATE=… excluded dates
//
// Doesn't fully implement RFC 5545 (no BYSETPOS, BYMONTHDAY, no proper RDATE),
// but covers ~99% of the recurring rules a venue calendar uses in practice.
const DOW_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function expandOccurrences(dtStartStr, rruleStr, exdates, horizonMs) {
  const start = parseIcsDate(dtStartStr);
  if (!start) return [];
  const now = Date.now() - 24 * 3600 * 1000; // 24h grace
  const horizon = horizonMs || (Date.now() + 2 * 365 * 24 * 3600 * 1000);
  if (!rruleStr) {
    return start.getTime() >= now && start.getTime() <= horizon ? [start] : [];
  }
  // Parse RRULE
  const parts = {};
  rruleStr.split(';').forEach(p => {
    const eq = p.indexOf('=');
    if (eq <= 0) return;
    parts[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  });
  const freq = parts.FREQ;
  if (!freq) return start.getTime() >= now ? [start] : [];
  const interval = Math.max(1, parseInt(parts.INTERVAL || '1', 10));
  // Parse BYDAY entries — keep the nth-position prefix because for MONTHLY/YEARLY
  // it specifies WHICH occurrence within the month/year the rule fires. Without
  // honoring this, "2WE" (2nd Wednesday) wrongly matches every Wednesday and the
  // recurrence expands ~4× too many dates.
  const byday = (parts.BYDAY || '').split(',').filter(Boolean).map(b => {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(b.trim());
    if (!m) return null;
    return { pos: m[1] ? parseInt(m[1], 10) : 0, dow: m[2].toUpperCase() };
  }).filter(Boolean);
  const until = parts.UNTIL ? parseIcsDate(parts.UNTIL) : null;
  const count = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
  if (until && until.getTime() < now) return [];
  const excluded = new Set((exdates || []).map(e => {
    const d = parseIcsDate(e);
    return d ? d.toDateString() : null;
  }).filter(Boolean));

  function intervalOk(d) {
    if (interval <= 1) return true;
    if (freq === 'DAILY') {
      const days = Math.round((d.getTime() - start.getTime()) / (24 * 3600 * 1000));
      return days % interval === 0;
    }
    if (freq === 'WEEKLY') {
      const startMs = start.getTime() - start.getDay() * 24 * 3600 * 1000;
      const wkMs = d.getTime() - d.getDay() * 24 * 3600 * 1000;
      const weeks = Math.round((wkMs - startMs) / (7 * 24 * 3600 * 1000));
      return weeks % interval === 0;
    }
    if (freq === 'MONTHLY') {
      const months = (d.getFullYear() - start.getFullYear()) * 12 + (d.getMonth() - start.getMonth());
      return months % interval === 0;
    }
    if (freq === 'YEARLY') {
      return (d.getFullYear() - start.getFullYear()) % interval === 0;
    }
    return false;
  }

  function dowOk(d) {
    if (byday.length === 0) return true;
    const dayDow = DOW_CODES[d.getDay()];
    const dom = d.getDate();
    const lastDom = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const nthFromStart = Math.ceil(dom / 7);        // 1..5
    const nthFromEnd = Math.ceil((lastDom - dom + 1) / 7); // 1..5
    for (const b of byday) {
      if (b.dow !== dayDow) continue;
      if (b.pos === 0) return true;                  // unqualified → any nth matches
      // Position prefix only meaningful for MONTHLY/YEARLY. For WEEKLY/DAILY,
      // treat as unqualified.
      if (freq !== 'MONTHLY' && freq !== 'YEARLY') return true;
      if (b.pos > 0 && nthFromStart === b.pos) return true;
      if (b.pos < 0 && nthFromEnd === -b.pos) return true;
    }
    return false;
  }

  const results = [];
  // For COUNT-bounded recurrences, walk from DTSTART, count every match, keep
  // the ones that fall in the [now, horizon] window.
  if (count !== null) {
    let c = 0;
    const cursor = new Date(start);
    const HARD_CAP = 365 * 10;
    for (let i = 0; i < HARD_CAP && c < count; i++) {
      if (intervalOk(cursor) && dowOk(cursor) && !excluded.has(cursor.toDateString())) {
        c++;
        if (cursor.getTime() >= now && cursor.getTime() <= horizon) results.push(new Date(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return results;
  }

  // Open-ended recurrence: collect every future matching occurrence up to horizon.
  const cursor = new Date(Math.max(start.getTime(), now));
  cursor.setHours(start.getHours(), start.getMinutes(), 0, 0);
  while (cursor.getTime() <= horizon) {
    if ((!until || cursor.getTime() <= until.getTime()) &&
        intervalOk(cursor) && dowOk(cursor) && !excluded.has(cursor.toDateString())) {
      results.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return results;
}

// Deliberately do NOT modify the URL the user pasted — adding date-range or
// view-mode params caused some plugins to filter out legitimate events
// (recurring series, undated entries). The user's URL is treated as the source
// of truth; only `paged=` is added when iterating through pagination below.

// Parse a fetched iCal body into our normalized event shape. Returns [] if the
// body doesn't look like iCal (e.g. an empty page beyond pagination).
function parseIcalBody(text, websiteUrl) {
  if (!text.includes('BEGIN:VEVENT')) return [];
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const events = [];
  const re = /BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g;
  let m;
  const pad = n => String(n).padStart(2, '0');
  // Lookahead horizon: end of next calendar year. Generous so recurring events
  // far in the future still surface for the digest's week picker.
  const horizonMs = new Date(new Date().getFullYear() + 1, 11, 31, 23, 59, 59).getTime();
  while ((m = re.exec(unfolded)) !== null) {
    const ev = parseVevent(m[1]);
    if (!ev.title) continue;
    // Emit ONE event per occurrence. For a weekly Friday event between now and
    // year-end, that's ~28 entries — exactly what the digest's per-week picker
    // needs to see each occurrence as its own row.
    const occurrences = expandOccurrences(ev.dtStart, ev.rrule, ev.exdates, horizonMs);
    for (const start of occurrences) {
      const isoDate = start.getFullYear() + '-' + pad(start.getMonth() + 1) + '-' + pad(start.getDate());
      events.push({
        url: ev.url || websiteUrl,
        title: ev.title,
        dateText: start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        urlDate: isoDate,
        isPast: false, // expandOccurrences already filtered past dates
        eventSource: 'website',
        location: ev.location,
        uid: ev.uid,
        isRecurring: !!ev.rrule,
      });
    }
  }
  return events;
}

async function fetchOnePage(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'text/calendar, application/ics, */*', 'User-Agent': 'FetPost/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return { ok: false, status: res.status, text: '' };
  return { ok: true, status: 200, text: await res.text() };
}

export async function fetchWebsiteEvents(websiteUrl) {
  if (!websiteUrl) throw new Error('websiteUrl is required');

  // Page 1 — fetch the user's URL EXACTLY as pasted. No param injection.
  let first;
  try {
    first = await fetchOnePage(websiteUrl);
  } catch (err) {
    throw new Error('Could not reach calendar URL: ' + err.message);
  }
  if (!first.ok) throw new Error('Calendar fetch failed: HTTP ' + first.status);
  if (!first.text.includes('BEGIN:VEVENT')) {
    throw new Error(
      'Response does not look like an iCal feed (no BEGIN:VEVENT markers). ' +
      'Try the calendar plugin\'s Export/Subscribe link — most expose an .ics URL.'
    );
  }

  const seen = new Set();
  const all = [];
  function ingest(eventList) {
    let added = 0;
    for (const ev of eventList) {
      // Dedup key MUST include the date — recurring series share UIDs across
      // occurrences per RFC 5545. UID-only dedup collapses every weekly play
      // party into a single row.
      const key = (ev.uid ? ev.uid + '|' : '') + (ev.urlDate || '') + '|' + (ev.title || '');
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(ev);
      added++;
    }
    return added;
  }
  ingest(parseIcalBody(first.text, websiteUrl));

  // Pages 2..N — only kick in if the plugin appears to paginate (i.e. page 2
  // returns *different* events than page 1). Stop the moment a page adds nothing
  // new. Cap at 20 pages so a misconfigured plugin can't loop us forever.
  const PAGE_PARAMS = ['paged', 'page', 'pg'];
  for (let page = 2; page <= 20; page++) {
    let addedThisPage = 0;
    let anyOkFetch = false;
    for (const param of PAGE_PARAMS) {
      let parsed;
      try { parsed = new URL(websiteUrl); } catch { continue; }
      parsed.searchParams.set(param, String(page));
      let result;
      try { result = await fetchOnePage(parsed.toString()); } catch { continue; }
      if (!result.ok) continue;
      anyOkFetch = true;
      const events = parseIcalBody(result.text, websiteUrl);
      if (events.length === 0) continue;
      addedThisPage += ingest(events);
    }
    if (!anyOkFetch || addedThisPage === 0) break;
  }

  const upcoming = all
    .filter(e => !e.isPast)
    .sort((a, b) => (a.urlDate || '').localeCompare(b.urlDate || ''));
  console.log('[website-calendar] ' + websiteUrl + ' → ' + all.length + ' parsed, ' + upcoming.length + ' upcoming');
  return upcoming;
}
