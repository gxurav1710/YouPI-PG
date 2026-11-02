import { toRupeesString } from './money.js';

/**
 * Validates whether a given string is a syntactically valid UPI Virtual Payment Address (VPA).
 * Format: username@bank
 * @param {string} vpa
 * @returns {boolean}
 */
export function isValidVpa(vpa) {
  if (!vpa || typeof vpa !== 'string') return false;
  const clean = vpa.trim();
  return /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9.\-_]{2,64}$/.test(clean);
}

/**
 * Builds a canonical upi://pay URI dynamically from server-validated parameters.
 * Amount is derived exclusively from server-side integer paise.
 * @param {{
 *   payeeVpa: string,
 *   payeeName: string,
 *   amountPaise: bigint,
 *   transactionRef: string,
 *   transactionNote?: string,
 *   currency?: string
 * }} options
 * @returns {string}
 */
export function buildUpiUri(options) {
  if (!isValidVpa(options.payeeVpa)) {
    throw new Error(`Invalid payee VPA: ${options.payeeVpa}`);
  }

  const amountStr = toRupeesString(options.amountPaise);

  const params = new URLSearchParams();
  params.set('pa', options.payeeVpa.trim());
  params.set('pn', options.payeeName.trim());
  params.set('am', amountStr);
  const txnId = (options.transactionRef || options.transactionNote || '').trim();
  if (txnId) {
    params.set('tn', txnId);
  }

  return `upi://pay?${params.toString()}`;
}

/**
 * Builds an Android intent URI for launching a specific UPI application.
 * Format: intent://pay?<UPI_PARAMS>#Intent;scheme=upi;package=<PACKAGE>;end
 * @param {{
 *   payeeVpa: string,
 *   payeeName: string,
 *   amountPaise: bigint,
 *   transactionRef?: string,
 *   transactionNote?: string,
 *   currency?: string,
 *   packageName: string
 * }} options
 * @returns {string}
 */
export function buildUpiIntentUri(options) {
  if (!options.packageName || !options.packageName.trim()) {
    throw new Error('Package name is required for Android UPI intent URI');
  }
  const upiUri = buildUpiUri(options);
  const query = upiUri.split('?')[1] || '';
  const cleanPackage = options.packageName.trim();
  return `intent://pay?${query}#Intent;scheme=upi;package=${cleanPackage};end`;
}

/**
 * Builds an authentic NPCI-compliant UPI URI specifically formatted for physical payment stands
 * (countertop acrylic stands, table tents, or digital counter kiosk displays).
 *
 * Parameters adhere to NPCI Bharat QR / UPI QR specifications:
 * - mode='02': Static physical QR stand (camera scan, customer enters amount, allows > ₹2,000 without gallery limit)
 * - mode='04': Dynamic physical counter display (cashier enters amount, QR displays exact bill amount)
 * - mc: Merchant category code (e.g. '5411' Grocery, '5812' Restaurant, '5999' Miscellaneous)
 * - am: Optional pre-filled amount (if omitted, customer enters any amount in UPI app)
 * - cu: Currency (default 'INR')
 *
 * @param {{
 *   payeeVpa: string,
 *   payeeName: string,
 *   amountPaise?: bigint | null,
 *   merchantCategoryCode?: string,
 *   mode?: string,
 *   transactionNote?: string,
 *   transactionRef?: string,
 *   currency?: string
 * }} options
 * @returns {string}
 */
export function buildStandUpiUri(options) {
  if (!isValidVpa(options.payeeVpa)) {
    throw new Error(`Invalid payee VPA: ${options.payeeVpa}`);
  }

  const params = new URLSearchParams();
  params.set('pa', options.payeeVpa.trim());
  params.set('pn', options.payeeName.trim());

  if (options.amountPaise !== undefined && options.amountPaise !== null) {
    params.set('am', toRupeesString(options.amountPaise));
  }

  if (options.merchantCategoryCode && options.merchantCategoryCode.trim()) {
    params.set('mc', options.merchantCategoryCode.trim());
  }

  // mode='02' for static physical QR code, '04' for dynamic physical terminal/display QR
  const mode = options.mode ? options.mode.trim() : (options.amountPaise ? '04' : '02');
  params.set('mode', mode);

  const txnId = (options.transactionRef || options.transactionNote || '').trim();
  if (txnId) {
    params.set('tn', txnId);
  }

  params.set('cu', (options.currency || 'INR').toUpperCase());

  return `upi://pay?${params.toString()}`;
}
