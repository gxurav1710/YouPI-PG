import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.resolve(rootDir, 'dist', 'firebase-public');

function copyRecursiveSync(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function compileCheckoutHtml() {
  const checkoutViewsDir = path.resolve(rootDir, 'apps/checkout-portal/src/views');
  const partialsDir = path.join(checkoutViewsDir, 'partials');
  const templatePath = path.join(checkoutViewsDir, 'checkout.html');
  
  if (!fs.existsSync(templatePath)) return;
  let html = fs.readFileSync(templatePath, 'utf8');

  // Replace partials
  html = html.replace(/<!--\s*include:partials\/([a-zA-Z0-9_\-.]+)\s*-->/g, (match, filename) => {
    try {
      const p = path.join(partialsDir, filename);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    } catch {}
    return match;
  });

  // Provide client-side dynamic fallback for template placeholders
  html = html
    .replace(/\{\{MERCHANT_NAME\}\}/g, 'YouPI Demo Merchant')
    .replace(/\{\{APP_NAME\}\}/g, 'YouPI PG')
    .replace(/\{\{INITIAL_STATE_JSON\}\}/g, JSON.stringify({
      status: 'DEMO',
      amountPaise: 49900,
      orderId: 'DEMO-ORDER-1001',
      branding: {
        appName: 'YouPI PG',
        primaryColor: '#0b63e5',
        trustBadgeText: 'YouPI Verified Gateway'
      }
    }))
    .replace(/\{\{PAYMENT_ID\}\}/g, 'demo-payment-session')
    .replace(/\{\{API_BASE_URL\}\}/g, '');

  const destPath = path.join(outDir, 'checkout', 'index.html');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, html, 'utf8');
}

function compileAdminHtml() {
  const adminPath = path.resolve(rootDir, 'apps/merchant-admin/src/views/admin.html');
  if (!fs.existsSync(adminPath)) return;
  let html = fs.readFileSync(adminPath, 'utf8');
  html = html.replace(/\{\{APP_NAME\}\}/g, 'YouPI PG');
  
  const destPath = path.join(outDir, 'admin', 'index.html');
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, html, 'utf8');
}

