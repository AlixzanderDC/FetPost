/**
 * FetLifeClient — use this in your main NexusPost app to talk to
 * the local fetlife-poster service running on localhost:3747.
 *
 * Usage:
 *   import { FetLifeClient } from './fetlife-client.js';
 *   const fl = new FetLifeClient({ secret: process.env.FL_SERVICE_SECRET });
 */

export class FetLifeClient {
  constructor({ baseUrl = 'http://127.0.0.1:3747', secret } = {}) {
    this.baseUrl = baseUrl;
    this.secret = secret || process.env.FL_SERVICE_SECRET;
    if (!this.secret) throw new Error('FL_SERVICE_SECRET is required');
  }

  async #request(method, path, body = null) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-service-token': this.secret,
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${this.baseUrl}${path}`, opts);
    const json = await res.json();

    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  /** Add or update a FetLife account */
  async addAccount({ accountId, username, password, groupName }) {
    return this.#request('POST', '/accounts', { accountId, username, password, groupName });
  }

  /** List all stored accounts (no passwords) */
  async listAccounts() {
    const { accounts } = await this.#request('GET', '/accounts');
    return accounts;
  }

  /** Remove an account and its stored credentials */
  async removeAccount(accountId) {
    return this.#request('DELETE', `/accounts/${accountId}`);
  }

  /** Test that stored credentials still work */
  async testAccount(accountId) {
    return this.#request('POST', `/accounts/${accountId}/test`);
  }

  // ── Posts ─────────────────────────────────────────────────────────────────

  /**
   * Schedule a status post.
   * @param {string} postId    - Unique ID (use your main app's post ID)
   * @param {string} accountId - Account to post from
   * @param {string} content   - Post text
   * @param {Date}   scheduledAt - When to post
   */
  async scheduleStatus({ postId, accountId, content, scheduledAt }) {
    return this.#request('POST', '/posts', {
      postId,
      accountId,
      content,
      scheduledAt: scheduledAt instanceof Date ? scheduledAt.toISOString() : scheduledAt,
      postType: 'status',
    });
  }

  /**
   * Schedule an event post.
   * @param {string} postId
   * @param {string} accountId
   * @param {Date}   scheduledAt - When to post the event
   * @param {object} eventDetails - { title, description, startDate, endDate, location, dresscode, isPrivate }
   */
  async scheduleEvent({ postId, accountId, scheduledAt, content, eventDetails }) {
    return this.#request('POST', '/posts', {
      postId,
      accountId,
      content: content || eventDetails.description,
      scheduledAt: scheduledAt instanceof Date ? scheduledAt.toISOString() : scheduledAt,
      postType: 'event',
      eventDetails,
    });
  }

  /** Get all posts in the queue */
  async getQueue() {
    const { posts } = await this.#request('GET', '/posts');
    return posts;
  }

  /** Cancel a scheduled post */
  async cancelPost(postId) {
    return this.#request('DELETE', `/posts/${postId}`);
  }

  /** Get post history / audit log */
  async getHistory({ accountId, limit = 50 } = {}) {
    const params = new URLSearchParams({ limit });
    if (accountId) params.set('accountId', accountId);
    const { history } = await this.#request('GET', `/history?${params}`);
    return history;
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /** Check the service is running */
  async ping() {
    const res = await fetch(`${this.baseUrl}/health`);
    return res.ok;
  }
}

// ── Example usage (remove in production) ─────────────────────────────────────
//
// const fl = new FetLifeClient({ secret: 'your-secret-here' });
//
// // Add an account
// await fl.addAccount({
//   accountId: 'leather-rope-dc-main',
//   username: 'LeatherRopeDC',
//   password: 'hunter2',
//   groupName: 'Leather & Rope DC',
// });
//
// // Schedule a status post
// await fl.scheduleStatus({
//   postId: 'post-abc123',
//   accountId: 'leather-rope-dc-main',
//   content: 'Join us Friday for rope fundamentals! RSVP via DM.',
//   scheduledAt: new Date('2026-05-09T19:00:00'),
// });
//
// // Schedule an event
// await fl.scheduleEvent({
//   postId: 'event-xyz789',
//   accountId: 'leather-rope-dc-main',
//   scheduledAt: new Date('2026-05-09T19:00:00'),
//   eventDetails: {
//     title: 'Rope Fundamentals — May Edition',
//     description: 'Monthly skill share, all levels welcome. Free with RSVP.',
//     startDate: new Date('2026-05-16T19:00:00'),
//     endDate: new Date('2026-05-16T22:00:00'),
//     location: 'TBA — DM for details',
//     dresscode: 'Casual / Fetish welcome',
//     isPrivate: false,
//   },
// });
