import crypto from 'node:crypto';

/**
 * Canonical Cloudflare Tunnel and Runtime URL Resolution Engine.
 * Single source of truth for runtime mode, derived hostnames, and service mappings.
 */

export const SERVICE_PORTS = Object.freeze({
  CHECKOUT: 7000,
  API: 6100,
  ADMIN: 6001,
  GMAIL: 6003,
  STORE: 5000
});

/**
 * Derives public hostnames and Cloudflare published application mappings.
 * @param {{ domain?: string, prefix?: string }} config
 * @returns {Array<{
 *   role: string,
 *   name: string,
 *   publicHostname: string,
 *   publicUrl: string,
 *   serviceUrl: string,
 *   port: number,
 *   purpose: string,
 *   optional: boolean
 * }>}
 */
export function deriveCloudflareRoutes(config = {}) {
  const rawDomain = (config.domain || config.domainTld || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const rawPrefix = (config.prefix || config.domainPrefix || 'pay').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'pay';

  if (!rawDomain) {
    return [];
  }

  return [
    {
      role: 'checkout',
      name: 'Checkout',
      publicHostname: `${rawPrefix}.${rawDomain}`,
      publicUrl: `https://${rawPrefix}.${rawDomain}`,
      serviceUrl: `http://localhost:${SERVICE_PORTS.CHECKOUT}`,
      port: SERVICE_PORTS.CHECKOUT,
      purpose: 'Customer checkout / checkout portal',
      optional: false
    },
    {
      role: 'api',
      name: 'Payment API',
      publicHostname: `${rawPrefix}-api.${rawDomain}`,
      publicUrl: `https://${rawPrefix}-api.${rawDomain}`,
      serviceUrl: `http://localhost:${SERVICE_PORTS.API}`,
      port: SERVICE_PORTS.API,
      purpose: 'Payment API / merchant API / SSE / observer ingestion',
      optional: false
    },
    {
      role: 'admin',
      name: 'Merchant Admin',
      publicHostname: `${rawPrefix}-admin.${rawDomain}`,
      publicUrl: `https://${rawPrefix}-admin.${rawDomain}`,
      serviceUrl: `http://localhost:${SERVICE_PORTS.ADMIN}`,
      port: SERVICE_PORTS.ADMIN,
      purpose: 'Merchant/Admin panel',
      optional: false
    },
    {
      role: 'gmail',
      name: 'Gmail OAuth / Gmail Observer',
      publicHostname: `${rawPrefix}-gmail.${rawDomain}`,
      publicUrl: `https://${rawPrefix}-gmail.${rawDomain}`,
      serviceUrl: `http://localhost:${SERVICE_PORTS.GMAIL}`,
      port: SERVICE_PORTS.GMAIL,
      purpose: 'Gmail OAuth callback and Gmail observation service',
      optional: false
    },
    {
      role: 'store',
      name: 'Demo Store',
      publicHostname: `${rawPrefix}-store.${rawDomain}`,
      publicUrl: `https://${rawPrefix}-store.${rawDomain}`,
      serviceUrl: `http://localhost:${SERVICE_PORTS.STORE}`,
      port: SERVICE_PORTS.STORE,
      purpose: 'Reference/demo store',
      optional: true
    }
  ];
}

/**
 * Resolves authoritative runtime URLs for all system components.
 * @param {{
 *   envMode?: string,
 *   domain?: string,
 *   domainTld?: string,
 *   prefix?: string,
 *   domainPrefix?: string
 * }} options
 */
export function resolveRuntimeUrls(options = {}) {
  let mode = options.envMode;
  if (!mode) {
    if (process.env.YOUPI_MODE) {
      mode = process.env.YOUPI_MODE;
    } else if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
      mode = 'localhost';
    } else if (process.env.CLOUDFLARE_DOMAIN) {
      mode = 'production';
    } else {
      mode = 'localhost';
    }
  }
  mode = String(mode).toLowerCase();
  const domain = (options.domain || options.domainTld || process.env.CLOUDFLARE_DOMAIN || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const prefix = (options.prefix || options.domainPrefix || process.env.DEPLOYMENT_PREFIX || 'pay').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'pay';

  if (mode === 'production') {
    if (!domain) {
      if (process.env.RENDER === 'true' || process.env.RENDER_EXTERNAL_URL) {
        const renderHost = process.env.RENDER_EXTERNAL_URL
          ? new URL(process.env.RENDER_EXTERNAL_URL).host
          : (options.domain || 'onrender.com');
        return {
          mode: 'production',
          isProduction: true,
          domain: renderHost,
          prefix,
          routes: [],
          checkoutUrl: `https://${renderHost}/checkout/`,
          checkoutHostname: renderHost,
          apiUrl: `https://${renderHost}`,
          apiHostname: renderHost,
          adminUrl: `https://${renderHost}/admin`,
          adminHostname: renderHost,
          gmailUrl: `https://${renderHost}`,
          gmailHostname: renderHost,
          storeUrl: `https://${renderHost}/store`,
          storeHostname: renderHost
        };
      }
      if ((process.env.NODE_ENV === 'test' || process.env.YOUPI_MODE === 'localhost') && options.envMode !== 'production') {
        mode = 'localhost';
      } else {
        mode = 'localhost';
      }
    }
  }

  if (mode === 'production') {

    const routes = deriveCloudflareRoutes({ domain, prefix });
    const getRoute = (role) => routes.find(r => r.role === role);

    return {
      mode: 'production',
      isProduction: true,
      domain,
      prefix,
      routes,
      checkoutUrl: getRoute('checkout')?.publicUrl || `https://${prefix}.${domain}`,
      checkoutHostname: getRoute('checkout')?.publicHostname || `${prefix}.${domain}`,
      apiUrl: getRoute('api')?.publicUrl || `https://${prefix}-api.${domain}`,
      apiHostname: getRoute('api')?.publicHostname || `${prefix}-api.${domain}`,
      adminUrl: getRoute('admin')?.publicUrl || `https://${prefix}-admin.${domain}`,
      adminHostname: getRoute('admin')?.publicHostname || `${prefix}-admin.${domain}`,
      gmailUrl: getRoute('gmail')?.publicUrl || `https://${prefix}-gmail.${domain}`,
      gmailHostname: getRoute('gmail')?.publicHostname || `${prefix}-gmail.${domain}`,
      storeUrl: getRoute('store')?.publicUrl || `https://${prefix}-store.${domain}`,
      storeHostname: getRoute('store')?.publicHostname || `${prefix}-store.${domain}`
    };
  }

  // Localhost / Development Mode
  return {
    mode: 'localhost',
    isProduction: false,
    domain: domain || 'localhost',
    prefix: prefix || 'pay',
    routes: [
      { role: 'checkout', name: 'Checkout', publicHostname: 'localhost:7000', publicUrl: 'http://localhost:7000', serviceUrl: 'http://localhost:7000', port: 7000, purpose: 'Customer checkout / checkout portal', optional: false },
      { role: 'api', name: 'Payment API', publicHostname: 'localhost:6100', publicUrl: 'http://localhost:6100', serviceUrl: 'http://localhost:6100', port: 6100, purpose: 'Payment API / merchant API / SSE / observer ingestion', optional: false },
      { role: 'admin', name: 'Merchant Admin', publicHostname: 'localhost:6001', publicUrl: 'http://localhost:6001', serviceUrl: 'http://localhost:6001', port: 6001, purpose: 'Merchant/Admin panel', optional: false },
      { role: 'gmail', name: 'Gmail OAuth / Gmail Observer', publicHostname: 'localhost:6003', publicUrl: 'http://localhost:6003', serviceUrl: 'http://localhost:6003', port: 6003, purpose: 'Gmail OAuth callback and Gmail observation service', optional: false },
      { role: 'store', name: 'Demo Store', publicHostname: 'localhost:5000', publicUrl: 'http://localhost:5000', serviceUrl: 'http://localhost:5000', port: 5000, purpose: 'Reference/demo store', optional: true }
    ],
    checkoutUrl: 'http://localhost:7000',
    checkoutHostname: 'localhost:7000',
    apiUrl: 'http://localhost:6100',
    apiHostname: 'localhost:6100',
    adminUrl: 'http://localhost:6001',
    adminHostname: 'localhost:6001',
    gmailUrl: 'http://localhost:6003',
    gmailHostname: 'localhost:6003',
    storeUrl: 'http://localhost:5000',
    storeHostname: 'localhost:5000'
  };
}

/**
 * Generates structured SMS Gateway QR pairing payload according to Part C1 & C2.
 */
export function createPairingPayload(options = {}) {
  const {
    serverUrl,
    sessionId = `pair_sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    token = `tok_${crypto.randomBytes(8).toString('hex')}`,
    merchantId = '00000000-0000-0000-0000-000000000001',
    ttlMs = 10 * 60 * 1000 // 10 minutes default
  } = options;

  return {
    version: 'v1',
    type: 'YOUPI_SMS_GATEWAY_PAIR',
    serverUrl: serverUrl || 'http://localhost:6100',
    sessionId,
    token,
    merchantId,
    expiresAt: Date.now() + ttlMs,
    issuedAt: Date.now()
  };
}

/**
 * Validates pairing payload according to Part C5.
 */
export function validatePairingPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { valid: false, error: 'INVALID YOUPI PAIRING QR' };
  }
  if (payload.type !== 'YOUPI_SMS_GATEWAY_PAIR') {
    return { valid: false, error: 'INVALID YOUPI PAIRING QR' };
  }
  if (payload.version !== 'v1') {
    return { valid: false, error: 'INVALID YOUPI PAIRING QR VERSION' };
  }
  if (!payload.serverUrl || !payload.token || !payload.sessionId) {
    return { valid: false, error: 'MALFORMED YOUPI PAIRING QR: Missing required fields' };
  }
  if (!payload.serverUrl.startsWith('http://') && !payload.serverUrl.startsWith('https://')) {
    return { valid: false, error: 'INVALID SERVER URL PROTOCOL' };
  }
  if (payload.expiresAt && Date.now() > payload.expiresAt) {
    return { valid: false, error: 'PAIRING QR EXPIRED' };
  }
  return { valid: true };
}

/**
 * Resolves active runtime pairing API URL.
 */
export function resolvePairingUrl(options = {}) {
  const urls = resolveRuntimeUrls(options);
  return urls.apiUrl || 'http://localhost:6100';
}

/**
 * OAuth redirect URI for the Gmail observer. `GMAIL_REDIRECT_URI` wins; otherwise it is derived
 * from the configured domain, falling back to the local observer port.
 * @param {object} [branding]
 */
export function resolveGmailRedirectUri(branding = {}) {
  if (process.env.GMAIL_REDIRECT_URI) return process.env.GMAIL_REDIRECT_URI;
  try {
    const urls = resolveRuntimeUrls(branding || {});
    const gmailUrl = urls.isProduction
      ? urls.gmailUrl
      : `http://localhost:${process.env.GMAIL_OBSERVER_PORT || 6003}`;
    return `${gmailUrl}/oauth/callback`;
  } catch {
    return `http://localhost:${process.env.GMAIL_OBSERVER_PORT || 6003}/oauth/callback`;
  }
}

/**
 * Resolves standard white-label branding configuration with environment variable defaults.
 * Cascades: overrides -> environment variables (DEFAULT_APP_NAME, etc.) -> default platform fallbacks.
 *
 * @param {object} [overrides={}] Merchant or session-specific branding overrides
 * @returns {{
 *   appName: string,
 *   primaryColor: string,
 *   supportEmail: string,
 *   supportPhone: string,
 *   logoUrl: string | null,
 *   footerGuarantee: string,
 *   trustBadgeText: string
 * }}
 */
export function resolveDefaultBranding(overrides = {}) {
  const envAppName = (process.env.DEFAULT_APP_NAME || '').trim();
  const appName = overrides.appName?.trim() || envAppName || 'YOUPI PG';

  const envPrimaryColor = (process.env.DEFAULT_PRIMARY_COLOR || '').trim();
  const primaryColor = overrides.primaryColor?.trim() || envPrimaryColor || '#2563eb';

  const envSupportEmail = (process.env.DEFAULT_SUPPORT_EMAIL || '').trim();
  const supportEmail = overrides.supportEmail?.trim() || envSupportEmail || 'support@youpi.local';

  const envSupportPhone = (process.env.DEFAULT_SUPPORT_PHONE || '').trim();
  const supportPhone = overrides.supportPhone?.trim() || envSupportPhone || '9876543210';

  const envLogoUrl = (process.env.DEFAULT_LOGO_URL || '').trim() || null;
  const logoUrl = overrides.logoUrl !== undefined ? overrides.logoUrl : envLogoUrl;

  const defaultTrustBadge = `${appName} Verified Business`;
  const trustBadgeText = overrides.trustBadgeText?.trim() || (process.env.DEFAULT_TRUST_BADGE_TEXT || '').trim() || defaultTrustBadge;

  const defaultGuarantee = `100% Payment Protection by ${appName}`;
  const footerGuarantee = overrides.footerGuarantee?.trim() || (process.env.DEFAULT_FOOTER_GUARANTEE || '').trim() || defaultGuarantee;

  return {
    appName,
    primaryColor,
    supportEmail,
    supportPhone,
    logoUrl,
    trustBadgeText,
    footerGuarantee
  };
}
