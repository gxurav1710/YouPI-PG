import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCloudflaredInvocation,
  safeEqual,
  toPaise,
  toRupeesString,
  formatINR,
  encrypt,
  decrypt,
  generateHmac,
  verifyHmac,
  hashPassword,
  verifyPassword,
  isValidVpa,
  buildUpiUri,
  buildUpiIntentUri,
  buildStandUpiUri,
  UPI_PROVIDERS,
  getUpiProviders,
  findUpiProviderByPackage,
  findUpiProviderById,
  ALLOWED_NOTIFICATION_PACKAGES,
  isAllowedNotificationPackage,
  calculateObservationFingerprint,
  resolveDefaultBranding
} from '../index.js';

describe('@youpi/common Unit Tests', () => {
  describe('Money and Currency Utilities', () => {
    test('converts valid rupee strings and numbers to integer paise', () => {
      assert.equal(toPaise('200.00'), 20000n);
      assert.equal(toPaise('200'), 20000n);
      assert.equal(toPaise(200), 20000n);
      assert.equal(toPaise('0.50'), 50n);
      assert.equal(toPaise('0.05'), 5n);
      assert.equal(toPaise('199.99'), 19999n);
    });

    test('rejects negative, zero, and malformed currency inputs', () => {
      assert.throws(() => toPaise('0.00'), /greater than 0/);
      assert.throws(() => toPaise('-50.00'), /Invalid INR rupee format/);
      assert.throws(() => toPaise('12.345'), /Invalid INR rupee format/);
      assert.throws(() => toPaise('abc'), /Invalid INR rupee format/);
      assert.throws(() => toPaise(NaN), /Invalid monetary amount/);
    });

    test('formats paise into standard decimal string and INR symbol', () => {
      assert.equal(toRupeesString(20000n), '200.00');
      assert.equal(toRupeesString(50n), '0.50');
      assert.equal(toRupeesString(5n), '0.05');
      assert.equal(formatINR(20000n), '₹200.00');
      assert.equal(formatINR(19999n), '₹199.99');
    });
  });

  describe('Cryptographic Helpers', () => {
    const testMasterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

    test('encrypts and decrypts with AES-256-GCM successfully', () => {
      const original = 'super-secret-oauth-token-12345';
      const encrypted = encrypt(original, testMasterKey);
      assert.notEqual(encrypted, original);
      assert.equal(encrypted.split(':').length, 3);

      const decrypted = decrypt(encrypted, testMasterKey);
      assert.equal(decrypted, original);
    });

    test('fails decryption if ciphertext or auth tag is tampered', () => {
      const encrypted = encrypt('sensitive data', testMasterKey);
      const parts = encrypted.split(':');
      const tampered = `${parts[0]}:${parts[1]}:${parts[2]}ab`;
      assert.throws(() => decrypt(tampered, testMasterKey));
    });

    test('generates and verifies HMAC-SHA256 signatures with timing safety', () => {
      const secret = 'merchant_webhook_secret_xyz';
      const payload = JSON.stringify({ event: 'SUCCESS', paymentId: 'p123' });
      const signature = generateHmac(payload, secret);

      assert.equal(verifyHmac(payload, secret, signature), true);
      assert.equal(verifyHmac(payload, 'wrong_secret', signature), false);
      assert.equal(verifyHmac('altered payload', secret, signature), false);
    });

    test('hashes and verifies passwords securely', () => {
      const pass = 'CorrectHorseBatteryStaple!42';
      const hash = hashPassword(pass);
      assert.ok(hash.startsWith('100000:'));

      assert.equal(verifyPassword(pass, hash), true);
      assert.equal(verifyPassword('WrongPassword', hash), false);
    });
  });

  describe('UPI Utilities', () => {
    test('validates UPI VPAs correctly', () => {
      assert.equal(isValidVpa('merchant@icici'), true);
      assert.equal(isValidVpa('user.name-12@okhdfcbank'), true);
      assert.equal(isValidVpa('invalid-vpa-no-bank'), false);
      assert.equal(isValidVpa('@bank'), false);
      assert.equal(isValidVpa(''), false);
    });

    test('builds canonical upi://pay URI dynamically with server amount', () => {
      const uri = buildUpiUri({
        payeeVpa: 'store@upi',
        payeeName: 'Acme Store',
        amountPaise: 20000n,
        transactionRef: 'ORDER-99',
        transactionNote: 'Order payment'
      });

      assert.ok(uri.startsWith('upi://pay?'));
      const parsed = new URL(uri);
      assert.equal(parsed.searchParams.get('pa'), 'store@upi');
      assert.equal(parsed.searchParams.get('pn'), 'Acme Store');
      assert.equal(parsed.searchParams.get('am'), '200.00');
      assert.equal(parsed.searchParams.get('tn'), 'ORDER-99');
      assert.equal(parsed.searchParams.get('tr'), null);
      // Verify no extra noisy parameters
      assert.equal(parsed.searchParams.get('cu'), null);
      assert.deepEqual([...parsed.searchParams.keys()], ['pa', 'pn', 'am', 'tn']);
    });

    test('strictly excludes cu, tr and all extra parameters even when currency option is passed', () => {
      const uri = buildUpiUri({
        payeeVpa: '9876543210@axl',
        payeeName: 'Demo Store Merchant',
        amountPaise: 100n,
        transactionRef: 'ORDER-123',
        currency: 'INR'
      });

      assert.ok(uri.startsWith('upi://pay?'));
      const parsed = new URL(uri);
      assert.equal(parsed.searchParams.get('pa'), '9876543210@axl');
      assert.equal(parsed.searchParams.get('pn'), 'Demo Store Merchant');
      assert.equal(parsed.searchParams.get('am'), '1.00');
      assert.equal(parsed.searchParams.get('tn'), 'ORDER-123');
      // Strictly verify NO cu, NO tr, NO extra parameters
      assert.equal(parsed.searchParams.get('cu'), null);
      assert.equal(parsed.searchParams.get('tr'), null);
      assert.deepEqual([...parsed.searchParams.keys()], ['pa', 'pn', 'am', 'tn']);
    });

    test('builds valid Android intent URI containing only canonical UPI parameters', () => {
      const intentUri = buildUpiIntentUri({
        payeeVpa: '9876543210@axl',
        payeeName: 'Demo Store Merchant',
        amountPaise: 100n,
        transactionRef: 'ORDER-123',
        currency: 'INR',
        packageName: 'com.phonepe.app'
      });

      assert.ok(intentUri.startsWith('intent://pay?'));
      assert.ok(intentUri.includes('package=com.phonepe.app'));
      assert.ok(intentUri.includes('scheme=upi'));
      assert.ok(intentUri.endsWith('#Intent;scheme=upi;package=com.phonepe.app;end'));
      // Underlying query payload inside intent must not have cu or tr
      const queryPart = intentUri.split('#')[0].replace('intent://pay?', '');
      const queryParams = new URLSearchParams(queryPart);
      assert.equal(queryParams.get('cu'), null);
      assert.equal(queryParams.get('tr'), null);
      assert.deepEqual([...queryParams.keys()], ['pa', 'pn', 'am', 'tn']);
    });


    test('builds authentic NPCI-compliant stand UPI URI with mode and currency', () => {
      // 1. Static physical QR stand (camera scan, open amount)
      const staticUri = buildStandUpiUri({
        payeeVpa: 'customer@ybl',
        payeeName: 'Sharma Sweets',
        merchantCategoryCode: '5411',
        mode: '02'
      });
      assert.ok(staticUri.startsWith('upi://pay?'));
      const parsedStatic = new URL(staticUri);
      assert.equal(parsedStatic.searchParams.get('pa'), 'customer@ybl');
      assert.equal(parsedStatic.searchParams.get('pn'), 'Sharma Sweets');
      assert.equal(parsedStatic.searchParams.get('mc'), '5411');
      assert.equal(parsedStatic.searchParams.get('mode'), '02');
      assert.equal(parsedStatic.searchParams.get('cu'), 'INR');
      assert.equal(parsedStatic.searchParams.get('am'), null);

      // 2. Dynamic counter stand (with amount > ₹2000)
      const dynamicUri = buildStandUpiUri({
        payeeVpa: 'customer@ybl',
        payeeName: 'Sharma Sweets',
        amountPaise: 350000n,
        merchantCategoryCode: '5411',
        mode: '04',
        transactionNote: 'BILL-445'
      });
      const parsedDyn = new URL(dynamicUri);
      assert.equal(parsedDyn.searchParams.get('am'), '3500.00');
      assert.equal(parsedDyn.searchParams.get('mode'), '04');
      assert.equal(parsedDyn.searchParams.get('tn'), 'BILL-445');
    });
    test('validates 30 official UPI application provider registry', () => {
      const providers = getUpiProviders();
      assert.equal(providers.length, 30, 'Must have exactly 30 registered UPI providers');

      // Verify Google Pay, PhonePe, Paytm packages
      const gpay = findUpiProviderByPackage('com.google.android.apps.nbu.paisa.user');
      assert.ok(gpay);
      assert.equal(gpay.name, 'Google Pay');
      assert.ok(gpay.iconUrl.includes('play-lh.googleusercontent.com'));
      assert.ok(gpay.svgLogo.includes('<svg'));

      const phonepe = findUpiProviderById('phonepe');
      assert.ok(phonepe);
      assert.equal(phonepe.packageName, 'com.phonepe.app');

      const paytm = findUpiProviderById('paytm');
      assert.ok(paytm);
      assert.equal(paytm.packageName, 'net.one97.paytm');

      // Verify all 30 providers have unique packages, names, and logos
      const packages = new Set();
      for (const p of providers) {
        assert.ok(p.id, `Provider must have an id`);
        assert.ok(p.name, `Provider must have a name`);
        assert.ok(p.packageName, `Provider ${p.name} must have a packageName`);
        assert.ok(p.iconUrl, `Provider ${p.name} must have an iconUrl`);
        assert.ok(p.svgLogo, `Provider ${p.name} must have an svgLogo`);
        assert.ok(!packages.has(p.packageName), `Duplicate package name: ${p.packageName}`);
        packages.add(p.packageName);
      }
    });

    test('validates unified ALLOWED_NOTIFICATION_PACKAGES and isAllowedNotificationPackage', () => {
      assert.ok(Array.isArray(ALLOWED_NOTIFICATION_PACKAGES));
      assert.ok(ALLOWED_NOTIFICATION_PACKAGES.length >= 38);

      // Verify essential UPI and banking packages are included
      assert.equal(isAllowedNotificationPackage('com.phonepe.app'), true);
      assert.equal(isAllowedNotificationPackage('com.google.android.apps.nbu.paisa.user'), true);
      assert.equal(isAllowedNotificationPackage('net.one97.paytm'), true);
      assert.equal(isAllowedNotificationPackage('com.google.android.apps.messaging'), true);
      assert.equal(isAllowedNotificationPackage('com.sbi.lotusintouch'), true);

      // Case-insensitivity and trim handling
      assert.equal(isAllowedNotificationPackage('  COM.PHONEPE.APP  '), true);

      // Rejects spoofed or unlisted apps
      assert.equal(isAllowedNotificationPackage('com.attacker.fake.app'), false);
      assert.equal(isAllowedNotificationPackage(''), false);
      assert.equal(isAllowedNotificationPackage(null), false);
      assert.equal(isAllowedNotificationPackage(undefined), false);
    });
  });

  describe('Observation Fingerprinting', () => {
    test('generates consistent fingerprints with bank reference numbers', () => {
      const fp1 = calculateObservationFingerprint({
        receivingAccountId: 'acc_1',
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR12345678',
        observedAt: new Date('2026-09-08T10:00:00Z')
      });

      const fp2 = calculateObservationFingerprint({
        receivingAccountId: 'acc_1',
        amountPaise: 20000n,
        bankReferenceNumber: 'UTR12345678',
        observedAt: new Date('2026-09-08T10:02:00Z')
      });

      assert.equal(fp1, fp2);
    });

    test('generates cluster fingerprints within same 60-second window when no reference', () => {
      const fp1 = calculateObservationFingerprint({
        receivingAccountId: 'acc_1',
        amountPaise: 20000n,
        observedAt: new Date('2026-09-08T10:00:10Z')
      });

      const fp2 = calculateObservationFingerprint({
        receivingAccountId: 'acc_1',
        amountPaise: 20000n,
        observedAt: new Date('2026-09-08T10:00:45Z')
      });

      assert.equal(fp1, fp2);

      const fpDiffTime = calculateObservationFingerprint({
        receivingAccountId: 'acc_1',
        amountPaise: 20000n,
        observedAt: new Date('2026-09-08T10:05:00Z')
      });

      assert.notEqual(fp1, fpDiffTime);
    });
  });
});