function generatePortalIndexHtml() {
  const portalHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouPI PG V2 — Sovereign UPI Payment Gateway</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <script src="/youpi.js" data-youpi-key="00000000-0000-0000-0000-000000000001"></script>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(18, 24, 38, 0.85);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #3b82f6;
      --primary-glow: rgba(59, 130, 246, 0.35);
      --accent: #10b981;
      --accent-glow: rgba(16, 185, 129, 0.25);
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% -20%, #1e293b 0%, var(--bg) 60%);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2.5rem 1.5rem;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      font-size: 0.8rem;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.12);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      margin-bottom: 1.5rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge-dot {
      width: 8px;
      height: 8px;
      background: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 8px #10b981;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.85); }
    }
    h1 {
      font-size: clamp(2.2rem, 5vw, 3.5rem);
      font-weight: 800;
      text-align: center;
      letter-spacing: -0.03em;
      line-height: 1.15;
      margin-bottom: 1rem;
      background: linear-gradient(135deg, #ffffff 30%, #93c5fd 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    p.lead {
      font-size: 1.15rem;
      color: var(--text-muted);
      text-align: center;
      max-width: 680px;
      line-height: 1.6;
      margin-bottom: 3rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.5rem;
      width: 100%;
      max-width: 1100px;
      margin-bottom: 3.5rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 1.25rem;
      padding: 1.75rem;
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      backdrop-filter: blur(12px);
      position: relative;
      overflow: hidden;
    }
    .card:hover {
      transform: translateY(-4px);
      border-color: rgba(59, 130, 246, 0.4);
      box-shadow: 0 12px 30px -10px var(--primary-glow);
    }
    .card-icon {
      font-size: 2.25rem;
      margin-bottom: 1.25rem;
      display: inline-block;
    }
    .card-title {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      color: #fff;
    }
    .card-desc {
      font-size: 0.925rem;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 1.5rem;
      flex-grow: 1;
    }
    .card-action {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.9rem;
      font-weight: 600;
      color: #60a5fa;
    }
    .banner {
      width: 100%;
      max-width: 1100px;
      background: linear-gradient(135deg, rgba(30, 58, 138, 0.4), rgba(15, 23, 42, 0.6));
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 1.25rem;
      padding: 2rem;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 1.5rem;
      margin-bottom: 3.5rem;
    }
    .banner-text h3 {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }
    .banner-text p {
      color: var(--text-muted);
      font-size: 0.95rem;
    }
    .btn {
      padding: 0.75rem 1.5rem;
      border-radius: 0.75rem;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }
    .btn-primary {
      background: #2563eb;
      color: #fff;
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.4);
    }
    .btn-primary:hover {
      background: #1d4ed8;
      transform: scale(1.02);
    }
    .sdk-snippet {
      width: 100%;
      max-width: 1100px;
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid var(--card-border);
      border-radius: 1.25rem;
      padding: 1.75rem;
      margin-bottom: 3rem;
    }
    .sdk-title {
      font-size: 1rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
      color: #93c5fd;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    pre {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.875rem;
      color: #e2e8f0;
      background: #020617;
      padding: 1rem;
      border-radius: 0.75rem;
      overflow-x: auto;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    footer {
      margin-top: auto;
      color: var(--text-muted);
      font-size: 0.85rem;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="badge">
    <span class="badge-dot"></span>
    Live Cloud Engine Connected &bull; https://youpi-pg-cdnt.onrender.com
  </div>

  <h1>YOUPI PG V2</h1>
  <p class="lead">Sovereign, self-hosted, 0% platform fee UPI payment gateway suite with cryptographic banking observation and single-slot FIFO queue architecture.</p>

  <div class="grid">
    <a href="https://youpi-pg-cdnt.onrender.com/store" target="_blank" class="card">
      <span class="card-icon">🛒</span>
      <div class="card-title">Coin Wallet Store Demo</div>
      <div class="card-desc">Experience the full customer purchase journey, universal one-button payment modal, and real-time payment states.</div>
      <div class="card-action">Launch Live Store &rarr;</div>
    </a>

    <a href="https://youpi-pg-cdnt.onrender.com/checkout/" target="_blank" class="card">
      <span class="card-icon">⚡</span>
      <div class="card-title">Dynamic Checkout Portal</div>
      <div class="card-desc">Zero-JS dynamic ISO vector UPI QR code generation, WhatsApp OTP verification modal, and dual decoupled timers.</div>
      <div class="card-action">Open Live Checkout &rarr;</div>
    </a>

    <a href="https://youpi-pg-cdnt.onrender.com/admin" target="_blank" class="card">
      <span class="card-icon">🛡️</span>
      <div class="card-title">Merchant Admin Hub</div>
      <div class="card-desc">Live VPA slot status, cashier till dock, white-label customizer, observer telemetry, and manual transaction review. (Token: <code>admin123456</code>)</div>
      <div class="card-action">Open Live Admin &rarr;</div>
    </a>

    <a href="https://youpi-pg-cdnt.onrender.com/openapi.yaml" target="_blank" class="card">
      <span class="card-icon">⚙️</span>
      <div class="card-title">OpenAPI V3 Specification</div>
      <div class="card-desc">Inspect standard REST endpoints, signed HMAC-SHA256 webhook contracts, observer schemas, and status polling specs.</div>
      <div class="card-action">View Schema &rarr;</div>
    </a>
  </div>

  <div class="banner">
    <div class="banner-text">
      <h3>📱 Android SMS Banking Observer</h3>
      <p>Download the background listener APK for automated bank SMS verification & UTR extraction from the repository source (<code>apps/android-observer-app/</code>).</p>
    </div>
    <a href="https://github.com/sacacommittee/YouPI-PG" target="_blank" class="btn btn-primary">
      <span>📦</span> View APK in Repo
    </a>
  </div>

  <div class="sdk-snippet">
    <div class="sdk-title">
      <span>📦</span> One-Script Universal Storefront Integration
    </div>
    <pre><code>&lt;!-- 1. Include YOUPI Gateway Script --&gt;
&lt;script src="https://saca-a3ae1.web.app/youpi.js" data-youpi-key="YOUR_MERCHANT_KEY"&gt;&lt;/script&gt;

&lt;!-- 2. Zero-JS Instant Payment Button --&gt;
&lt;button data-youpi-pay data-order-id="ORDER-1001" data-amount="499" data-currency="INR"&gt;
  Pay with UPI
&lt;/button&gt;</code></pre>
  </div>

  <footer>
    YOUPI PG V2 &bull; Node.js Native &bull; Hosted on Firebase &bull; Sovereign & Zero Fees
  </footer>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, 'index.html'), portalHtml, 'utf8');
}

