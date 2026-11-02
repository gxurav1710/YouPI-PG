import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GmailPoller } from '../gmail-poller.js';

function createTempDir(prefix = 'youpi-pages-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Issue #104: bounded pagination discovers alert on page two across multiple pages', async () => {
  const dir = createTempDir();
  const originalFetch = globalThis.fetch;
  const submitted = [];
  const pageTokens = [];

  const poller = new GmailPoller({
    receivingAccountId: 'synthetic-account',
    storagePath: path.join(dir, 'ids.json'),
    maxPagesPerCycle: 3
  });
  poller.getAccessToken = async () => 'synthetic-token';
  poller.observerClient.submitObservation = async (data) => {
    submitted.push(data.rawPayload.messageId);
    return { accepted: true };
  };

  globalThis.fetch = async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://gmail.googleapis.com');
    if (url.pathname.endsWith('/messages')) {
      const token = url.searchParams.get('pageToken');
      pageTokens.push(token);
      return Response.json(token
        ? { messages: [{ id: 'alert-11' }] }
        : {
            messages: Array.from({ length: 10 }, (_, i) => ({ id: `alert-${i + 1}` })),
            nextPageToken: 'page-two'
          });
    }
    return Response.json({
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'alerts@hdfcbank.net' },
          { name: 'Subject', value: 'Credit alert' }
        ],
        body: {
          data: Buffer.from('Dear customer, Rs 150.00 credited to your account. UTR: 778899001122').toString('base64url')
        }
      }
    });
  };

  try {
    await poller.pollCycle();
    await poller.pollCycle();
    await poller.pollCycle();

    assert.equal(pageTokens.includes('page-two'), true, 'Should fetch page 2 with pageToken=page-two');
    assert.equal(submitted.length, 11, 'Should discover and submit all 11 messages');
    assert.ok(submitted.includes('alert-11'), 'Should submit alert-11 from page 2');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Issue #104: downtime recovery discovers page two when page one was already processed on disk', async () => {
  const dir = createTempDir();
  const originalFetch = globalThis.fetch;
  const storagePath = path.join(dir, 'ids.json');

  // Pre-populate disk with first 10 alerts already processed before restart
  const preProcessed = Array.from({ length: 10 }, (_, i) => `alert-${i + 1}`);
  fs.writeFileSync(storagePath, JSON.stringify(preProcessed));

  const poller = new GmailPoller({
    receivingAccountId: 'synthetic-account',
    storagePath,
    maxPagesPerCycle: 3
  });
  poller.getAccessToken = async () => 'synthetic-token';
  const submitted = [];
  const pageTokens = [];

  poller.observerClient.submitObservation = async (data) => {
    submitted.push(data.rawPayload.messageId);
    return { accepted: true };
  };

  globalThis.fetch = async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://gmail.googleapis.com');
    if (url.pathname.endsWith('/messages')) {
      const token = url.searchParams.get('pageToken');
      pageTokens.push(token);
      return Response.json(token
        ? { messages: [{ id: 'alert-11' }] }
        : {
            messages: Array.from({ length: 10 }, (_, i) => ({ id: `alert-${i + 1}` })),
            nextPageToken: 'page-two'
          });
    }
    return Response.json({
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'alerts@hdfcbank.net' },
          { name: 'Subject', value: 'Credit alert' }
        ],
        body: {
          data: Buffer.from('Dear customer, Rs 200.00 credited to your account. UTR: 889900112233').toString('base64url')
        }
      }
    });
  };

  try {
    await poller.pollCycle();

    assert.equal(pageTokens.includes('page-two'), true, 'Should inspect page 2 on initial lookback');
    assert.equal(submitted.length, 1, 'Should only submit the unseen alert-11');
    assert.equal(submitted[0], 'alert-11');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Issue #104: idle polling does not re-fetch page two when top message and page one are unchanged', async () => {
  const dir = createTempDir();
  const originalFetch = globalThis.fetch;
  let pageTwoFetchCount = 0;

  const poller = new GmailPoller({
    receivingAccountId: 'synthetic-account',
    storagePath: path.join(dir, 'ids.json'),
    maxPagesPerCycle: 3
  });
  poller.getAccessToken = async () => 'synthetic-token';
  poller.observerClient.submitObservation = async () => ({ accepted: true });

  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/messages')) {
      const token = url.searchParams.get('pageToken');
      if (token === 'page-two') pageTwoFetchCount++;
      return Response.json(token
        ? { messages: [{ id: 'alert-11' }] }
        : {
            messages: Array.from({ length: 10 }, (_, i) => ({ id: `alert-${i + 1}` })),
            nextPageToken: 'page-two'
          });
    }
    return Response.json({
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'From', value: 'alerts@hdfcbank.net' }, { name: 'Subject', value: 'Credit' }],
        body: { data: Buffer.from('Rs 100.00 credited UTR: 112233445566').toString('base64url') }
      }
    });
  };

  try {
    // Cycle 1: discovers alert-1..10 and alert-11 on page-two
    await poller.pollCycle();
    assert.equal(pageTwoFetchCount, 1);

    // Cycle 2: everything is caught up, top message unchanged -> stops early on page 1
    await poller.pollCycle();
    assert.equal(pageTwoFetchCount, 1, 'Should not re-fetch page 2 when idle');

    // Cycle 3: still idle
    await poller.pollCycle();
    assert.equal(pageTwoFetchCount, 1, 'Should not re-fetch page 2 on subsequent idle cycles');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Issue #104: multi-cycle catch-up respects maxPagesPerCycle budget', async () => {
  const dir = createTempDir();
  const originalFetch = globalThis.fetch;
  const pageFetches = [];

  const poller = new GmailPoller({
    receivingAccountId: 'synthetic-account',
    storagePath: path.join(dir, 'ids.json'),
    maxPagesPerCycle: 2 // budget: only 2 pages per cycle
  });
  poller.getAccessToken = async () => 'synthetic-token';
  poller.observerClient.submitObservation = async () => ({ accepted: true });

  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/messages')) {
      const token = url.searchParams.get('pageToken');
      pageFetches.push(token);
      if (!token) {
        return Response.json({
          messages: [{ id: 'p1-1' }],
          nextPageToken: 'page-2'
        });
      }
      if (token === 'page-2') {
        return Response.json({
          messages: [{ id: 'p2-1' }],
          nextPageToken: 'page-3'
        });
      }
      if (token === 'page-3') {
        return Response.json({
          messages: [{ id: 'p3-1' }]
        });
      }
    }
    return Response.json({
      internalDate: String(Date.now()),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'From', value: 'alerts@hdfcbank.net' }, { name: 'Subject', value: 'Credit' }],
        body: { data: Buffer.from('Rs 100.00 credited UTR: 112233445566').toString('base64url') }
      }
    });
  };

  try {
    // Cycle 1: fetches page 1 and page 2 (hitting maxPagesPerCycle = 2)
    await poller.pollCycle();
    assert.deepEqual(pageFetches, [null, 'page-2']);
    assert.equal(poller.nextCatchUpPageToken, 'page-3');

    // Cycle 2: continues catch-up to page 3
    await poller.pollCycle();
    assert.deepEqual(pageFetches, [null, 'page-2', 'page-3']);
    assert.equal(poller.nextCatchUpPageToken, null, 'Catch-up finished');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

