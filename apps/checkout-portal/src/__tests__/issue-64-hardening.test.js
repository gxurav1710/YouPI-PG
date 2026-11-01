import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHelpServer } from '../../../payment-help/src/index.js';
import { startServer as startPaymentApi } from '../../../payment-api/src/index.js';
import { Database, MerchantRepository, PaymentSessionRepository } from '@youpi/db';
import { authHeadersFor } from '../../../../scripts/test-support.js';
import { checkoutFrameHeaders, isProductionLike } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checkoutView = fs.readFileSync(
  path.join(__dirname, '..', 'views', 'checkout.html'),
  'utf8'
);

/**
 * Lifts functions out of the inline checkout script and evaluates them against
 * a sandboxed window/document, so the REAL shipping code is what gets tested.
 */
function liftCheckoutFunctions(...names) {
  const sources = names.map(name => {
    const match = checkoutView.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}`));
    assert.ok(match, `function ${name} not found in checkout.html`);
    return match[0];
  });
  return (window, document) => new Function('window', 'document', `
    ${sources.join('\n')}
    return { ${names.join(', ')} };
  `)(window, document);
}

function sandboxWindow({ referrer = '', search = '' } = {}) {
  const posted = [];
  const window = {
    location: { origin: 'https://portal.test', search },
    parent: {
      postMessage: (msg, origin) => posted.push([msg, origin])
    }
  };
  const document = { referrer };
  return { window, document, posted };
}

describe('Issue #64 hardening: returnUrl, branding sinks, postMessage, framing', () => {
  describe('sanitizeRedirectUrl (live code from checkout.html)', () => {
    const lifted = liftCheckoutFunctions('sanitizeRedirectUrl')(
      { location: { origin: 'https://portal.test' } },
      { referrer: '' }
    );

    test('rejects scheme confusion regardless of casing or padding', () => {
      assert.equal(lifted.sanitizeRedirectUrl('javascript:alert(1)'), null);
      assert.equal(lifted.sanitizeRedirectUrl('  JaVaScRiPt:alert(1)  '), null);
      assert.equal(lifted.sanitizeRedirectUrl('data:text/html,<b>'), null);
      assert.equal(lifted.sanitizeRedirectUrl('vbscript:msgbox'), null);
    });

    test('accepts absolute http(s) and trims whitespace', () => {
      assert.equal(lifted.sanitizeRedirectUrl('  https://store.test/checkout  '), 'https://store.test/checkout');
      assert.equal(lifted.sanitizeRedirectUrl('http://store.test/checkout'), 'http://store.test/checkout');
    });
  });

  describe('postToMerchant / resolveMerchantOrigin (live code from checkout.html)', () => {
    const lifted = liftCheckoutFunctions('resolveMerchantOrigin', 'postToMerchant');

    test('targets the referrer origin', () => {
      const { window, document, posted } = sandboxWindow({ referrer: 'https://store.test/cart' });
      lifted(window, document).postToMerchant({ event: 'youpi.payment_success' });
      assert.equal(posted[0][1], 'https://store.test');
    });

    test('falls back to the origin declared by youpi.js when the referrer is stripped', () => {
      const { window, document, posted } = sandboxWindow({
        search: '?youpiParentOrigin=https%3A%2F%2Fshop.test&embedded=1'
      });
      lifted(window, document).postToMerchant({ event: 'youpi.payment_success' });
      assert.equal(posted[0][1], 'https://shop.test');
    });

    test('drops the message instead of broadcasting when no origin is known', () => {
      const { window, document, posted } = sandboxWindow({});
      lifted(window, document).postToMerchant({ event: 'youpi.payment_success', data: { orderId: 'X' } });
      assert.equal(posted.length, 0);
    });

    test('never resolves a non-http(s) declared origin', () => {
      const { window, document, posted } = sandboxWindow({
        search: '?youpiParentOrigin=javascript%3Aalert(1)'
      });
      lifted(window, document).postToMerchant({ event: 'youpi.payment_success' });
      assert.equal(posted.length, 0);
    });
  });

  describe('checkout.html returnUrl success path', () => {
    test('href and navigation use the sanitized url, never the raw one', () => {
      assert.ok(checkoutView.includes('const safeReturn = sanitizeRedirectUrl(effectiveReturnUrl);'));
      assert.ok(checkoutView.includes('btnReturn.href = safeReturn;'));
      assert.ok(checkoutView.includes('window.location.href = safeReturn;'));
      assert.equal(checkoutView.includes('btnReturn.href = data.returnUrl;'), false);
      assert.equal(checkoutView.includes('window.location.href = data.returnUrl;'), false);
    });

    test('the failed-payment base origin also goes through the sanitiser', () => {
      assert.ok(checkoutView.includes('const safeReturn = sanitizeRedirectUrl(state && state.returnUrl);'));
      assert.equal(
        /baseOrigin = new URL\(state\.returnUrl\)\.origin/.test(checkoutView),
        false,
        'raw state.returnUrl must not be parsed for the failed redirect'
      );
    });
  });

  describe('branding innerHTML sinks', () => {
    test('support contacts are escaped before innerHTML', () => {
      assert.ok(checkoutView.includes("emailBox.innerHTML = `<strong>Email:</strong> ${escapeHtml(info.supportEmails.join(', '))}`;"));
      assert.ok(checkoutView.includes("phoneBox.innerHTML = `<strong>Phone:</strong> ${escapeHtml(info.supportMobiles.join(', '))}`;"));
    });

    test('appName no longer reaches innerHTML unescaped', () => {
      assert.ok(checkoutView.includes('Secured by ${escapeHtml(appName)}'));
      assert.equal(checkoutView.includes('Secured by ${appName}'), false);
    });

    test('legal links accept https only and escape the href', () => {
      assert.ok(checkoutView.includes("if (parsed.protocol !== 'https:') return null;"));
      assert.ok(checkoutView.includes('escapeHtml(privacyUrl)'));
      assert.ok(checkoutView.includes('escapeHtml(termsHref)'));
      assert.equal(checkoutView.includes('href="${branding.privacyPolicyUrl}"'), false);
      assert.equal(checkoutView.includes('href="${branding.termsUrl}"'), false);
    });

    test('safeLegalUrl behaviour', () => {
      const { safeLegalUrl } = liftCheckoutFunctions('safeLegalUrl')({}, { referrer: '' });
      assert.equal(safeLegalUrl('javascript:alert(1)'), null);
      assert.equal(safeLegalUrl('http://store.test/privacy'), null);
      assert.equal(safeLegalUrl('HTTPS://store.test/privacy'), 'https://store.test/privacy');
      assert.equal(safeLegalUrl(''), null);
    });
  });

  describe('checkout frame-ancestors defaults', () => {
    test('production defaults to self-fencing when nothing is configured', () => {
      assert.ok(checkoutFrameHeaders({ NODE_ENV: 'production' })['Content-Security-Policy'].includes("frame-ancestors 'self'"));
      assert.ok(checkoutFrameHeaders({ YOUPI_MODE: 'production', NODE_ENV: 'development' })['Content-Security-Policy'].includes("frame-ancestors 'self'"));
      assert.equal(isProductionLike({ YOUPI_MODE: 'production' }), true);
      assert.equal(isProductionLike({ NODE_ENV: 'test' }), false);
    });

    test('development stays framable so the demo storefront keeps embedding', () => {
      assert.ok(checkoutFrameHeaders({ NODE_ENV: 'development' })['Content-Security-Policy'].includes('frame-ancestors *'));
    });

    test('an explicit allowlist always wins over the environment default', () => {
      const configured = checkoutFrameHeaders({
        NODE_ENV: 'development',
        CHECKOUT_FRAME_ANCESTORS: 'https://shop.example.com'
      });
      assert.ok(configured['Content-Security-Policy'].includes("frame-ancestors 'self' https://shop.example.com"));
    });
  });

  describe('payment-help security headers', () => {
    let helpInstance;
    let helpBaseUrl;

    before(async () => {
      helpInstance = await startHelpServer(7196);
      helpBaseUrl = `http://localhost:${helpInstance.port}`;
    });

    after(async () => {
      await helpInstance.close();
    });

    function get(pathname) {
      return new Promise((resolve, reject) => {
        http.get(`${helpBaseUrl}${pathname}`, res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
        }).on('error', reject);
      });
    }

    test('the help page sends nosniff, referrer policy and a self-fencing CSP', async () => {
      const res = await get('/');
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.ok(res.headers['content-security-policy'].includes("frame-ancestors 'self'"));
    });

    test('unknown routes carry the headers too', async () => {
      const res = await get('/nope');
      assert.equal(res.status, 404);
      assert.ok(res.headers['content-security-policy']);
    });
  });

  describe('payment-api returnUrl validation on write', () => {
    let apiInstance;
    let apiBaseUrl;
    let testDb;
    let merchantId;

    before(async () => {
      process.env.NODE_ENV = 'test';
      process.env.YOUPI_ALLOWED_RETURN_ORIGINS = 'https://store.test';
      testDb = new Database({ inMemory: true });
      apiInstance = await startPaymentApi(6194, testDb);
      apiBaseUrl = `http://localhost:${apiInstance.port}`;
      merchantId = new MerchantRepository(testDb).findAll()[0].id;
    });

    after(async () => {
      await apiInstance.close();
      testDb.close();
    });

    function post(body) {
      return new Promise((resolve, reject) => {
        const url = new URL('/api/v1/payments', apiBaseUrl);
        const req = http.request(url, {
          method: 'POST',
          headers: authHeadersFor('/api/v1/payments', { 'Content-Type': 'application/json', 'X-Merchant-Id': merchantId })
        }, res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch { parsed = data; }
            resolve({ status: res.statusCode, body: parsed });
          });
        });
        req.on('error', reject);
        req.setHeader('Content-Type', 'application/json');
        req.end(JSON.stringify(body));
      });
    }

    test('rejects a javascript: returnUrl', async () => {
      const res = await post({
        orderId: `ISSUE64-${Date.now()}`,
        amount: '100.00',
        returnUrl: 'javascript:alert(1)'
      });
      assert.equal(res.status, 400);
      assert.match(String(res.body.error), /http/);
    });

    test('rejects relative and encoded-scheme returnUrl values', async () => {
      for (const bad of ['/order-done', '  JaVaScRiPt:alert(1)  ', 'data:text/html,<b>']) {
        const res = await post({
          orderId: `ISSUE64-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          amount: '100.00',
          returnUrl: bad
        });
        assert.equal(res.status, 400, `expected 400 for ${bad}`);
      }
    });

    test('accepts https and normalises the stored value', async () => {
      const orderId = `ISSUE64-OK-${Date.now()}`;
      const res = await post({
        orderId,
        amount: '100.00',
        returnUrl: '  https://store.test/success  '
      });
      assert.equal(res.status, 201);
      const stored = new PaymentSessionRepository(testDb).findByOrderId(merchantId, orderId);
      assert.ok(stored, 'session should exist');
      assert.equal(stored.returnUrl, 'https://store.test/success');
    });

    test('rejects unallowlisted and userinfo-bearing return URLs', async () => {
      for (const returnUrl of ['https://elsewhere.test/return', 'https://user@store.test/return']) {
        const res = await post({ orderId: `ISSUE64-BLOCK-${Date.now()}-${Math.random()}`, amount: '100.00', returnUrl });
        assert.equal(res.status, 400);
      }
    });

    test('a missing returnUrl is still allowed', async () => {
      const res = await post({
        orderId: `ISSUE64-NONE-${Date.now()}`,
        amount: '100.00'
      });
      assert.equal(res.status, 201);
    });
  });
});
