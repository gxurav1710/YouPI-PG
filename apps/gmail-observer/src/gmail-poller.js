import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PaymentObserverClient } from '@youpi/observer-sdk';
import { getObserverToken } from '@youpi/common';
import { BankEmailParser, redactSensitiveData, isAuthorizedBankEmailSender } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

function extractBodyFromGmailPayload(payload) {
  if (!payload) return '';
  const directParts = Array.isArray(payload.parts) ? payload.parts : [];
  const bodyParts = [payload, ...directParts];
  const isAttachment = part => Boolean(part.filename) || (Array.isArray(part.headers) &&
    part.headers.some(header => header.name.toLowerCase() === 'content-disposition' &&
      /^\s*attachment(?:\s*;|\s*$)/i.test(header.value)));

  function collectNestedParts(container) {
    // Follow MIME body containers, not attached messages or named attachments.
    if (!container.mimeType?.startsWith('multipart/') || isAttachment(container)) return;
    for (const child of Array.isArray(container.parts) ? container.parts : []) {
      if (isAttachment(child)) continue;
      bodyParts.push(child);
      collectNestedParts(child);
    }
  }
  for (const part of directParts) collectNestedParts(part);

  // Search the whole body tree for plain text before accepting any HTML branch.
  for (const mimeType of ['text/plain', 'text/html']) {
    for (const part of bodyParts) {
      if (part.mimeType === mimeType && part.body?.data) {
        try {
          const text = Buffer.from(part.body.data, 'base64url').toString('utf8');
          return mimeType === 'text/html' ? text.replace(/<[^>]+>/g, ' ') : text;
        } catch {}
      }
    }
  }

  // Preserve the legacy fallback for untyped top-level/direct parts without
  // broadening it to binary attachments found inside nested MIME containers.
  for (const part of [payload, ...directParts]) {
    if (part.body?.data) {
      try {
        return Buffer.from(part.body.data, 'base64url').toString('utf8');
      } catch {}
    }
  }
  return '';
}

