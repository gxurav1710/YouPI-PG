import { buildStandUpiUri, isValidVpa } from '@youpi/common';
import { QrCode } from './qr.js';

/**
 * Escapes text for XML/SVG safety.
 * @param {string} str
 * @returns {string}
 */
function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Formats a 10-digit Indian mobile number with readable spacing (+91 XXXXX XXXXX).
 * @param {string} mobile
 * @returns {string}
 */
export function formatIndianMobile(mobile) {
  if (!mobile) return '';
  const digits = String(mobile).replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  if (last10.length === 10) {
    return `+91 ${last10.slice(0, 5)} ${last10.slice(5)}`;
  }
  return mobile;
}

/**
 * Generates an SVG string representing the QR matrix modules.
 * @param {string} upiUri
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {string} color
 * @returns {string}
 */
function renderQrMatrixSvg(upiUri, x, y, size, color = '#1a1a1a') {
  const matrix = QrCode.encode(upiUri, 'M');
  const numModules = matrix.length;
  const moduleSize = size / numModules;

  let rects = '';
  for (let r = 0; r < numModules; r++) {
    for (let c = 0; c < numModules; c++) {
      if (matrix[r][c] === 1) {
        const mx = (x + c * moduleSize).toFixed(2);
        const my = (y + r * moduleSize).toFixed(2);
        const s = (moduleSize + 0.05).toFixed(2);
        rects += `<rect x="${mx}" y="${my}" width="${s}" height="${s}" fill="${color}" />\n`;
      }
    }
  }
  return rects;
}

/**
 * Generates an authentic, high-resolution vector SVG for a customized physical payment stand.
 *
 * Designed specifically for:
 * - Countertop Acrylic T-Stands & Table Tents (4" x 6" / 1200 x 1800 px)
 * - Large Counter Displays (5" x 7" / 1500 x 2100 px)
 * - Compact POS Till Badges & Stickers (3.5" x 3.5" / 1050 x 1050 px)
 * - Festive Themes (Diwali Festival Crackers Standee with Diyas & Firework Glows)
 *
 * @param {{
 *   businessName: string,
 *   payeeVpa: string,
 *   phonePeMobile: string,
 *   payeeName?: string,
 *   primaryColor?: string,
 *   accentColor?: string,
 *   amountPaise?: bigint | null,
 *   merchantCategoryCode?: string,
 *   tagline?: string,
 *   noticeText?: string,
 *   theme?: 'standard' | 'diwali',
 *   poweredBy?: string,
 *   format?: 'table-tent' | 'counter-stand' | 'desk-badge'
 * }} options
 * @returns {string} Stand SVG markup
 */
