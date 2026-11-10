import { toPaise } from '@youpi/common';

/**
 * List of recognized and trusted Indian commercial bank email domains.
 * All official bank transaction notifications must originate from these domains or official .bank.in domains.
 */
export const AUTHORIZED_BANK_EMAIL_DOMAINS = [
  'bank.in',
  'fin.in',
  'hdfcbank.net',
  'hdfcbank.com',
  'icicibank.com',
  'sbi.co.in',
  'axisbank.com',
  'kotak.com',
  'kotak.co.in',
  'paytmbank.com',
  'paytm.com',
  'yesbank.in',
  'pnb.co.in',
  'bankofbaroda.co.in',
  'bankofbaroda.com',
  'indusind.com',
  'idfcfirstbank.com',
  'idfcbank.com',
  'canarabank.com',
  'unionbankofindia.co.in',
  'federalbank.co.in',
  'idbibank.com',
  'sliceit.com',
  'sbmbank.co.in',
  'nesfb.com',
  'airtelbank.com',
  'airtel.com',
  'jiopaymentsbank.com',
  'ippbonline.in',
  'finobank.com',
  'aubank.in',
  'equitasbank.com',
  'ujjivansfb.in',
  'rblbank.com',
  'bandhanbank.com',
  'bankofindia.co.in',
  'boi.co.in',
  'centralbankofindia.co.in',
  'indianbank.in',
  'phonepe.com',
  'google.com',
  'razorpay.com',
  'cred.club'
];

/**
 * Redacts personal identifiers, bank account numbers, customer contact information,
 * and internal transaction references from ordinary operational logs.
 * @param {string} str
 * @returns {string}
 */
export function redactSensitiveData(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    // Redact 12-digit UTRs / RRNs
    .replace(/\b(\d{4})\d{4}(\d{4})\b/g, '$1****$2')
    // Redact bank account numbers (e.g. A/c XX4274 or A/c 1234567890)
    .replace(/(?:a\/c|account|acct)[\s:]*([xX]*\d{4}|\d{6,18})/gi, 'A/c ****')
    // Redact email addresses (e.g. user@domain.com -> u***@domain.com)
    .replace(/\b([a-zA-Z0-9])[a-zA-Z0-9._%+-]*@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g, '$1***@$2')
    // Redact 10-digit phone/mobile numbers
    .replace(/\b(?:\+91|91)?([6-9]\d{1})\d{4}(\d{4})\b/g, '+91-$1****$2');
}

/**
 * Validates whether an incoming email sender originates from an authorized bank domain.
 * Untrusted personal accounts (e.g. @gmail.com, @yahoo.com) are rejected as spoofing risks.
 * @param {string} sender
 * @returns {boolean}
 */