describe('buildCloudflaredInvocation', () => {
  const token = 'eyJhIjoiMDEyMzQ1Njc4OSIsInQiOiJhYmNkZWYifQ==';

  test('extracts the token from pasted cloudflared commands and never returns the pasted text', () => {
    for (const cmd of [
      `cloudflared.exe service install ${token}`,
      `cloudflared tunnel run --token ${token}`,
      token
    ]) {
      const inv = buildCloudflaredInvocation(cmd);
      assert.equal(inv.file, 'cloudflared');
      assert.deepEqual(inv.args, ['tunnel', '--no-autoupdate', 'run', '--token', token]);
      assert.ok(!inv.redacted.includes(token));
    }
  });

  test('rejects commands without a token, including shell payloads', () => {
    assert.throws(() => buildCloudflaredInvocation(''), /empty/);
    assert.throws(() => buildCloudflaredInvocation('calc.exe & whoami'), /No valid Cloudflare tunnel token/);
    assert.throws(() => buildCloudflaredInvocation('curl http://x | sh'), /No valid Cloudflare tunnel token/);
  });
});

describe('safeEqual', () => {
  test('compares strings in constant time and rejects non-strings', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual(undefined, 'abc'), false);
  });
});

describe('resolveDefaultBranding', () => {
  const origEnv = { ...process.env };

  test('resolves default platform branding when env is unset', () => {
    delete process.env.DEFAULT_APP_NAME;
    delete process.env.DEFAULT_PRIMARY_COLOR;
    delete process.env.DEFAULT_SUPPORT_EMAIL;
    delete process.env.DEFAULT_SUPPORT_PHONE;
    delete process.env.DEFAULT_LOGO_URL;
    delete process.env.DEFAULT_TRUST_BADGE_TEXT;
    delete process.env.DEFAULT_FOOTER_GUARANTEE;

    const b = resolveDefaultBranding();
    assert.equal(b.appName, 'YOUPI PG');
    assert.equal(b.primaryColor, '#2563eb');
    assert.equal(b.supportEmail, 'support@youpi.local');
    assert.equal(b.supportPhone, '9876543210');
    assert.equal(b.logoUrl, null);
    assert.equal(b.trustBadgeText, 'YOUPI PG Verified Business');
    assert.equal(b.footerGuarantee, '100% Payment Protection by YOUPI PG');
  });

  test('honors environment variable overrides', () => {
    process.env.DEFAULT_APP_NAME = 'ApexPay';
    process.env.DEFAULT_PRIMARY_COLOR = '#10b981';
    process.env.DEFAULT_SUPPORT_EMAIL = 'help@apexpay.com';
    process.env.DEFAULT_SUPPORT_PHONE = '9999888877';
    process.env.DEFAULT_LOGO_URL = 'https://apexpay.com/logo.png';
    process.env.DEFAULT_TRUST_BADGE_TEXT = 'Apex Certified';
    process.env.DEFAULT_FOOTER_GUARANTEE = 'Protected by ApexPay';

    const b = resolveDefaultBranding();
    assert.equal(b.appName, 'ApexPay');
    assert.equal(b.primaryColor, '#10b981');
    assert.equal(b.supportEmail, 'help@apexpay.com');
    assert.equal(b.supportPhone, '9999888877');
    assert.equal(b.logoUrl, 'https://apexpay.com/logo.png');
    assert.equal(b.trustBadgeText, 'Apex Certified');
    assert.equal(b.footerGuarantee, 'Protected by ApexPay');

    // Restore environment
    process.env = { ...origEnv };
  });

  test('gives explicit caller overrides highest priority over env', () => {
    process.env.DEFAULT_APP_NAME = 'ApexPay';

    const b = resolveDefaultBranding({ appName: 'MerchantBrand' });
    assert.equal(b.appName, 'MerchantBrand');
    assert.equal(b.trustBadgeText, 'MerchantBrand Verified Business');
    assert.equal(b.footerGuarantee, '100% Payment Protection by MerchantBrand');

    // Restore environment
    process.env = { ...origEnv };
  });
});
