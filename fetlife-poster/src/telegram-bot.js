/**
 * Telegram Bot API notifier. Mirrors discord-webhook.js's surface so the scheduler
 * can fire both in parallel. User configures per-account telegramBotToken (from
 * @BotFather) + telegramChatId (their own chat with the bot, or a channel id).
 *
 * Bot setup for the user:
 *  1. Message @BotFather on Telegram → /newbot → name + username → get token
 *  2. Start a chat with the new bot (message it /start) to give it permission to DM you
 *  3. Visit https://api.telegram.org/bot<token>/getUpdates to find your chat.id
 *  4. Paste both into FetPost's per-account Telegram fields
 *
 * Why Telegram alongside Discord: research flagged Telegram as the dominant
 * adult-content broadcast platform in Europe + parts of LATAM, and many EU kink
 * orgs run channels alongside FetLife. Bot API is trivial (no OAuth).
 */

import { getAccount } from './credentials.js';

const TG_BASE = 'https://api.telegram.org/bot';

// Trim helper (Telegram caps messages at 4096 chars)
const trim = (s, n = 4000) => {
  if (!s) return s;
  s = String(s);
  return s.length > n ? s.slice(0, n - 1).trim() + '…' : s;
};

// Escape per Telegram MarkdownV2: _ * [ ] ( ) ~ ` > # + - = | { } . !
function escMd(s) {
  if (!s) return '';
  return String(s).replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function postToTelegram(botToken, chatId, text, opts = {}) {
  if (!botToken || !chatId) return { skipped: true, reason: 'no-config' };
  // Defensive: tokens look like "12345:AAAAAAaaaaaa..."
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(String(botToken).trim())) {
    return { skipped: true, reason: 'invalid-bot-token' };
  }
  const url = `${TG_BASE}${botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: trim(text),
    parse_mode: opts.parseMode || 'MarkdownV2',
    disable_web_page_preview: opts.disablePreview || false,
    disable_notification: opts.silent || false,
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: errText.slice(0, 240) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function notifyPostPublished(job, result) {
  const account = await getAccount(job.accountId).catch(() => null);
  const token = account?.telegramBotToken;
  const chatId = account?.telegramChatId;
  if (!token || !chatId) return { skipped: true };
  const label = account?.groupName || account?.accountId || 'unknown';
  const title = job.title || (job.content || '').split('\n')[0] || 'FetLife post';
  const body = job.body || job.content || '';
  const url = result?.url || job.eventUrl;
  // Content-style broadcast: bold title, body, attribution, link. Looks like
  // an org announcement in your Telegram, not a terse "✓ posted" ping.
  let msg = `*${escMd(title)}*`;
  if (body && body !== title) msg += `\n\n${escMd(trim(body, 3000))}`;
  msg += `\n\n_${escMd('— ' + label)}_`;
  if (url) msg += `\n${escMd(url)}`;
  return await postToTelegram(token, chatId, msg);
}

export async function notifyPostFailed(job, errorMessage) {
  const account = await getAccount(job.accountId).catch(() => null);
  const token = account?.telegramBotToken;
  const chatId = account?.telegramChatId;
  if (!token || !chatId) return { skipped: true };
  const label = account?.groupName || account?.accountId || 'unknown';
  const title = job.title || (job.content || '').split('\n')[0] || 'FetLife post';
  const msg = `⚠️ *${escMd('Post failed')}* · _${escMd(label)}_\n${escMd(title)}\n\n${escMd(trim(errorMessage || 'no error message', 600))}`;
  return await postToTelegram(token, chatId, msg);
}

export async function notifyCookieExpired(accountId, hint) {
  const account = await getAccount(accountId).catch(() => null);
  const token = account?.telegramBotToken;
  const chatId = account?.telegramChatId;
  if (!token || !chatId) return { skipped: true };
  const label = account?.groupName || account?.accountId || accountId;
  const msg = `🍪 *${escMd('Cookies expired')}* · _${escMd(label)}_\n${escMd(trim(hint || 'Refresh required to continue posting/scanning.', 400))}`;
  return await postToTelegram(token, chatId, msg, { disablePreview: true });
}

export async function notifyEvent(accountId, kind, title, body, opts = {}) {
  const account = await getAccount(accountId).catch(() => null);
  const token = account?.telegramBotToken;
  const chatId = account?.telegramChatId;
  if (!token || !chatId) return { skipped: true };
  const label = account?.groupName || account?.accountId || accountId;
  const head = kind === 'mention' ? '💬' : kind === 'cookieExpired' ? '🍪' : 'ℹ️';
  const msg = `${head} *${escMd(title || kind)}* · _${escMd(label)}_` + (body ? `\n${escMd(trim(body, 1200))}` : '') + (opts.url ? `\n${escMd(opts.url)}` : '');
  return await postToTelegram(token, chatId, msg, { disablePreview: true });
}

export async function testBot(botToken, chatId, accountLabel) {
  return await postToTelegram(
    botToken,
    chatId,
    `✓ *${escMd('FetPost connected')}* · _${escMd(accountLabel || 'test')}_\n${escMd('This is a test message from FetPost. Notifications for this account will arrive here.')}`
  );
}
