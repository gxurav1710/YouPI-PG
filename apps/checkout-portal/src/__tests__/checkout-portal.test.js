import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startCheckoutServer } from '../index.js';
import { generateQrMatrix, generateQrSvg } from '@youpi/core';
import { CheckoutServer, frameAncestorOrigins } from '../server.js';

describe('Checkout Portal Integration Tests', () => {
  let serverInstance;
  let baseUrl;

  before(async () => {
    // Start on high test port (7199)
    serverInstance = await startCheckoutServer(7199);
    baseUrl = `http://localhost:${serverInstance.port}`;
  });

  after(async () => {
    await serverInstance.close();
  });

  function get(path) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, text: data });
        });
      }).on('error', reject);
    });
  }

  describe('QR Generator', () => {
    test('generateQrMatrix creates 29x29 matrix with finder patterns', () => {
      const matrix = generateQrMatrix('upi://pay?pa=store@upi&am=200.00');
      assert.equal(matrix.length, 29);
      assert.equal(matrix[0].length, 29);

      // Verify top-left finder pattern corner
      assert.equal(matrix[0][0], 1);
      assert.equal(matrix[0][6], 1);
      assert.equal(matrix[6][0], 1);
      assert.equal(matrix[6][6], 1);
    });

    test('generateQrSvg creates clean, valid SVG markup', () => {
      const svg = generateQrSvg('upi://pay?pa=merchant@upi&am=500.00', 240);
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
      assert.ok(svg.includes('viewBox="0 0 240 240"'));
      assert.ok(svg.endsWith('</svg>'));
    });
  });

  describe('HTTP Endpoints', () => {
    test('GET /health returns UP', async () => {
      const res = await get('/health');
      assert.equal(res.status, 200);
      const json = JSON.parse(res.text);
      assert.equal(json.status, 'UP');
      assert.equal(json.service, 'checkout-portal');
    });

    test('GET /checkout/:id renders responsive HTML with injected payment ID', async () => {
      const testPaymentId = 'pay_test_uuid_12345';
      const res = await get(`/checkout/${testPaymentId}`);
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));

      assert.ok(res.text.includes('<!DOCTYPE html>'));
      assert.ok(res.text.includes('name="viewport"'));
      assert.ok(res.text.includes('PAYMENT_ID = "pay_test_uuid_12345"'));
      assert.ok(res.text.includes('id="preGatewayAuthView"'));
      assert.ok(res.text.includes('id="paymentGatewayInterface"'));
      assert.ok(res.text.includes('id="authMobileInput"'));
      assert.ok(res.text.includes('id="btnAuthContinue"'));
      assert.ok(res.text.includes('WhatsApp Mobile Number'));
      assert.ok(res.text.includes('id="authStepSignup"'));
      assert.ok(res.text.includes('id="authStepOtp"'));

      // INVARIANT: Zero UPI Offer artifacts
      assert.equal(res.text.includes('6 Offers'), false);
      assert.equal(res.text.includes('View Offers'), false);
      assert.equal(res.text.includes('id="checkoutNoticeText"'), false);
      assert.equal(res.text.includes('available-offers-card'), false);
    });

    test('GET /checkout/:id framing is controlled by CHECKOUT_FRAME_ANCESTORS', async () => {
      // No allowlist configured: the checkout page stays framable by any origin, because
      // merchant storefronts embed it cross-origin. Deployments can pin the allowlist.
      const before = await get('/checkout/pay_test_uuid_12345');
      assert.equal(before.headers['x-frame-options'], undefined);
      assert.ok(before.headers['content-security-policy'].includes('frame-ancestors *;'));

      process.env.CHECKOUT_FRAME_ANCESTORS = 'https://shop.example.com, javascript:alert(1) https://x.test/path *';
      try {
        const res = await get('/checkout/pay_test_uuid_12345');
        assert.equal(res.headers['x-frame-options'], undefined);
        assert.ok(res.headers['content-security-policy'].includes("frame-ancestors 'self' https://shop.example.com;"));
        // The QR image stays unframeable.
        const qr = await get('/checkout/pay_test_uuid_12345/qr.svg');
        assert.equal(qr.headers['x-frame-options'], 'SAMEORIGIN');
      } finally {
        delete process.env.CHECKOUT_FRAME_ANCESTORS;
      }
      assert.deepEqual(frameAncestorOrigins('https://a.test http://localhost:5000/'), ['https://a.test', 'http://localhost:5000']);
      // Entries that are not a bare http(s) origin are rejected outright, so the value can
      // never widen the CSP or inject another directive.
      assert.deepEqual(frameAncestorOrigins('javascript:alert(1)'), []);
      assert.deepEqual(frameAncestorOrigins('https://x.test/path'), []);
      assert.deepEqual(frameAncestorOrigins('*'), []);
      assert.deepEqual(frameAncestorOrigins('https://user:pass@x.test'), []);
    });

    test('GET /checkout/:id/qr.svg returns dynamic SVG image', async () => {
      const res = await get('/checkout/pay_test_uuid_12345/qr.svg');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('image/svg+xml'));
      assert.ok(res.text.includes('<svg'));
      assert.ok(res.text.includes('</svg>'));
    });

    test('GET /icons/:filename returns official Play Store icons with correct MIME type', async () => {
      const res = await get('/icons/gpay.png');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('image/png'));
      assert.ok(res.text.length > 500);

      const resPhonePe = await get('/icons/phonepe.png');
      assert.equal(resPhonePe.status, 200);
      assert.ok(resPhonePe.headers['content-type'].includes('image/png'));
    });

    test('GET /youpi.js and /sdk/youpi-checkout.js return official integration SDK with CORS', async () => {
      const resYoupi = await get('/youpi.js');
      assert.equal(resYoupi.status, 200);
      assert.ok(resYoupi.headers['content-type'].includes('application/javascript'));
      assert.equal(resYoupi.headers['access-control-allow-origin'], '*');
      assert.ok(resYoupi.text.includes('YoupiCheckout'));
      assert.ok(resYoupi.text.includes('data-youpi-pay'));
      assert.ok(resYoupi.text.includes('youpi:payment:success'));

      const resLegacy = await get('/sdk/youpi-checkout.js');
      assert.equal(resLegacy.status, 200);
      assert.ok(resLegacy.headers['content-type'].includes('application/javascript'));
      assert.equal(resLegacy.headers['access-control-allow-origin'], '*');
      assert.ok(resLegacy.text.includes('YoupiCheckout'));
    });

    test('GET /checkout/:id includes PC 2-column sidebar, UPI Server indicator, and NO visual UPI ID in summary', async () => {
      const res = await get('/checkout/pay_test_uuid_12345');
      assert.equal(res.status, 200);

      // Verify PC Redesign sidebar & header exists
      assert.ok(res.text.includes('ypg-pc-sidebar'));
      assert.ok(res.text.includes('id="pcMerchantName"'));
      assert.ok(res.text.includes('id="pcPriceSummaryAmount"'));
      assert.ok(res.text.includes('ypg-pc-topbar'));

      // Verify UPI Server indicator
      assert.ok(res.text.includes('id="upiServerHealthIndicator"'));
      assert.ok(res.text.includes('id="serverStatusLabel"'));
      assert.ok(res.text.includes('id="serverDowntimeAlert"'));

      // Verify Play Store icons are referenced and interactive
      assert.ok(res.text.includes('/icons/gpay.png'));
      assert.ok(res.text.includes('/icons/phonepe.png'));
      assert.ok(res.text.includes('/icons/paytm.png'));
      assert.ok(res.text.includes('handleUpiAppClick'));
      assert.ok(res.text.includes('id="btnMobileUpiIntent"'));

      // DOM hierarchy invariant: No redundant nested <div class="ypg-body">
      assert.equal(res.text.includes('<div class="ypg-body">'), false);
      assert.ok(res.text.includes('<main class="ypg-body">'));

      // INVARIANT: Raw Payee VPA / UPI ID row is REMOVED from Order Summary
      assert.equal(res.text.includes('id="drawerVpa"'), false);
    });

    test('GET /css/checkout.css returns the static stylesheet with CORS and responsive modal rules', async () => {
      const resCss = await get('/css/checkout.css');
      assert.equal(resCss.status, 200);
      assert.ok(resCss.headers['content-type'].includes('text/css'));
      assert.ok(resCss.text.includes('.ypg-wrapper'));
      assert.ok(resCss.text.includes('.ypg-btn-upi-mobile-intent'));
      assert.ok(resCss.text.includes('.ypg-sticky-footer'));
    });

    test('the checkout page loads exactly one copy of the client script', async () => {
      const res = await get('/checkout/pay_test_uuid_12345');
      assert.equal(res.status, 200);

      // The client script lives inline, in the rendered page. A second copy
      // used to be loaded from /js/checkout.js, and two classic scripts that
      // both declare `let state` at global scope are a syntax error: the
      // second one never runs, and the page throws "Identifier 'state' has
      // already been declared" on every single load.
      assert.equal(res.text.includes('/js/checkout.js'), false);
      assert.equal(res.text.includes('src="/js/'), false);

      // The live copy is the inline one, and it is the hardened one — the
      // redirect and postMessage guards live here.
      assert.ok(res.text.includes('STORAGE_KEY_IDENTITY'));
      assert.ok(res.text.includes('sanitizeRedirectUrl'));
    });


    test('GET /stand renders interactive Smart Payment Stand view', async () => {
      const res = await get('/stand?name=Acme+Store&vpa=acme@ybl&mobile=9876543210');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
      assert.ok(res.text.includes('Acme Store'));
      assert.ok(res.text.includes('acme@ybl'));
      assert.ok(res.text.includes('+91 98765 43210'));
      assert.ok(res.text.includes('Smart Payment Stand'));
      assert.ok(res.text.includes('Point Phone Camera to Pay'));
    });

    test('GET /stand/print renders printable physical stand studio', async () => {
      const res = await get('/stand/print?name=Sharma+Sweets&vpa=sharma@ybl&mobile=9812345678');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/html'));
      assert.ok(res.text.includes('Sharma Sweets'));
      assert.ok(res.text.includes('sharma@ybl'));
      assert.ok(res.text.includes('window.print()'));
      assert.ok(res.text.includes('@media print'));
    });

    test('GET /stand/qr.svg returns dynamic stand QR SVG image', async () => {
      const res = await get('/stand/qr.svg?amount=3500.00&vpa=test@upi');
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'image/svg+xml');
      assert.ok(res.text.startsWith('<svg'));
      assert.ok(res.text.endsWith('</svg>'));
    });

    test('renders dynamic branding when DEFAULT_APP_NAME or merchant branding is configured', async () => {
      const origEnv = { ...process.env };
      process.env.DEFAULT_APP_NAME = 'CustomPay Gateway';
      process.env.DEFAULT_PRIMARY_COLOR = '#0ea5e9';

      const portalServer = new CheckoutServer();
      const html = portalServer.renderHtml('pay_123', {
        merchantName: 'My Super Store',
        amount: '299.00'
      });

      assert.ok(html.includes('CustomPay Gateway Checkout'));
      assert.ok(html.includes('CustomPay Gateway Verified Business'));
      assert.ok(html.includes('200+ orders verified this month by CustomPay Gateway'));
      assert.ok(html.includes('CustomPay Gateway Help &amp; Support'));

      process.env = { ...origEnv };
    });

    test('GET /checkout/:id has balanced DOM structure so ypgStickyFooter stays inside ypg-pc-workspace (Issue #90)', async () => {
      const res = await get('/checkout/pay_test_uuid_12345');
      assert.equal(res.status, 200);

      // Must NOT have a duplicate <div class="ypg-body"> wrapper around <main class="ypg-body">
      assert.equal(res.text.includes('<div class="ypg-body">'), false, 'checkout.html must not wrap partials in a duplicate <div class="ypg-body">');
      assert.ok(res.text.includes('<main class="ypg-body">'), 'header partial must open <main class="ypg-body">');

      // Verify ypgStickyFooter is closed BEFORE END ypg-pc-workspace, and there are balanced <div> / </div> tags inside ypg-pc-workspace
      const wsStart = res.text.indexOf('<div class="ypg-pc-workspace">');
      const footerIdx = res.text.indexOf('id="ypgStickyFooter"');
      const wsEnd = res.text.indexOf('<!-- END ypg-pc-workspace -->');
      assert.ok(wsStart > 0 && footerIdx > wsStart && wsEnd > footerIdx, 'ypgStickyFooter must sit inside ypg-pc-workspace');

      const workspaceSlice = res.text.slice(wsStart, wsEnd);
      const openDivs = (workspaceSlice.match(/<div\b/g) || []).length;
      const closeDivs = (workspaceSlice.match(/<\/div>/g) || []).length;
      assert.equal(openDivs, closeDivs, `ypg-pc-workspace must have balanced <div> (${openDivs}) and </div> (${closeDivs}) tags so ypgStickyFooter is not ejected as a 3rd flex column on macOS/iOS`);
    });
  });
});

