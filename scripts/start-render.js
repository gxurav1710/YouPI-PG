import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Ensure .env is loaded reliably first
try {
  const rootEnv = path.resolve(rootDir, '.env');
  if (fs.existsSync(rootEnv) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(rootEnv);
  }
} catch {}

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.YOUPI_BIND_HOST || '0.0.0.0';

console.log('\n====================================================');
console.log('🚀 Starting YOUPI PG V2 — Unified Cloud Gateway');
console.log('====================================================');

// Ensure data directory exists for SQLite WAL database
const dataDir = path.resolve(rootDir, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 1. Initialize DB migrations and seed
console.log('[1/3] Running database migrations...');
const { getDatabase, ensureDatabaseInitialized, runMigrations } = await import('../packages/db/src/index.js');
const db = getDatabase();
ensureDatabaseInitialized(db);
const { defaultMerchant } = runMigrations(db);
console.log(`[✓] Database ready. Active merchant: ${defaultMerchant?.businessName || 'Default Merchant'}`);

// 2. Initialize all service routers
console.log('[2/3] Initializing unified service engines...');
const { createPaymentApp } = await import('../apps/payment-api/src/index.js');
const { CheckoutServer } = await import('../apps/checkout-portal/src/server.js');
const { AdminServer } = await import('../apps/merchant-admin/src/server.js');
const { CoinWalletStoreServer } = await import('../apps/coin-wallet-store/src/server.js');
const { GmailObserverServer } = await import('../apps/gmail-observer/src/server.js');
const { startControlCenter } = await import('../apps/control-center/src/index.js');
const { getAdminToken } = await import('../packages/common/src/secrets.js');

try {
  await startControlCenter(8090);
  console.log('[✓] Control Center process supervisor started on port 8090');
} catch (e) {
  console.warn('[Control Center] Supervisor note:', e.message);
}

const paymentApp = createPaymentApp(db);

const internalBaseUrl = `http://127.0.0.1:${PORT}`;
const checkout = new CheckoutServer({ apiBaseUrl: internalBaseUrl });
const checkoutServer = checkout.createServer();

const admin = new AdminServer({ apiBaseUrl: internalBaseUrl });
const adminServer = admin.createServer();

let gmailServer = null;
let gmailPoller = null;
try {
  const gmail = new GmailObserverServer({ apiBaseUrl: internalBaseUrl });
  gmailServer = gmail.createServer();
  gmailPoller = gmail.poller;
  await gmail.poller.startBootLifecycle();
  console.log('[✓] Gmail observer and payment email engine initialized');
} catch (e) {
  console.warn('[Gmail Observer] Service note:', e.message);
}

const store = new CoinWalletStoreServer({
  gatewayApiUrl: internalBaseUrl,
  portalBaseUrl: internalBaseUrl
});
const storeServer = store.createServer();

// 3. Create Root HTTP Dispatcher Server
console.log('[3/3] Launching Master HTTP Gateway Server...');
const server = http.createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Malformed request URL' }));
    return;
  }

  // Health check for Render and external monitors
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'UP',
      service: 'youpi-pg-unified',
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // 1. Merchant Admin Hub & Fonts & Control Center Supervisor endpoints
  if (
    pathname === '/admin' ||
    pathname.startsWith('/admin/') ||
    pathname.startsWith('/api/services') ||
    pathname.startsWith('/api/admin/tickets') ||
    pathname === '/api/logs/stream' ||
    pathname.startsWith('/fonts/') ||
    pathname === '/youpi-sms-gateway.apk'
  ) {
    return adminServer.emit('request', req, res);
  }

  // 1b. Gmail Direct Observer & OAuth endpoints
  if (
    gmailServer &&
    (pathname === '/oauth/callback' ||
      pathname === '/oauth/url' ||
      pathname.startsWith('/gmail/') ||
      pathname === '/api/v1/gmail/health')
  ) {
    return gmailServer.emit('request', req, res);
  }

  // 2. Demo Showcase Store, Customer Wallet, Outcome Pages & Store Assets
  if (
    pathname === '/store' ||
    pathname.startsWith('/store/') ||
    pathname === '/wallet' ||
    pathname.startsWith('/wallet/') ||
    pathname.startsWith('/assets/') ||
    pathname === '/css/store.css' ||
    pathname === '/js/store.js' ||
    pathname.startsWith('/order-')
  ) {
    return storeServer.emit('request', req, res);
  }

  // 3. Payment Core REST API (/api/v1/...)
  if (pathname.startsWith('/api/')) {
    return paymentApp.rawServer.emit('request', req, res);
  }

  // 4. Default: Checkout Portal & Universal youpi.js SDK
  return checkoutServer.emit('request', req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`\n====================================================`);
  console.log(`✅ YOUPI PG Unified Gateway is LIVE on port ${PORT}`);
  console.log(`👉 Health:   http://${HOST}:${PORT}/health`);
  console.log(`👉 API:      http://${HOST}:${PORT}/api/v1/...`);
  console.log(`👉 Checkout: http://${HOST}:${PORT}/checkout/...`);
  console.log(`👉 Admin:    http://${HOST}:${PORT}/admin`);
  console.log(`🔑 Admin Token: ${getAdminToken()}`);
  console.log(`👉 Store:    http://${HOST}:${PORT}/store`);
  console.log(`====================================================\n`);
});