export function generateStandSvg(options) {
  if (!isValidVpa(options.payeeVpa)) {
    throw new Error(`Invalid payee VPA: ${options.payeeVpa}`);
  }

  const businessName = (options.businessName || 'Merchant Store').trim();
  const payeeVpa = options.payeeVpa.trim();
  const phonePeMobile = formatIndianMobile(options.phonePeMobile || '');
  const payeeName = (options.payeeName || businessName).trim();
  const primaryColor = options.primaryColor || '#5f259f'; // PhonePe Royal Purple signature
  const accentColor = options.accentColor || '#00baf2'; // Paytm Cyan / UPI Vibrant Blue
  const format = options.format || 'table-tent';
  const tagline = (options.tagline || 'Scan & Pay with Any UPI App').trim();
  const theme = options.theme || (businessName.toLowerCase().includes('cracker') || businessName.toLowerCase().includes('diwali') ? 'diwali' : 'standard');
  const poweredBy = (options.poweredBy || '').trim();

  // Build NPCI compliant UPI URI for physical stand (mode=02 static or mode=04 dynamic)
  const upiUri = buildStandUpiUri({
    payeeVpa,
    payeeName,
    merchantCategoryCode: options.merchantCategoryCode || '5411',
    mode: options.amountPaise ? '04' : '02',
    amountPaise: options.amountPaise || null,
    currency: 'INR'
  });

  if (format === 'desk-badge') {
    // 1050 x 1050 px Square Desk Badge / Counter Sticker
    const qrSize = 580;
    const qrX = (1050 - qrSize) / 2;
    const qrY = 260;
    const qrRects = renderQrMatrixSvg(upiUri, qrX, qrY, qrSize, '#0f172a');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1050 1050" width="1050" height="1050">
  <defs>
    <linearGradient id="badgeHeaderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${primaryColor}"/>
      <stop offset="100%" stop-color="#3b156b"/>
    </linearGradient>
    <filter id="badgeShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="6" stdDeviation="12" flood-opacity="0.15"/>
    </filter>
  </defs>

  <!-- Background Base -->
  <rect width="1050" height="1050" rx="36" fill="#f8fafc" stroke="#e2e8f0" stroke-width="3"/>

  <!-- Top Header Banner -->
  <path d="M 0,36 Q 0,0 36,0 L 1014,0 Q 1050,0 1050,36 L 1050,200 L 0,200 Z" fill="url(#badgeHeaderGrad)" />

  <!-- Business Name & Verified Shield -->
  <g transform="translate(525, 75)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="44" font-weight="800" fill="#ffffff" letter-spacing="0.5">${escapeXml(businessName)}</text>
  </g>
  <g transform="translate(525, 125)">
    <rect x="-180" y="-18" width="360" height="36" rx="18" fill="rgba(255,255,255,0.18)" />
    <text text-anchor="middle" y="7" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="20" font-weight="600" fill="#ffffff">✓ VERIFIED MERCHANT STAND</text>
  </g>
  <g transform="translate(525, 175)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="22" font-weight="500" fill="#e2e8f0">${escapeXml(tagline)}</text>
  </g>

  <!-- QR Card Container -->
  <rect x="${qrX - 30}" y="${qrY - 30}" width="${qrSize + 60}" height="${qrSize + 60}" rx="28" fill="#ffffff" filter="url(#badgeShadow)" stroke="#cbd5e1" stroke-width="2"/>

  <!-- Scannable ISO QR Modules -->
  ${qrRects}

  <!-- Center PhonePe & UPI Emblem -->
  <circle cx="525" cy="${qrY + qrSize / 2}" r="38" fill="#ffffff" stroke="${primaryColor}" stroke-width="4"/>
  <text x="525" y="${qrY + qrSize / 2 + 8}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="24" font-weight="900" fill="${primaryColor}">पे</text>

  <!-- Footer Information -->
  <rect x="75" y="880" width="900" height="120" rx="20" fill="#ffffff" stroke="#e2e8f0" stroke-width="2"/>
  <text x="525" y="925" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="800" fill="#0f172a">UPI ID: ${escapeXml(payeeVpa)}</text>
  ${phonePeMobile ? `<text x="525" y="965" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="700" fill="${primaryColor}">PhonePe: ${escapeXml(phonePeMobile)}</text>` : ''}
  ${poweredBy ? `<text x="525" y="1020" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="700" fill="#64748b">Powered by ${escapeXml(poweredBy)}</text>` : ''}
</svg>`;
  }

  // DIWALI FESTIVAL SPECIAL STANDEE (4" x 6" at 300 DPI: 1200 x 1800 px)
  const nameParts = businessName.split(/\s*-\s*/);
  const stallTitle = nameParts[0];
  const stallSubtitle = nameParts.length > 1 ? `- ${nameParts.slice(1).join(' - ')} -` : '';

  if (theme === 'diwali') {
    const qrSize = 660;
    const qrX = (1200 - qrSize) / 2;
    const qrY = 510;
    const qrRects = renderQrMatrixSvg(upiUri, qrX, qrY, qrSize, '#090d16');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1800" width="1200" height="1800">
  <defs>
    <!-- Royal Diwali Background Gradient -->
    <linearGradient id="diwaliBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#120224"/>
      <stop offset="35%" stop-color="#2a064a"/>
      <stop offset="70%" stop-color="#460a6b"/>
      <stop offset="100%" stop-color="#1a0230"/>
    </linearGradient>

    <!-- Rich Festive Gold Gradient -->
    <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#fff275"/>
      <stop offset="30%" stop-color="#ffb703"/>
      <stop offset="70%" stop-color="#fb8500"/>
      <stop offset="100%" stop-color="#ffb703"/>
    </linearGradient>

    <!-- Diya Brass Lamp Gradient -->
    <linearGradient id="diyaBrass" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffe494"/>
      <stop offset="50%" stop-color="#d4af37"/>
      <stop offset="100%" stop-color="#8c6d1f"/>
    </linearGradient>

    <!-- Diya Flame Gradient -->
    <radialGradient id="flameGrad" cx="50%" cy="70%" r="60%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="30%" stop-color="#ffea00"/>
      <stop offset="70%" stop-color="#ff6d00"/>
      <stop offset="100%" stop-color="#d50000"/>
    </radialGradient>

    <!-- Flame Ambient Glow Filter -->
    <filter id="flameGlow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="8" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>

    <filter id="goldDropShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#ffb703" flood-opacity="0.5"/>
    </filter>

    <filter id="standCardShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="12" stdDeviation="24" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
  </defs>

  <!-- Deep Festive Canvas Base -->
  <rect width="1200" height="1800" fill="url(#diwaliBg)"/>

  <!-- Decorative Festive Toran & Garland Border Pattern -->
  <g opacity="0.35">
    <circle cx="150" cy="180" r="120" fill="none" stroke="#ffb703" stroke-width="1.5" stroke-dasharray="6,6"/>
    <circle cx="1050" cy="180" r="120" fill="none" stroke="#ffb703" stroke-width="1.5" stroke-dasharray="6,6"/>
    <circle cx="600" cy="900" r="540" fill="none" stroke="#ffd166" stroke-width="1" stroke-dasharray="8,8"/>
  </g>

  <!-- Top Sparkling Cracker Bursts -->
  <g fill="#ffd166" opacity="0.85">
    <!-- Starburst Left -->
    <path d="M 120,80 L 125,95 L 140,100 L 125,105 L 120,120 L 115,105 L 100,100 L 115,95 Z"/>
    <circle cx="90" cy="70" r="3" fill="#ffb703"/>
    <circle cx="150" cy="65" r="2.5" fill="#ffffff"/>
    <circle cx="140" cy="135" r="3" fill="#ffb703"/>

    <!-- Starburst Right -->
    <path d="M 1080,80 L 1085,95 L 1100,100 L 1085,105 L 1080,120 L 1075,105 L 1060,100 L 1075,95 Z"/>
    <circle cx="1110" cy="70" r="3" fill="#ffb703"/>
    <circle cx="1050" cy="65" r="2.5" fill="#ffffff"/>
    <circle cx="1060" cy="135" r="3" fill="#ffb703"/>
  </g>

  <!-- Traditional Golden Diyas (Left & Right of Title) -->
  <!-- Left Diya -->
  <g transform="translate(140, 240)">
    <ellipse cx="0" cy="25" rx="42" ry="14" fill="url(#diyaBrass)" stroke="#ffe494" stroke-width="1.5"/>
    <path d="M -42,25 C -42,50 42,50 42,25 Z" fill="url(#diyaBrass)"/>
    <ellipse cx="0" cy="22" rx="30" ry="8" fill="#5c440a"/>
    <!-- Glowing Flame -->
    <path d="M 0,22 C -16,5 -14,-25 0,-45 C 14,-25 16,5 0,22 Z" fill="url(#flameGrad)" filter="url(#flameGlow)"/>
  </g>

  <!-- Right Diya -->
  <g transform="translate(1060, 240)">
    <ellipse cx="0" cy="25" rx="42" ry="14" fill="url(#diyaBrass)" stroke="#ffe494" stroke-width="1.5"/>
    <path d="M -42,25 C -42,50 42,50 42,25 Z" fill="url(#diyaBrass)"/>
    <ellipse cx="0" cy="22" rx="30" ry="8" fill="#5c440a"/>
    <!-- Glowing Flame -->
    <path d="M 0,22 C -16,5 -14,-25 0,-45 C 14,-25 16,5 0,22 Z" fill="url(#flameGrad)" filter="url(#flameGlow)"/>
  </g>

  <!-- Festival Tagline -->
  <g transform="translate(600, 95)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="26" font-weight="800" fill="#ffd166" letter-spacing="3">🪔 HAPPY DIWALI • FESTIVAL SPECIAL 🪔</text>
  </g>

  <!-- Main Business Stall Title -->
  <g transform="translate(600, 175)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="58" font-weight="900" fill="url(#goldGrad)" filter="url(#goldDropShadow)" letter-spacing="1.5">${escapeXml(stallTitle)}</text>
    ${stallSubtitle ? `<text y="42" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="800" fill="#ffd166" letter-spacing="3">${escapeXml(stallSubtitle)}</text>` : ''}
  </g>

  <g transform="translate(600, 255)">
    <rect x="-240" y="-22" width="480" height="44" rx="22" fill="rgba(255,183,3,0.18)" stroke="#ffb703" stroke-width="1.5"/>
    <circle cx="-190" cy="0" r="10" fill="#00e676"/>
    <text text-anchor="middle" x="12" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="800" fill="#ffffff">OFFICIAL FESTIVAL CRACKERS STAND</text>
  </g>

  <g transform="translate(600, 325)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="700" fill="#f8fafc">Payee: <tspan fill="#ffd166">${escapeXml(payeeName)}</tspan></text>
  </g>
  <g transform="translate(600, 368)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="21" font-weight="600" fill="#cbd5e1">Scan with any UPI app to buy crackers with zero delays</text>
  </g>

  <!-- Decorative Gold Banner Frame around QR -->
  <rect x="${qrX - 45}" y="${qrY - 45}" width="${qrSize + 90}" height="${qrSize + 90}" rx="32" fill="#ffffff" filter="url(#standCardShadow)" stroke="#fbbf24" stroke-width="4"/>

  <!-- Camera Guidance Banner above QR -->
  <rect x="${qrX - 25}" y="${qrY - 26}" width="${qrSize + 50}" height="42" rx="10" fill="#fffbeb" stroke="#fde68a" stroke-width="1"/>
  <text x="600" y="${qrY + 3}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#b45309">📷 POINT PHONE CAMERA AT QR CODE TO PAY</text>

  <!-- Authentic 2D Binary Vector QR Modules -->
  <g transform="translate(0, 16)">
    ${qrRects}
  </g>

  <!-- Center PhonePe & UPI Emblem -->
  <circle cx="600" cy="${qrY + qrSize / 2 + 16}" r="48" fill="#ffffff" stroke="${primaryColor}" stroke-width="5"/>
  <text x="600" y="${qrY + qrSize / 2 + 27}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="32" font-weight="900" fill="${primaryColor}">पे</text>

  <!-- Live Scan Notice Pill (Highlighting Acceptance > ₹2000) -->
  <g transform="translate(600, 1285)">
    <rect x="-490" y="-32" width="980" height="64" rx="32" fill="#ecfdf5" stroke="#34d399" stroke-width="2.5" />
    <text text-anchor="middle" y="10" font-family="system-ui, -apple-system, sans-serif" font-size="24" font-weight="800" fill="#065f46">✨ Camera Scan Accepts All Amounts Above ₹2,000 (No Gallery Limit)</text>
  </g>

  <!-- Supported UPI Apps Ribbon -->
  <g transform="translate(600, 1375)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="800" fill="#ffd166" letter-spacing="1.5">ACCEPTED ON ALL MAJOR UPI APPS</text>
  </g>

  <g transform="translate(600, 1430)">
    <g transform="translate(-360, 0)">
      <rect x="-85" y="-22" width="170" height="44" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <text text-anchor="middle" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#5f259f">PhonePe</text>
    </g>
    <g transform="translate(-180, 0)">
      <rect x="-85" y="-22" width="170" height="44" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <text text-anchor="middle" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#1a73e8">Google Pay</text>
    </g>
    <g transform="translate(0, 0)">
      <rect x="-85" y="-22" width="170" height="44" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <text text-anchor="middle" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#00baf2">Paytm</text>
    </g>
    <g transform="translate(180, 0)">
      <rect x="-85" y="-22" width="170" height="44" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <text text-anchor="middle" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#00838f">BHIM UPI</text>
    </g>
    <g transform="translate(360, 0)">
      <rect x="-85" y="-22" width="170" height="44" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <text text-anchor="middle" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#111827">CRED</text>
    </g>
  </g>

  <!-- Merchant Identity Card with VPA & PhonePe Mobile -->
  <g transform="translate(600, 1575)">
    <rect x="-490" y="-70" width="980" height="140" rx="24" fill="#ffffff" stroke="#fbbf24" stroke-width="2.5" filter="url(#standCardShadow)"/>
    <text text-anchor="middle" y="-20" font-family="system-ui, -apple-system, sans-serif" font-size="36" font-weight="900" fill="#0f172a">UPI ID: <tspan fill="#5f259f">${escapeXml(payeeVpa)}</tspan></text>
    ${phonePeMobile ? `<text text-anchor="middle" y="32" font-family="system-ui, -apple-system, sans-serif" font-size="30" font-weight="800" fill="#059669">PhonePe Registered: ${escapeXml(phonePeMobile)}</text>` : ''}
  </g>

  <!-- Powered By MOMO IT TECHNOLOGIES Branding Ribbon -->
  <g transform="translate(600, 1720)">
    <rect x="-350" y="-28" width="700" height="56" rx="28" fill="rgba(0,0,0,0.5)" stroke="#ffb703" stroke-width="2" />
    <text text-anchor="middle" y="9" font-family="system-ui, -apple-system, sans-serif" font-size="23" font-weight="800" fill="#ffd166" letter-spacing="1">⚡ POWERED BY ${escapeXml(poweredBy || 'MOMO IT TECHNOLOGIES')}</text>
  </g>
</svg>`;
  }

  // STANDARD TABLE-TENT (4" x 6" at 300 DPI: 1200 x 1800 px) & COUNTER-STAND
  const qrSize = 680;
  const qrX = (1200 - qrSize) / 2;
  const qrY = 480;
  const qrRects = renderQrMatrixSvg(upiUri, qrX, qrY, qrSize, '#090d16');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1800" width="1200" height="1800">
  <defs>
    <linearGradient id="standGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${primaryColor}"/>
      <stop offset="50%" stop-color="#4a157e"/>
      <stop offset="100%" stop-color="#2a0845"/>
    </linearGradient>
    <linearGradient id="accentStripe" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#00baf2"/>
      <stop offset="50%" stop-color="#00e676"/>
      <stop offset="100%" stop-color="#ffb300"/>
    </linearGradient>
    <filter id="standCardShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="10" stdDeviation="20" flood-opacity="0.18"/>
    </filter>
  </defs>

  <!-- Clean Canvas Background -->
  <rect width="1200" height="1800" fill="#f8fafc"/>

  <!-- Top Hero Header -->
  <path d="M 0,0 L 1200,0 L 1200,380 L 0,430 Z" fill="url(#standGrad)" />
  <rect x="0" y="420" width="1200" height="12" fill="url(#accentStripe)" />

  <!-- Business Details in Header -->
  <g transform="translate(600, 110)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="52" font-weight="900" fill="#ffffff" letter-spacing="0.5">${escapeXml(businessName)}</text>
  </g>
  <g transform="translate(600, 175)">
    <rect x="-220" y="-22" width="440" height="44" rx="22" fill="rgba(255,255,255,0.18)" />
    <circle cx="-180" cy="0" r="10" fill="#00e676"/>
    <text text-anchor="middle" x="12" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="700" fill="#ffffff">OFFICIAL PAYMENT STAND</text>
  </g>
  <g transform="translate(600, 250)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="500" fill="#e2e8f0">${escapeXml(tagline)}</text>
  </g>
  <g transform="translate(600, 310)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="600" fill="#cbd5e1">Payee Name: ${escapeXml(payeeName)}</text>
  </g>

  <!-- QR Box Container Surface -->
  <rect x="${qrX - 45}" y="${qrY - 40}" width="${qrSize + 90}" height="${qrSize + 90}" rx="36" fill="#ffffff" filter="url(#standCardShadow)" stroke="#e2e8f0" stroke-width="3"/>

  <!-- Camera Guidance Banner above QR -->
  <rect x="${qrX - 25}" y="${qrY - 24}" width="${qrSize + 50}" height="42" rx="12" fill="#eff6ff" />
  <text x="600" y="${qrY + 5}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="700" fill="#1d4ed8">📷 POINT PHONE CAMERA AT QR CODE TO PAY</text>

  <!-- Authentic 2D Binary Vector QR Modules -->
  <g transform="translate(0, 16)">
    ${qrRects}
  </g>

  <!-- Center Brand Pin -->
  <circle cx="600" cy="${qrY + qrSize / 2 + 16}" r="48" fill="#ffffff" stroke="${primaryColor}" stroke-width="5"/>
  <text x="600" y="${qrY + qrSize / 2 + 27}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="32" font-weight="900" fill="${primaryColor}">पे</text>

  <!-- Live Scan Notice Pill (Highlighting Acceptance > ₹2000) -->
  <g transform="translate(600, 1250)">
    <rect x="-480" y="-32" width="960" height="64" rx="32" fill="#ecfdf5" stroke="#a7f3d0" stroke-width="2" />
    <text text-anchor="middle" y="10" font-family="system-ui, -apple-system, sans-serif" font-size="23" font-weight="700" fill="#065f46">✨ Camera Scan Accepts Payments Above ₹2,000 (No Gallery Limit)</text>
  </g>

  <!-- Payment Network Ribbon (PhonePe, GPay, Paytm, BHIM, CRED) -->
  <g transform="translate(600, 1345)">
    <text text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="700" fill="#64748b" letter-spacing="1.2">ACCEPTED ON ALL MAJOR UPI APPS</text>
  </g>

  <g transform="translate(600, 1400)">
    <g transform="translate(-360, 0)">
      <rect x="-85" y="-22" width="170" height="44" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <text text-anchor="middle" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#5f259f">PhonePe</text>
    </g>
    <g transform="translate(-180, 0)">
      <rect x="-85" y="-22" width="170" height="44" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <text text-anchor="middle" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#1a73e8">Google Pay</text>
    </g>
    <g transform="translate(0, 0)">
      <rect x="-85" y="-22" width="170" height="44" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <text text-anchor="middle" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#00baf2">Paytm</text>
    </g>
    <g transform="translate(180, 0)">
      <rect x="-85" y="-22" width="170" height="44" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <text text-anchor="middle" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#00838f">BHIM UPI</text>
    </g>
    <g transform="translate(360, 0)">
      <rect x="-85" y="-22" width="170" height="44" rx="22" fill="#ffffff" stroke="#cbd5e1" stroke-width="1.5"/>
      <text text-anchor="middle" y="8" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="800" fill="#111827">CRED</text>
    </g>
  </g>

  <!-- Merchant Identity Card with VPA & PhonePe Mobile -->
  <g transform="translate(600, 1550)">
    <rect x="-480" y="-75" width="960" height="150" rx="24" fill="#ffffff" stroke="#e2e8f0" stroke-width="2" filter="url(#standCardShadow)"/>
    <text text-anchor="middle" y="-24" font-family="system-ui, -apple-system, sans-serif" font-size="34" font-weight="800" fill="#0f172a">UPI ID: ${escapeXml(payeeVpa)}</text>
    ${phonePeMobile ? `<text text-anchor="middle" y="32" font-family="system-ui, -apple-system, sans-serif" font-size="28" font-weight="700" fill="${primaryColor}">PhonePe Number: ${escapeXml(phonePeMobile)}</text>` : ''}
    <text text-anchor="middle" y="60" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="500" fill="#94a3b8">Instant banking observation via YouPI PG Network</text>
  </g>

  <!-- Footer Bottom Bar -->
  <g transform="translate(600, 1720)">
    ${poweredBy ? `<text text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="800" fill="#475569">⚡ Powered by ${escapeXml(poweredBy)}</text>` : '<text text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="20" font-weight="600" fill="#64748b">Direct Bank Settlement • 0% Transaction Fees • Sovereign Self-Hosted Gateway</text>'}
  </g>
</svg>`;
}

/**
 * Generates an authentic, print-calibrated HTML document for direct browser printing (`window.print()`).
 * Formatted with CSS `@page` for exact 4" x 6" / 5" x 7" acrylic stand holders.
 *
 * @param {Parameters<typeof generateStandSvg>[0]} options
 * @returns {string} Stand HTML markup
 */
export function generateStandHtml(options) {
  const svgMarkup = generateStandSvg(options);
  const businessName = escapeXml(options.businessName || 'Merchant Payment Stand');
  const primaryColor = options.primaryColor || '#5f259f';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment QR Stand - ${businessName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem;
    }
    .toolbar {
      width: 100%;
      max-width: 700px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #1e293b;
      padding: 1rem 1.5rem;
      border-radius: 12px;
      margin-bottom: 2rem;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .toolbar-title {
      font-weight: 700;
      font-size: 1.1rem;
    }
    .btn-group {
      display: flex;
      gap: 0.75rem;
    }
    .btn {
      padding: 0.6rem 1.2rem;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      border: none;
      transition: all 0.15s ease;
    }
    .btn-primary {
      background: ${primaryColor};
      color: #ffffff;
    }
    .btn-primary:hover {
      filter: brightness(1.15);
    }
    .btn-secondary {
      background: #334155;
      color: #f8fafc;
    }
    .btn-secondary:hover {
      background: #475569;
    }
    .stand-canvas-wrapper {
      background: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 20px 40px rgba(0,0,0,0.4);
      max-width: 580px;
      width: 100%;
    }
    .stand-svg-container {
      width: 100%;
      height: auto;
      display: block;
    }
    .instructions-card {
      max-width: 580px;
      width: 100%;
      margin-top: 1.5rem;
      background: #1e293b;
      border-radius: 12px;
      padding: 1.25rem 1.5rem;
      font-size: 0.9rem;
      line-height: 1.5;
      color: #cbd5e1;
    }
    .instructions-card h4 {
      color: #38bdf8;
      margin-bottom: 0.5rem;
      font-size: 1rem;
    }

    @media print {
      body {
        background: #ffffff;
        color: #000000;
        padding: 0;
      }
      .toolbar, .instructions-card {
        display: none !important;
      }
      .stand-canvas-wrapper {
        box-shadow: none;
        border-radius: 0;
        max-width: 100%;
        width: 100%;
      }
      @page {
        size: 4in 6in;
        margin: 0;
      }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-title">🪧 Customized Payment QR Stand</div>
    <div class="btn-group">
      <button class="btn btn-secondary" onclick="downloadSvg()">📥 Download SVG</button>
      <button class="btn btn-primary" onclick="window.print()">🖨️ Print Stand (Ctrl+P)</button>
    </div>
  </div>

  <div class="stand-canvas-wrapper">
    <div class="stand-svg-container">
      ${svgMarkup}
    </div>
  </div>

  <div class="instructions-card">
    <h4>💡 Production &amp; Acrylic Stand Assembly Guide</h4>
    <p>• <strong>Print Size:</strong> Pre-calibrated for standard <strong>4" x 6" (100mm x 150mm)</strong> or <strong>5" x 7"</strong> countertop acrylic T-stands.</p>
    <p>• <strong>Material Recommendation:</strong> Print on 300+ GSM Glossy Photo Paper or Matte Vinyl Sheet for maximum scratch resistance and crisp QR scanning.</p>
    <p>• <strong>₹2,000+ Acceptance Notice:</strong> Customers point their PhonePe / GPay camera directly at the physical stand. Because it is an in-person camera scan (not a gallery screenshot), payments above ₹2,000 are processed without any gallery limit.</p>
  </div>

  <script>
    function downloadSvg() {
      const svg = document.querySelector('.stand-svg-container svg');
      if (!svg) return;
      const serializer = new XMLSerializer();
      const source = serializer.serializeToString(svg);
      const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'payment-stand-${escapeXml(options.businessName).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.svg';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  </script>
</body>
</html>`;
}