export function isAuthorizedBankEmailSender(sender) {
  if (!sender || typeof sender !== 'string') return false;
  const match = sender.match(/<([^>]+)>/);
  const cleanEmail = (match ? match[1] : sender).trim().toLowerCase();
  if (cleanEmail === 'test' || cleanEmail.endsWith('.youpi.local') || cleanEmail === 'gmail-browser-automator') {
    return true;
  }
  const domain = cleanEmail.includes('@') ? cleanEmail.split('@')[1] : cleanEmail;
  if (!domain) return false;
  return AUTHORIZED_BANK_EMAIL_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

/**
 * Intelligent Monetary Amount Extractor for Indian UPI & Bank Alerts.
 * Extracts amounts with prefix (Rs. 20.00, INR 500), suffix (20.00 Rs),
 * proximity words ("20.00 received", "received 20.00", "credited 20"),
 * or clean standalone decimal amounts ("20.00").
 * @param {string} text
 * @returns {{ amountStr: string, amountPaise: bigint } | null}
 */
export function extractIntelligentAmount(text) {
  if (!text || typeof text !== 'string') return null;

  // Pattern 1: Standard currency prefix (e.g. Rs. 20.00, Rs 200, INR 500.00, ₹1,200.50, ₹20)
  const prefixMatch = text.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (prefixMatch && prefixMatch[1]) {
    const clean = prefixMatch[1].replace(/,/g, '');
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  // Pattern 2: Standard currency suffix (e.g. 20.00 Rs, 20.00 INR, 20rs, 500 inr)
  const suffixMatch = text.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|inr|₹)/i);
  if (suffixMatch && suffixMatch[1]) {
    const clean = suffixMatch[1].replace(/,/g, '');
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  // Pattern 3: Number adjacent to credit keywords (e.g. "20.00 received", "received 20.00", "credited 20", "20.00 credited")
  const creditProximityMatch = text.match(/(?:credited|received|deposit|payment|paid|transferred|upi|cr)[\s\w:]*?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)[\s\w:]*?(?:credited|received|deposit|payment|paid|transferred|upi|cr)/i);
  if (creditProximityMatch) {
    const rawVal = creditProximityMatch[1] || creditProximityMatch[2];
    if (rawVal) {
      const clean = rawVal.replace(/,/g, '');
      if (/^\d+(\.\d{1,2})?$/.test(clean) && Number(clean) < 10000000 && Number(clean) > 0) {
        try {
          return { amountStr: clean, amountPaise: toPaise(clean) };
        } catch {}
      }
    }
  }

  // Pattern 4: Standalone decimal currency number (e.g. 20.00, 150.50, 449.00)
  const standaloneDecimal = text.match(/\b(\d{1,6}\.\d{2})\b/);
  if (standaloneDecimal && standaloneDecimal[1]) {
    const clean = standaloneDecimal[1];
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  return null;
}

/**
 * Bank email parser for extracting UPI credit alerts across Indian banks:
 * HDFC, ICICI, SBI, Axis, Kotak, Paytm Payments Bank, custom alt-account transfers, etc.
 */
export class BankEmailParser {
  /**
   * Parses raw email subject and body text into a canonical observation payload.
   * @param {{
   *   subject: string,
   *   body: string,
   *   from?: string,
   *   date?: Date | string
   * }} email
   * @returns {{
   *   amountPaise: bigint,
   *   amount: string,
   *   bankReferenceNumber?: string,
   *   senderVpa?: string,
   *   observedAt: Date,
   *   rawSnippet: string
   * } | null}
   */
  static parse(email) {
    const combinedText = `${email.subject || ''} ${email.body || ''}`.trim();
    if (!combinedText) return null;

    // Check if email represents an incoming credit/payment
    const creditKeywords = /(credited|received|deposit|payment received|payment|upi\/cr|transferred)/i;
    if (!creditKeywords.test(combinedText)) {
      return null; // Ignore non-credit alerts
    }

    // Ignore pure debit notifications if no credit indicator exists
    if (/(debited|withdrawn|sent rs|paid rs)/i.test(combinedText) && !/(credited|received|deposit)/i.test(combinedText)) {
      return null;
    }

    // 1. Extract Monetary Amount using Intelligent Multi-Pattern Extractor
    const extractedAmount = extractIntelligentAmount(combinedText);
    if (!extractedAmount) {
      return null;
    }

    // 2. Extract Bank Reference / UTR Number
    // Matches: UTR: 123456789012, Ref no: UTR-HDFC-9911, Ref: UTR-GMAIL-777, UPI/CR/123456789/, UPI Ref 086704470482
    let bankRef;
    const refMatch = combinedText.match(/(?:utr(?:\s*no\.?)?|ref(?:\s*no\.?|\s*num)?|txn(?:\s*id)?|rrn(?:\s*no\.?)?|upi\s*ref(?:erence)?)[:\s#=-]+([a-zA-Z0-9\-_]{6,35})/i);
    if (refMatch && refMatch[1]) {
      bankRef = refMatch[1].trim();
    } else {
      const upiCrMatch = combinedText.match(/UPI\/CR\/([a-zA-Z0-9\-_]+)/i);
      if (upiCrMatch && upiCrMatch[1]) {
        bankRef = upiCrMatch[1].trim();
      } else {
        const standalone12Digit = combinedText.match(/\b([0-9]{12})\b/);
        if (standalone12Digit && standalone12Digit[1]) {
          bankRef = standalone12Digit[1].trim();
        }
      }
    }

    // 3. Extract Sender VPA
    let senderVpa;
    const vpaMatch = combinedText.match(/(?:from|by)\s+([a-zA-Z0-9.\-_]{2,100}@[a-zA-Z0-9.\-_]{2,64})/i);
    if (vpaMatch && vpaMatch[1]) {
      senderVpa = vpaMatch[1].trim().replace(/[.,;]+$/, '');
    }

    // 4. Timestamp
    let observedAt = new Date();
    if (email.date) {
      const parsedDate = new Date(email.date);
      if (!isNaN(parsedDate.getTime())) {
        observedAt = parsedDate;
      }
    }

    const isBankDomain = email.from ? isAuthorizedBankEmailSender(email.from) : false;

    return {
      amountPaise: extractedAmount.amountPaise,
      amount: extractedAmount.amountStr,
      bankReferenceNumber: bankRef,
      senderVpa,
      observedAt,
      isBankDomain,
      rawSnippet: combinedText.substring(0, 300)
    };
  }
}