console.log('🚀 Assembling Firebase Public Distribution...');

// 1. Clean and recreate output directory
if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(outDir, { recursive: true });

// 2. Copy SDK files to root
copyRecursiveSync(path.resolve(rootDir, 'apps/checkout-portal/src/sdk/youpi.js'), path.join(outDir, 'youpi.js'));
copyRecursiveSync(path.resolve(rootDir, 'apps/checkout-portal/src/sdk/youpi-checkout.js'), path.join(outDir, 'youpi-checkout.js'));

// 3. Copy Checkout Portal public assets (css, js, icons)
copyRecursiveSync(path.resolve(rootDir, 'apps/checkout-portal/public/css'), path.join(outDir, 'css'));
copyRecursiveSync(path.resolve(rootDir, 'apps/checkout-portal/public/js'), path.join(outDir, 'js'));
copyRecursiveSync(path.resolve(rootDir, 'apps/checkout-portal/public/icons'), path.join(outDir, 'icons'));

// 4. Compile Checkout Portal HTML
compileCheckoutHtml();

// 5. Copy Coin Wallet Store assets and HTML
copyRecursiveSync(path.resolve(rootDir, 'apps/coin-wallet-store/public/css/store.css'), path.join(outDir, 'css/store.css'));
copyRecursiveSync(path.resolve(rootDir, 'apps/coin-wallet-store/public/js/store.js'), path.join(outDir, 'js/store.js'));
copyRecursiveSync(path.resolve(rootDir, 'apps/coin-wallet-store/public/assets'), path.join(outDir, 'assets'));
copyRecursiveSync(path.resolve(rootDir, 'apps/coin-wallet-store/src/store.html'), path.join(outDir, 'store/index.html'));
copyRecursiveSync(path.resolve(rootDir, 'apps/coin-wallet-store/src/wallet.html'), path.join(outDir, 'wallet/index.html'));

// Copy store outcome pages
const outcomePages = ['order-success.html', 'order-failed.html', 'order-expired.html', 'order-cancelled.html', 'order-suspicious.html'];
for (const p of outcomePages) {
  const src = path.resolve(rootDir, 'apps/coin-wallet-store/src', p);
  if (fs.existsSync(src)) {
    copyRecursiveSync(src, path.join(outDir, 'store', p));
  }
}

// 6. Compile Admin HTML and copy admin public assets (fonts)
compileAdminHtml();
copyRecursiveSync(path.resolve(rootDir, 'apps/merchant-admin/public/fonts'), path.join(outDir, 'fonts'));

// 7. Copy OpenAPI spec
copyRecursiveSync(path.resolve(rootDir, 'openapi.yaml'), path.join(outDir, 'openapi.yaml'));

// 8. Generate top-level index.html
generatePortalIndexHtml();

console.log('✅ Firebase Public Distribution assembled successfully at: dist/firebase-public');