export class GmailPoller {
  /**
   * @param {{
   *   apiBaseUrl?: string,
   *   receivingAccountId?: string,
   *   pollIntervalMs?: number,
   *   storagePath?: string
   * }} options
   */
  constructor(options = {}) {
    const isLocalhost = process.env.YOUPI_MODE === 'localhost' || !process.env.YOUPI_MODE;
    this.apiBaseUrl = options.apiBaseUrl || (isLocalhost ? `http://127.0.0.1:${process.env.PAYMENT_API_PORT || 6100}` : (process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100'));
    this.receivingAccountId = options.receivingAccountId || process.env.RECEIVING_ACCOUNT_ID || null;
    this.pollIntervalMs = options.pollIntervalMs || Number(process.env.GMAIL_POLL_INTERVAL_MS || 2000);
    this.storagePath = options.storagePath || path.join(rootDir, 'data', 'gmail_processed_ids.json');
    this.observerClient = new PaymentObserverClient({
      apiBaseUrl: this.apiBaseUrl,
      sourceName: 'GMAIL'
    });

    this.isRunning = false;
    this.timer = null;
    this.lastPollAt = null;
    this.observedCount = 0;
    this.credentials = null;
    this.cachedAccessToken = null;
    this.tokenExpiresAt = 0;
    this.processedMessageIds = new Set();
    this.loadProcessedIdsFromDisk();

    // Boot lifecycle & health status
    this.lifecycleState = 'STANDBY';
    this.degradedReason = null;
    this.lastBootCheckAt = null;
    this.bootRetryTimer = null;
    this.bootVersion = 0;
    this.backoffDelayMs = 5000;

    // Pagination & Lookback state (Issue #104)
    this.maxPagesPerCycle = options.maxPagesPerCycle || Number(process.env.GMAIL_MAX_PAGES_PER_CYCLE || 5);
    this.maxResultsPerPage = options.maxResultsPerPage || 10;
    this.lastTopMessageId = null;
    this.nextCatchUpPageToken = null;
  }

  clearBootRetryTimer() {
    if (this.bootRetryTimer) {
      clearTimeout(this.bootRetryTimer);
      this.bootRetryTimer = null;
    }
  }

  scheduleBootRetry(reason) {
    this.clearBootRetryTimer();
    if (reason === 'TOKEN_REFRESH_FAILED' || reason === 'OAUTH_CREDENTIALS_EXPIRED') {
      this.lifecycleState = 'DEGRADED';
    } else if (this.lifecycleState !== 'DEGRADED') {
      this.lifecycleState = 'STANDBY';
    }
    this.degradedReason = reason;

    // Bounded exponential backoff between 5s and 60s
    const delay = this.backoffDelayMs;
    this.backoffDelayMs = Math.min(this.backoffDelayMs * 2, 60000);

    this.bootRetryTimer = setTimeout(() => {
      this.startBootLifecycle().catch(() => {});
    }, delay);
    if (typeof this.bootRetryTimer.unref === 'function') {
      this.bootRetryTimer.unref();
    }
  }

  /**
   * Evaluates all startup prerequisites before enabling active polling.
   * Prerequisites:
   * 1. Receiving account ID must be configured and valid.
   * 2. Gmail OAuth credentials must exist.
   * 3. Google access token must be successfully acquired.
   * @returns {Promise<{ success: boolean, state: string, reason?: string }>}
   */
  async startBootLifecycle() {
    const bootVersion = ++this.bootVersion;
    this.lastBootCheckAt = new Date().toISOString();

    // 1. Validate receiving account ID
    if (!this.receivingAccountId) {
      console.log('[Gmail Observer Lifecycle] Standby: RECEIVING_ACCOUNT_ID is not configured.');
      this.scheduleBootRetry('MISSING_RECEIVING_ACCOUNT');
      return { success: false, state: 'STANDBY', reason: 'MISSING_RECEIVING_ACCOUNT' };
    }

    // 2. Fetch / verify OAuth credentials
    if (!this.credentials?.refreshToken || !this.credentials?.clientId || !this.credentials?.clientSecret) {
      await this.fetchCredentialsFromPaymentApi();
    }
    if (bootVersion !== this.bootVersion) return { success: false, state: this.lifecycleState };

    const { clientId, clientSecret, refreshToken } = this.credentials || {};
    if (!clientId || !clientSecret || !refreshToken) {
      console.log('[Gmail Observer Lifecycle] Standby: Gmail OAuth credentials not configured in Payment API.');
      this.scheduleBootRetry('MISSING_OAUTH_CREDENTIALS');
      return { success: false, state: 'STANDBY', reason: 'MISSING_OAUTH_CREDENTIALS' };
    }

    // 3. Test token acquisition
    const token = await this.getAccessToken();
    if (bootVersion !== this.bootVersion) return { success: false, state: this.lifecycleState };
    if (!token) {
      console.warn('[Gmail Observer Lifecycle] Degraded: Token acquisition/refresh failed.');
      this.scheduleBootRetry('TOKEN_REFRESH_FAILED');
      return { success: false, state: 'DEGRADED', reason: 'TOKEN_REFRESH_FAILED' };
    }

    // All prerequisites pass!
    this.clearBootRetryTimer();
    this.backoffDelayMs = 5000;
    this.lifecycleState = 'ACTIVE';
    this.degradedReason = null;
    this.start();
    console.log(`[Gmail Observer Lifecycle] Active: Connected to ${redactSensitiveData(this.credentials.connectedEmail || 'Gmail Account')}`);
    return { success: true, state: 'ACTIVE' };
  }

  loadProcessedIdsFromDisk() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.processedMessageIds = new Set(list);
        }
      }
    } catch {}
  }

  saveProcessedIdsToDisk() {
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storagePath, JSON.stringify(Array.from(this.processedMessageIds)), 'utf8');
    } catch {}
  }

  setCredentials(creds) {
    this.credentials = { ...(this.credentials || {}), ...creds };
  }

  async fetchCredentialsFromPaymentApi() {
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/admin/gmail/credentials`, { headers: { Authorization: `Bearer ${getObserverToken()}` } });
      if (res.ok) {
        const data = await res.json();
        const conf = data.gmailConfig || data;
        if (conf.refreshToken || conf.clientId) {
          this.setCredentials({
            clientId: conf.clientId,
            clientSecret: conf.clientSecret,
            refreshToken: conf.refreshToken,
            connectedEmail: conf.connectedEmail
          });
        }
      }
    } catch {}
  }

  async getAccessToken() {
    if (this.cachedAccessToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedAccessToken;
    }

    if (!this.credentials?.refreshToken || !this.credentials?.clientId || !this.credentials?.clientSecret) {
      await this.fetchCredentialsFromPaymentApi();
    }

    const { clientId, clientSecret, refreshToken } = this.credentials || {};
    if (!clientId || !clientSecret || !refreshToken) {
      console.log('[Gmail Observer] Gmail OAuth2 credentials (clientId, clientSecret, refreshToken) not configured. OAuth setup required.');
      return null;
    }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        }),
        signal: AbortSignal.timeout(8000)
      });

      if (!tokenRes.ok) {
        return null;
      }

      const tokenData = await tokenRes.json();
      this.cachedAccessToken = tokenData.access_token;
      this.tokenExpiresAt = Date.now() + ((tokenData.expires_in || 3500) - 120) * 1000;
      return this.cachedAccessToken;
    } catch (err) {
      console.warn('[Gmail Observer] Failed to refresh Google access token:', redactSensitiveData(err.message));
      return null;
    }
  }

  /**
   * Ingests an email directly (e.g. from webhook, push notification, or manual poll).
   * Fails closed if no receivingAccountId is configured (dynamic account guessing is prohibited).
   * Treats email content as untrusted input with spoofing rejection and duplicate protection.
   * @param {{ subject: string, body: string, date?: string | Date, from?: string, id?: string, messageId?: string }} email
   */
  async processEmail(email) {
    if (!this.receivingAccountId) {
      console.warn('[Gmail Observer] Dropping observation: no receivingAccountId configured (fail-closed, dynamic guessing prohibited)');
      return null;
    }

    const messageId = email.id || email.messageId;
    if (messageId && this.processedMessageIds.has(messageId)) {
      console.log(`[Gmail Observer] Skipping already-processed message ID: ${messageId}`);
      return { accepted: false, duplicate: true, reason: 'MESSAGE_ALREADY_PROCESSED' };
    }

    const sender = email.from || email.sender || 'alerts@retail.bank.in';

    // Treat email as untrusted input: Validate official bank sender domain (Spoof protection)
    if (email.from && !isAuthorizedBankEmailSender(email.from)) {
      console.warn(`[Gmail Observer] Rejected untrusted sender domain: ${redactSensitiveData(sender)} (Spoof protection)`);
      return { accepted: false, rejected: true, reason: 'UNAUTHORIZED_SENDER_DOMAIN' };
    }

    let parsed = null;
    try {
      parsed = BankEmailParser.parse(email);
    } catch {}

    // Malformed or non-credit handling
    if (!parsed || !parsed.amountPaise) {
      console.warn(`[Gmail Observer] Ignoring message from ${redactSensitiveData(sender)}: non-credit or malformed amount.`);
      return { accepted: false, rejected: true, reason: 'MALFORMED_OR_NON_CREDIT' };
    }

    const rawContent = `${email.subject || ''}\n${email.body || ''}`.trim();

    try {
      const result = await this.observerClient.submitObservation({
        receivingAccountId: this.receivingAccountId,
        amountPaise: parsed ? parsed.amountPaise : undefined,
        amount: parsed ? parsed.amount : undefined,
        observedAt: email.date ? new Date(email.date) : new Date(),
        bankReferenceNumber: parsed?.bankReferenceNumber,
        senderVpa: parsed?.senderVpa,
        sender,
        rawText: rawContent,
        rawPayload: {
          messageId: messageId || `gmail_${Date.now()}`,
          subject: email.subject || '',
          body: email.body || '',
          snippet: parsed?.rawSnippet || (email.body || '').substring(0, 200),
          from: sender,
          sender,
          source: 'GMAIL',
          internalDate: email.internalDate || (email.date ? new Date(email.date).getTime() : Date.now())
        }
      });

      if (messageId) {
        this.processedMessageIds.add(messageId);
        if (this.processedMessageIds.size > 1000) {
          const firstKey = this.processedMessageIds.values().next().value;
          this.processedMessageIds.delete(firstKey);
        }
        this.saveProcessedIdsToDisk();
      }

      this.observedCount++;
      return result;
    } catch (err) {
      console.error(`[Gmail Observer] Submission failed: ${redactSensitiveData(err.message)}`);
      throw err;
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lifecycleState = 'ACTIVE';
    this.degradedReason = null;
    console.log(`[Gmail Observer] Poller started (interval: ${this.pollIntervalMs}ms)`);

    // Run first poll cycle immediately
    this.pollCycle().catch(() => {});

    this.timer = setInterval(() => {
      this.pollCycle().catch(() => {});
    }, this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.bootVersion++;
    this.clearBootRetryTimer();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    this._isPolling = false;
    this.nextCatchUpPageToken = null;
    this.lifecycleState = 'STOPPED';
    console.log('[Gmail Observer] Poller stopped.');
  }

  async pollCycle() {
    if (this._isPolling) return;
    this._isPolling = true;

    try {
      this.lastPollAt = new Date();
      const accessToken = await this.getAccessToken();
      if (!accessToken) return;

      // Strict bank transaction alert filter (read-only search)
      const query = encodeURIComponent('from:(bank.in OR hdfcbank.net OR hdfcbank.com OR icicibank.com OR sbi.co.in OR axisbank.com OR kotak.com) OR (credit OR credited OR received OR upi OR deposit OR alert OR update)');

      let pageToken = this.nextCatchUpPageToken || null;
      let pagesFetched = 0;
      let hasMoreCatchUp = false;

      while (pagesFetched < this.maxPagesPerCycle) {
        if (!this.isRunning && this.lifecycleState === 'STOPPED') break;

        let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${this.maxResultsPerPage}&q=${query}`;
        if (pageToken) {
          url += `&pageToken=${encodeURIComponent(pageToken)}`;
        }
        pagesFetched++;

        const listRes = await fetch(url, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(8000)
        });

        if (!listRes.ok) {
          if (listRes.status === 401) {
            this.cachedAccessToken = null;
          }
          if (listRes.status === 400 && pageToken) {
            // Expired or invalid pageToken: reset catchUpPageToken
            this.nextCatchUpPageToken = null;
          }
          break;
        }

        const listData = await listRes.json();
        const messages = listData.messages || [];

        // Track newest message on the first page
        if (!pageToken && messages.length > 0) {
          const currentTopId = messages[0].id;
          const isSameTop = this.lastTopMessageId && this.lastTopMessageId === currentTopId;
          const wasBootLookback = this.lastTopMessageId === null;
          this.lastTopMessageId = currentTopId;

          const unseenOnPage1 = messages.filter(m => !this.processedMessageIds.has(m.id));
          // If top message hasn't changed, all messages on page 1 are seen, and not in boot lookback or ongoing catch-up, stop early
          if (isSameTop && unseenOnPage1.length === 0 && !this.nextCatchUpPageToken && !wasBootLookback) {
            break;
          }
        }

        const unseenMessages = messages.filter(m => !this.processedMessageIds.has(m.id));
        if (unseenMessages.length > 0) {
          await Promise.allSettled(unseenMessages.map(async (m) => {
            try {
              const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
                headers: { 'Authorization': `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(8000)
              });
              if (!msgRes.ok) return;

              const msgData = await msgRes.json();
              const headers = msgData.payload?.headers || [];
              const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
              const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
              const dateStr = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
              const body = extractBodyFromGmailPayload(msgData.payload) || msgData.snippet || '';

              await this.processEmail({
                id: m.id,
                messageId: m.id,
                subject,
                body,
                from,
                date: dateStr ? new Date(dateStr) : new Date(Number(msgData.internalDate || Date.now()))
              });
            } catch (msgErr) {
              console.warn(`[Gmail Observer] Error fetching message:`, redactSensitiveData(msgErr.message));
            }
          }));
        }

        if (listData.nextPageToken) {
          pageToken = listData.nextPageToken;
          hasMoreCatchUp = true;
        } else {
          pageToken = null;
          hasMoreCatchUp = false;
          break;
        }
      }

      this.nextCatchUpPageToken = hasMoreCatchUp ? pageToken : null;
    } catch (err) {
      console.warn('[Gmail Observer] pollCycle error:', redactSensitiveData(err.message));
    } finally {
      this._isPolling = false;
    }
  }
}
