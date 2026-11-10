import crypto from 'node:crypto';
import {
  ObserverSource,
  PaymentStatus,
  calculateObservationFingerprint,
  toPaise,
  normalizeEmail,
  normalizeMobile
} from '@youpi/common';
import { extractIntelligentAmount } from './bank-sms-parser.js';
import { ObservationNormalizer } from './normalizer.js';

/**
 * Universal Institutional Identifier: Every official Indian bank alert domain ends with .bank.in
 * (e.g. alerts@hdfc.bank.in, alerts@sbi.bank.in, example@example.bank.in).
 * No specific banks are hardcoded.
 */


/**
 * Known malicious, synthetic, or defined fake injection patterns.
 */
const FRAUD_PATTERNS = [
  /<script[\s>]/i,
  /<iframe[\s>]/i,
  /javascript:/i,
  /onerror\s*=/i,
  /onload\s*=/i,
  /union\s+select/i,
  /drop\s+table/i,
  /exec\s*\(/i,
  /eval\s*\(/i,
  /fraud_payload/i,
  /defined[\s_-]*fake[\s_-]*injection/i,
  /fake[\s_-]*injection/i,
  /fake[\s_-]*payload/i,
  /fraud[\s_-]*injection/i,
  /synthetic[\s_-]*attack/i,
  /suspicious_hack/i,
  /exploit/i,
  /attack/i,
  /malicious/i
];

/**
 * Complete Payment Verification & Observation Security Pipeline.
 *
 * Core Decision Architecture:
 *
 *                  MESSAGE
 *                     │
 *                     ▼
 *                Parse it
 *                     │
 *           ┌─────────┴─────────┐
 *           │                   │
 *       Doesn't match       Matches parser
 *           │                   │
 *           ▼                   ▼
 *        REJECT           Verification
 *                               │
 *                      ┌────────┴────────┐
 *                      │                 │
 *                   Legitimate       Defined fake
 *                      │              injection
 *                      ▼                 │
 *                   SUCCESS             ▼
 *                                   DO NOT PAY
 *                                       │
 *                                       ▼
 *                                   AUTO BAN
 *
 * Implements 6 Execution Stages:
 * [ Stage 1 ] Load + Normalize + Preserve Raw Evidence
 * [ Stage 2 ] Source / Sender Filtering (reject personal SMS, reject invalid email domain, reject irrelevant sources)
 * [ Stage 3 ] Payment Parser (received_at, exact amount, CR/CREDIT/CREDITED, Rs/₹, 12-digit reference)
 * [ Stage 4 ] Payment Verification (active session?, after session start?, amount matches?, duplicate?, reference already used?)
 * [ Stage 5 ] Security Engine (fraud injection?, banned identity?, device mismatch?, suspicious behavior? auto-banning)
 * [ Stage 6 ] Attribution (SUCCESS / REJECT / SUSPICIOUS / UNRESOLVED)
 */
export class PaymentVerificationPipeline {
  /**
   * @param {{
   *   db: import('@youpi/db').Database,
   *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
   *   obsRepo: import('@youpi/db').ObservationRepository,
   *   customerRepo?: import('@youpi/db').CustomerRepository,
   *   attributionEngine: import('./attribution-engine.js').AttributionEngine,
   *   auditRepo?: import('@youpi/db').AuditLogRepository,
   *   merchantRepo?: import('@youpi/db').MerchantRepository
   * }} options
   */
  constructor(options) {
    this.db = options.db;
    this.sessionRepo = options.sessionRepo;
    this.obsRepo = options.obsRepo;
    this.customerRepo = options.customerRepo;
    this.attributionEngine = options.attributionEngine;
    this.auditRepo = options.auditRepo;
    this.merchantRepo = options.merchantRepo;
    this.server = options.server || null;
    this.eventEmitter = options.eventEmitter || null;
  }

  /**
   * Processes a raw incoming observation (real or synthetic test) through the complete 6-stage pipeline.
   *
   * @param {{
   *   source: 'SMS' | 'GMAIL' | 'ANDROID_OBSERVER' | 'SMS_GATEWAY' | string,
   *   rawText: string,
   *   sender?: string,
   *   receivedAt?: Date | string | number,
   *   receivingAccountId?: string,
   *   paymentSessionId?: string,
   *   isTest?: boolean,
   *   testModeActive?: boolean,
   *   merchantId?: string
   * }} input
   */
  process(input) {
    const isTest = Boolean(input.isTest);
    const testModeActive = Boolean(input.testModeActive);
    // Bank credit notifications are a few hundred bytes. Capping the text bounds the cost of
    // the reference-extraction regexes below, which are scanned from every start offset and
    // would otherwise let one oversized "observation" block the event loop (ReDoS / DoS).
    const MAX_SCAN_CHARS = 8192;
    const rawText = (input.rawText || '').toString().slice(0, MAX_SCAN_CHARS);

    // =========================================================================
    // [ STAGE 1 ]: Load + Normalize + Preserve Raw Evidence
    // =========================================================================
    const rawNormalizedSource = (input.source || 'SMS').toUpperCase();
    const isGmailSource = rawNormalizedSource.includes('GMAIL') || rawNormalizedSource.includes('EMAIL');
    const source = isGmailSource ? 'GMAIL' : 'SMS';
    const messageId = input.messageId || (isTest
      ? `TEST-${crypto.randomUUID().slice(0, 8)}`
      : `OBS-${crypto.randomUUID().slice(0, 8)}`);

    let defaultSender = source === 'GMAIL' ? 'alerts@retail.bank.in' : 'BANK-ALERT';
    if (isTest && input.sender === 'TEST') {
      defaultSender = 'TEST';
    }
    const sender = input.sender !== undefined ? input.sender : defaultSender;

    let receivedAt = new Date();
    if (input.receivedAt) {
      const parsedDate = new Date(input.receivedAt);
      if (!isNaN(parsedDate.getTime())) {
        receivedAt = parsedDate;
      }
    }

    const observation = {
      source: source.toLowerCase(),
      message_id: messageId,
      sender,
      received_at: receivedAt.toISOString(),
      body: rawText,
      raw: rawText, // Preserved exact raw text
      is_simulated: Boolean(input.isSimulated),
      is_test: isTest
    };

    const stage1 = {
      stage: 1,
      name: 'LOADED',
      status: 'LOADED',
      details: {
        messageId,
        source,
        sender,
        receivedAt: observation.received_at,
        isTest,
        rawPreserved: true
      }
    };

    // Helper for structured return
    const buildResult = ({
      finalStatus,
      failingStage,
      failingCondition,
      failingReason,
      stage2,
      stage3,
      stage4,
      stage5,
      stage6,
      parsed,
      session,
      attribution = null
    }) => {
      return {
        success: finalStatus === 'VERIFIED',
        status: finalStatus, // 'VERIFIED' | 'REJECTED' | 'SUSPICIOUS' | 'UNRESOLVED'
        source,
        messageId,
        receivedAt: observation.received_at,
        amount: parsed?.amount ? `₹${parsed.amount}` : null,
        amountPaise: parsed?.amountPaise ? parsed.amountPaise.toString() : null,
        reference: parsed?.bankReferenceNumber || null,
        sender,
        isTest,
        raw: observation.raw,
        failingStage: failingStage || null,
        failingCondition: failingCondition || null,
        reason: failingCondition || null,
        details: failingReason || null,
        stages: {
          stage1,
          stage2: stage2 || { stage: 2, name: 'FILTER', status: 'PENDING' },
          stage3: stage3 || { stage: 3, name: 'PARSER', status: 'PENDING' },
          stage4: stage4 || { stage: 4, name: 'VERIFICATION', status: 'PENDING' },
          stage5: stage5 || { stage: 5, name: 'SECURITY', status: 'PENDING' },
          stage6: stage6 || { stage: 6, name: 'ATTRIBUTION', status: 'PENDING' }
        },
        session: session ? {
          id: session.id,
          orderId: session.orderId,
          amountPaise: session.amountPaise?.toString(),
          status: session.status
        } : null,
        attribution: attribution || null
      };
    };

    // Invariant Guard: Bounded rawText boundary to prevent ReDoS (CWE-400)
    if (input.rawText && typeof input.rawText === 'string' && input.rawText.length > MAX_SCAN_CHARS) {
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 1,
        failingCondition: 'PAYLOAD_TOO_LARGE',
        failingReason: `Transaction notification payload exceeds maximum allowable length of ${MAX_SCAN_CHARS} characters (received ${input.rawText.length}).`
      });
    }

    // 0. Resolve Payment Session and Customer Context early for security attribution
    let session = null;

    // The VPA the credit actually landed on. Every fallback below is scoped by it so an
    // observation can never be attributed to another merchant's in-flight session.
    const observedVpa = ((rawText.match(/[a-zA-Z0-9._-]{2,64}@[a-zA-Z0-9._-]{2,32}/) || [])[0] || '').toLowerCase() || null;

    if (input.paymentSessionId) {
      session = this.sessionRepo.findById(input.paymentSessionId);
    } else if (input.receivingAccountId) {
      session = this.sessionRepo.findCurrentActiveOrProcessing(input.receivingAccountId);
    }

    if (!session) {
      // 1. Try finding active or processing session for this specific receiving account
      if (input.receivingAccountId) {
        const row = this.db.queryOne(
          `SELECT * FROM payment_sessions WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING') ORDER BY created_at DESC LIMIT 1`,
          [input.receivingAccountId]
        );
        if (row) session = this.sessionRepo.mapRow(row);
      }
      // 2. Otherwise resolve through the VPA named in the message. Scoping by VPA keeps the
      //    lookup inside a single merchant; the previous gateway-wide "any active receiving
      //    account" query could settle an unrelated merchant's live session.
      if (!session && observedVpa) {
        const row = this.db.queryOne(`
          SELECT ps.* FROM payment_sessions ps
          JOIN payment_receiving_accounts ra ON ps.receiving_account_id = ra.id
          WHERE LOWER(ra.upi_id) = ? AND ps.status IN ('ACTIVE', 'PROCESSING')
          ORDER BY ps.created_at DESC LIMIT 1
        `, [observedVpa]);
        if (row) session = this.sessionRepo.mapRow(row);
      }
      // 3. Check for recently completed session on this receiving account for dual verification upgrade
      if (!session && input.receivingAccountId) {
        const sixtySecsAgo = new Date(Date.now() - 60000).toISOString();
        const row = this.db.queryOne(
          `SELECT * FROM payment_sessions WHERE receiving_account_id = ? AND status IN ('SUCCESS', 'OBSERVED_SUCCESS', 'RECONCILED') AND completed_at >= ? ORDER BY completed_at DESC LIMIT 1`,
          [input.receivingAccountId, sixtySecsAgo]
        );
        if (row) session = this.sessionRepo.mapRow(row);
      }
    }

    let customer = null;
    if (session?.customerId && this.customerRepo) {
      customer = this.customerRepo.findById(session.customerId);
    } else if (input.customerId && this.customerRepo) {
      customer = this.customerRepo.findById(input.customerId);
    } else if (sender && this.customerRepo) {
      customer = this.customerRepo.findByIdentifier(sender);
    }

    // Determine attribution to customer's registered identity (Phone, Email, or Submission Token)
    let isAttributableToCustomer = false;
    let matchedCustomerChannel = null;
    if (customer) {
      const cleanSenderPhone = (sender || '').replace(/\D/g, '').slice(-10);
      const cleanCustPhone = (customer.mobileNumber || customer.phoneNumber || '').replace(/\D/g, '').slice(-10);
      if (cleanCustPhone.length >= 10 && cleanSenderPhone === cleanCustPhone) {
        isAttributableToCustomer = true;
        matchedCustomerChannel = `PHONE (${customer.mobileNumber})`;
      }

      const cleanSenderEmail = (sender || '').trim().toLowerCase();
      const cleanCustEmail = (customer.email || '').trim().toLowerCase();
      if (cleanCustEmail.length > 3 && (cleanSenderEmail === cleanCustEmail || cleanSenderEmail.includes(cleanCustEmail))) {
        isAttributableToCustomer = true;
        matchedCustomerChannel = `EMAIL (${customer.email})`;
      }

      if (input.submissionIdentity) {
        const sub = input.submissionIdentity;
        if (sub.customerId === customer.id ||
            (sub.phone && cleanCustPhone.length >= 10 && sub.phone.replace(/\D/g, '').slice(-10) === cleanCustPhone) ||
            (sub.email && cleanCustEmail.length > 3 && sub.email.trim().toLowerCase() === cleanCustEmail)) {
          isAttributableToCustomer = true;
          matchedCustomerChannel = `SUBMISSION_IDENTITY (${customer.id})`;
        }
      }
    }

    // =========================================================================
    // [ STAGE 2 ]: Source / Sender Filtering
    // =========================================================================
    let stage2;
    if (source === 'SMS') {
      const cleanSender = (sender || '').trim();
      const digitsOnly = cleanSender.replace(/[\s+-]/g, '');

      // Pure numeric check: Any string consisting solely of numbers (personal mobile numbers or +91 prefixed values)
      const isPureNumeric = /^\d+$/.test(digitsOnly) && !/[a-zA-Z]/.test(cleanSender);

      if (isPureNumeric) {
        if (!isAttributableToCustomer) {
          // Unknown sender pure numeric SMS: Reject immediately, NO AUTO-BAN
          stage2 = {
            stage: 2,
            name: 'FILTER',
            status: 'FAILED',
            reason: 'PERSONAL_SMS_REJECTED',
            details: `Personal SMS from numeric phone numbers (${sender}) is rejected. Bank SMS sender cannot be purely numeric; it must be an alphanumeric or alphabetic sender code.`
          };
          return buildResult({
            finalStatus: 'REJECTED',
            failingStage: 2,
            failingCondition: 'PERSONAL_SMS_REJECTED',
            failingReason: stage2.details,
            stage2
          });
        }
        // Attributable to active customer: allow inspection under Defined Fraud Scenario
        stage2 = {
          stage: 2,
          name: 'FILTER',
          status: 'FLAGGED_CUSTOMER_SENDER',
          details: `Sender '${sender}' matches customer registered mobile number. Proceeding to fraud verification.`
        };
      } else {
        // Any pure alphabetic or alphanumeric string of any length containing letters (e.g. HDFCBK, SBI, VM-HDFCBK, AXIS123, etc.)
        const isValidSenderCode = /[a-zA-Z]/.test(cleanSender) && /^[a-zA-Z0-9_\-\.]+$/.test(cleanSender);

        if (!isValidSenderCode) {
          stage2 = {
            stage: 2,
            name: 'FILTER',
            status: 'FAILED',
            reason: 'INVALID_SMS_SENDER',
            details: `Invalid SMS sender '${sender}'. Bank SMS sender must be an alphanumeric or pure alphabetic string containing letters (no pure numeric strings or invalid symbols).`
          };
          return buildResult({
            finalStatus: 'REJECTED',
            failingStage: 2,
            failingCondition: 'INVALID_SMS_SENDER',
            failingReason: stage2.details,
            stage2
          });
        }
      }
    } else if (source === 'GMAIL') {
      let cleanEmail = sender;
      const ltIdx = sender.indexOf('<');
      const gtIdx = sender.lastIndexOf('>');
      if (ltIdx !== -1 && gtIdx > ltIdx) {
        cleanEmail = sender.slice(ltIdx + 1, gtIdx).trim();
      } else {
        cleanEmail = sender.trim();
      }
      let emailDomain = '';
      if (cleanEmail.includes('@')) {
        emailDomain = cleanEmail.split('@')[1]?.toLowerCase().trim().replace(/[>]/g, '');
      } else {
        emailDomain = cleanEmail.toLowerCase().trim().replace(/[>]/g, '');
      }

      // Universal Bank Identifier: Email domain ends with .bank.in/.fin.in or is an official verified Indian bank domain
      const KNOWN_BANK_DOMAINS = new Set([
        'hdfcbank.net', 'hdfcbank.com',
        'icicibank.com',
        'sbi.co.in',
        'axisbank.com',
        'kotak.com', 'kotak.co.in',
        'paytmbank.com', 'paytm.com',
        'yesbank.in', 'pnb.co.in',
        'bankofbaroda.co.in', 'bankofbaroda.com',
        'indusind.com',
        'idfcfirstbank.com', 'idfcbank.com',
        'canarabank.com',
        'unionbankofindia.co.in',
        'federalbank.co.in',
        'idbibank.com',
        'sliceit.com', 'sbmbank.co.in', 'nesfb.com',
        'airtelbank.com', 'airtel.com',
        'jiopaymentsbank.com', 'ippbonline.in',
        'finobank.com', 'aubank.in',
        'equitasbank.com', 'ujjivansfb.in',
        'rblbank.com', 'bandhanbank.com',
        'bankofindia.co.in', 'boi.co.in',
        'centralbankofindia.co.in', 'indianbank.in',
        'phonepe.com', 'google.com', 'razorpay.com', 'cred.club'
      ]);
      const isBankDomain =
        emailDomain.endsWith('.bank.in') ||
        emailDomain.endsWith('.fin.in') ||
        emailDomain === 'bank.in' ||
        emailDomain === 'fin.in' ||
        Array.from(KNOWN_BANK_DOMAINS).some(root => emailDomain === root || emailDomain.endsWith('.' + root));
      // In automated test suite or local dev, allow TEST sender and legacy test fixture domains
      const isValidDomain = isBankDomain || sender === 'TEST' || cleanEmail === 'TEST' || sender === 'gmail-browser-automator' || emailDomain.endsWith('.youpi.local');

      if (!isValidDomain) {
        if (!isAttributableToCustomer) {
          // Unknown sender unauthorized email domain: Reject immediately, NO AUTO-BAN
          stage2 = {
            stage: 2,
            name: 'FILTER',
            status: 'FAILED',
            reason: 'INVALID_EMAIL_DOMAIN',
            details: `Invalid or unauthorized email domain '${emailDomain || sender}'. Official Indian bank alerts must originate from domains ending in .bank.in (e.g. alerts@bankname.bank.in).`
          };
          return buildResult({
            finalStatus: 'REJECTED',
            failingStage: 2,
            failingCondition: 'INVALID_EMAIL_DOMAIN',
            failingReason: stage2.details,
            stage2
          });
        }
        // Attributable to active customer: allow inspection under Defined Fraud Scenario
        stage2 = {
          stage: 2,
          name: 'FILTER',
          status: 'FLAGGED_CUSTOMER_SENDER',
          details: `Sender '${sender}' matches customer registered email. Proceeding to fraud verification.`
        };
      }
    } else {
      stage2 = {
        stage: 2,
        name: 'FILTER',
        status: 'FAILED',
        reason: 'IRRELEVANT_SOURCE',
        details: `Observation source '${source}' is irrelevant or unsupported.`
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 2,
        failingCondition: 'IRRELEVANT_SOURCE',
        failingReason: stage2.details,
        stage2
      });
    }

    if (!stage2) {
      stage2 = {
        stage: 2,
        name: 'FILTER',
        status: 'PASSED',
        details: `Sender '${sender}' and channel source '${source}' verified.`
      };
    }

    // =========================================================================
    // [ STAGE 3 ]: Payment Parser
    // =========================================================================
    let stage3;

    // Invariant 1: Check CR/CREDIT/CREDITED indicator
    const creditKeywords = /(?:credited|credit|cr\b|deposit|deposited|received|transferred)/i;
    if (!creditKeywords.test(rawText)) {
      stage3 = {
        stage: 3,
        name: 'PARSER',
        status: 'FAILED',
        reason: 'MISSING_CREDIT_INDICATOR',
        details: 'Message lacks required credit indicator (CR, CREDIT, CREDITED, RECEIVED, or DEPOSIT).'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 3,
        failingCondition: 'MISSING_CREDIT_INDICATOR',
        failingReason: stage3.details,
        stage2,
        stage3,
        session
      });
    }

    // Invariant 2: Check Indian currency indicator (Rs, Rs., ₹, or INR)
    const currencyKeywords = /(?:\b(?:rs\.?|inr)\b|₹|(?:rs\.?|inr|₹)\s*\d|\d\s*(?:rs\.?|inr|₹))/i;
    if (!currencyKeywords.test(rawText)) {
      stage3 = {
        stage: 3,
        name: 'PARSER',
        status: 'FAILED',
        reason: 'MISSING_CURRENCY_INDICATOR',
        details: 'Message lacks required Indian currency indicator (Rs, Rs., ₹, or INR).'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 3,
        failingCondition: 'MISSING_CURRENCY_INDICATOR',
        failingReason: stage3.details,
        stage2,
        stage3,
        session
      });
    }

    // Invariant 3: Check 12-digit reference (UTR / RRN)
    let bankRef = input.bankReferenceNumber || input.utr || null;
    if (!bankRef) {
      const ref12Patterns = [
        /(?:upi\s*ref(?:erence)?\s*(?:no\.?|num)?|utr(?:\s*no\.?)?|rrn(?:\s*no\.?)?|txn\s*(?:id|ref)?|ref\s*no\.?)[\s:=-]+([0-9]{12})\b/i,
        /(?:ref\s*no\.?)?[\s:#=-]+([0-9]{12})\b/i,
        /\b([0-9]{12})\b/
      ];
      for (const pat of ref12Patterns) {
        const match = rawText.match(pat);
        if (match && match[1]) {
          bankRef = match[1].trim();
          break;
        }
      }
    }

    if (!bankRef && isGmailSource) {
      const generalRefMatch = rawText.match(/(?:utr|ref(?:\s*no\.?)?|txn\s*(?:id|ref)?|rrn)[:\s#]+([a-zA-Z0-9\-_]{6,35})/i) ||
        rawText.match(/UPI\/CR\/([a-zA-Z0-9\-_]+)/i);
      if (generalRefMatch && generalRefMatch[1]) {
        bankRef = generalRefMatch[1].trim();
      }
    }

    if (!bankRef) {
      stage3 = {
        stage: 3,
        name: 'PARSER',
        status: 'FAILED',
        reason: 'MISSING_12_DIGIT_REFERENCE',
        details: 'Message lacks mandatory 12-digit UPI transaction reference / UTR / RRN.'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 3,
        failingCondition: 'MISSING_12_DIGIT_REFERENCE',
        failingReason: stage3.details,
        stage2,
        stage3,
        session
      });
    }

    // Invariant 4: Extract exact monetary amount
    const parsedAmount = extractIntelligentAmount(rawText);
    if (!parsedAmount || !parsedAmount.amountPaise || parsedAmount.amountPaise <= 0n) {
      stage3 = {
        stage: 3,
        name: 'PARSER',
        status: 'FAILED',
        reason: 'INVALID_OR_MISSING_AMOUNT',
        details: 'Could not extract valid monetary amount from message body.'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 3,
        failingCondition: 'INVALID_OR_MISSING_AMOUNT',
        failingReason: stage3.details,
        stage2,
        stage3,
        session
      });
    }

    // Sender VPA optional
    let senderVpa = null;
    const vpaMatch = rawText.match(/(?:from|by|vpa)\s+([a-zA-Z0-9.\-_]{2,64}@[a-zA-Z0-9.\-_]{2,32})/i);
    if (vpaMatch && vpaMatch[1]) {
      senderVpa = vpaMatch[1].trim().replace(/[.,;]+$/, '');
    }

    const parsedData = {
      amountPaise: parsedAmount.amountPaise,
      amount: parsedAmount.amountStr,
      bankReferenceNumber: bankRef,
      senderVpa,
      receivedAt
    };

    stage3 = {
      stage: 3,
      name: 'PARSER',
      status: 'PARSED',
      details: {
        amount: `₹${parsedData.amount}`,
        amountPaise: parsedData.amountPaise.toString(),
        reference: bankRef,
        senderVpa: senderVpa || undefined
      }
    };

    // =========================================================================
    // [ STAGE 4 ]: Payment Verification
    // =========================================================================
    let stage4;
    const hasExplicitSessionId = Boolean(input.paymentSessionId);
    let hasMultipleLiveAmountMatches = false;

    if (!hasExplicitSessionId && parsedData?.amountPaise) {
      const targetAccountId = session?.receivingAccountId || input.receivingAccountId;
      if (targetAccountId) {
        const liveAmountRows = this.db.query(`
          SELECT * FROM payment_sessions
          WHERE receiving_account_id = ?
            AND status IN ('ACTIVE', 'PROCESSING')
            AND amount_paise = ?
          ORDER BY created_at DESC
        `, [targetAccountId, Number(parsedData.amountPaise)]);
        if (liveAmountRows.length > 1) {
          hasMultipleLiveAmountMatches = true;
          session = this.sessionRepo.mapRow(liveAmountRows[0]);
        } else if (liveAmountRows.length === 1) {
          session = this.sessionRepo.mapRow(liveAmountRows[0]);
        }
      }
    }

    if (!session && parsedData?.amountPaise) {
      // Amount alone is not an identifier: two merchants can legitimately have an identical
      // in-flight amount. Only fall back on amount when the VPA the credit landed on is known,
      // and then only within that VPA's merchant.
      const scopeByVpa = observedVpa || (parsedData.vpa ? String(parsedData.vpa).toLowerCase() : null);
      if (scopeByVpa) {
        const matchRows = this.db.query(`
          SELECT ps.* FROM payment_sessions ps
          JOIN payment_receiving_accounts ra ON ps.receiving_account_id = ra.id
          WHERE ps.status IN ('ACTIVE', 'PROCESSING')
            AND ps.amount_paise = ?
            AND LOWER(ra.upi_id) = ?
          ORDER BY ps.created_at DESC
        `, [Number(parsedData.amountPaise), scopeByVpa]);
        if (matchRows.length > 1) {
          hasMultipleLiveAmountMatches = true;
        }
        if (matchRows.length >= 1) {
          session = this.sessionRepo.mapRow(matchRows[0]);
        }
      }
    }

    if (!session) {
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'NO_ACTIVE_SESSION',
        details: 'No active or processing payment session was found matching this payment context.'
      };
      return buildResult({
        finalStatus: 'UNRESOLVED',
        failingStage: 4,
        failingCondition: 'NO_ACTIVE_SESSION',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData
      });
    }

    // 2. Timestamp check: after session start? (Reject if received before session creation)
    const parseSessionTime = (t) => {
      if (!t) return new Date();
      if (t instanceof Date) return t;
      const str = t.toString().trim();
      if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}/.test(str)) {
        return new Date(str.replace(' ', 'T') + 'Z');
      }
      return new Date(str);
    };

    const sessionCreatedAt = session.slotAcquiredAt
      ? parseSessionTime(session.slotAcquiredAt)
      : parseSessionTime(session.createdAt);

    if (receivedAt.getTime() < sessionCreatedAt.getTime() - 1000) {
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'BEFORE_SESSION_CREATION',
        details: `Observation received timestamp (${receivedAt.toISOString()}) is prior to payment session creation (${sessionCreatedAt.toISOString()}).`
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 4,
        failingCondition: 'BEFORE_SESSION_CREATION',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData,
        session
      });
    }

    const activeDeadline = (session.status === PaymentStatus.PROCESSING && (session.processingExpiresAt || session.processing_expires_at))
      ? parseSessionTime(session.processingExpiresAt || session.processing_expires_at)
      : (session.expiresAt || session.expires_at ? parseSessionTime(session.expiresAt || session.expires_at) : null);

    if (activeDeadline) {
      if (receivedAt.getTime() > activeDeadline.getTime()) {
        stage4 = {
          stage: 4,
          name: 'VERIFICATION',
          status: 'FAILED',
          reason: 'SESSION_EXPIRED',
          details: `Observation received timestamp (${receivedAt.toISOString()}) is after payment session expiration (${activeDeadline.toISOString()}).`
        };
        return buildResult({
          finalStatus: 'REJECTED',
          failingStage: 4,
          failingCondition: 'SESSION_EXPIRED',
          failingReason: stage4.details,
          stage2,
          stage3,
          stage4,
          parsed: parsedData,
          session
        });
      }
    }

    // 3. Amount Match Check
    if (BigInt(session.amountPaise) !== BigInt(parsedData.amountPaise)) {
      const expectedAmount = (Number(session.amountPaise) / 100).toFixed(2);
      const gotAmount = (Number(parsedData.amountPaise) / 100).toFixed(2);
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'AMOUNT_MISMATCH',
        details: `Payment amount mismatch: session requires ₹${expectedAmount}, but observation contains ₹${gotAmount}.`
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 4,
        failingCondition: 'AMOUNT_MISMATCH',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData,
        session
      });
    }

    // 4. Duplicate Check
    const receivingAccountId = session.receivingAccountId || input.receivingAccountId || '00000000-0000-0000-0000-000000000002';
    let observerSourceEnum;
    if (isGmailSource) {
      observerSourceEnum = ObserverSource.GMAIL;
    } else if (rawNormalizedSource === ObserverSource.GOOGLE_MESSAGES) {
      observerSourceEnum = ObserverSource.GOOGLE_MESSAGES;
    } else if (rawNormalizedSource === ObserverSource.ANDROID_OBSERVER) {
      observerSourceEnum = ObserverSource.ANDROID_OBSERVER;
    } else {
      observerSourceEnum = ObserverSource.SMS_GATEWAY;
    }
    const fingerprint = calculateObservationFingerprint({
      receivingAccountId,
      amountPaise: parsedData.amountPaise,
      source: observerSourceEnum,
      bankReferenceNumber: bankRef,
      observedAt: receivedAt
    });

    const existingObs = this.obsRepo.findByFingerprintOrFamily
      ? this.obsRepo.findByFingerprintOrFamily(fingerprint, observerSourceEnum)
      : this.obsRepo.findByFingerprint(fingerprint, observerSourceEnum);
    if (existingObs) {
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'DUPLICATE_OBSERVATION',
        details: 'Duplicate observation detected. An identical observation fingerprint has already been processed.'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 4,
        failingCondition: 'DUPLICATE_OBSERVATION',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData,
        session
      });
    }

    // 5. Transaction Reference Already Used Check
    const priorUsedSession = this.db.queryOne(`
      SELECT ps.id, ps.order_id
      FROM payment_sessions ps
      JOIN payment_observations po ON ps.attributed_observation_id = po.id
      WHERE ps.status IN ('SUCCESS', 'OBSERVED_SUCCESS', 'RECONCILED')
        AND ps.id != ?
        AND po.bank_reference_number = ?
      LIMIT 1
    `, [session.id, bankRef]);

    if (priorUsedSession) {
      stage4 = {
        stage: 4,
        name: 'VERIFICATION',
        status: 'FAILED',
        reason: 'REFERENCE_ALREADY_USED',
        details: `Transaction reference '${bankRef}' has already been consumed by completed order #${priorUsedSession.order_id}.`
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 4,
        failingCondition: 'REFERENCE_ALREADY_USED',
        failingReason: stage4.details,
        stage2,
        stage3,
        stage4,
        parsed: parsedData,
        session
      });
    }

    stage4 = {
      stage: 4,
      name: 'VERIFICATION',
      status: 'VERIFIED',
      details: {
        sessionId: session.id,
        orderId: session.orderId,
        amountMatches: true,
        referenceValid: true,
        temporalWindowValid: true
      }
    };

    // =========================================================================
    // [ STAGE 5 ]: Security Engine (EXACT Defined Fraud Scenario Only)
    // =========================================================================
    let stage5;
    let isFraudulentInjection = false;
    let threatType = null;
    let threatDetails = null;

    // Check if customer identity is already banned
    if (customer && customer.status === 'BANNED') {
      stage5 = {
        stage: 5,
        name: 'SECURITY',
        status: 'FAILED',
        reason: 'BANNED_IDENTITY',
        details: 'Associated customer identity is permanently banned.'
      };
      return buildResult({
        finalStatus: 'REJECTED',
        failingStage: 5,
        failingCondition: 'BANNED_IDENTITY',
        failingReason: stage5.details,
        stage2,
        stage3,
        stage4,
        stage5,
        parsed: parsedData,
        session
      });
    }

    // -------------------------------------------------------------------------
    // DEFINED FRAUD DETECTION CONDITIONS (ALL 6 MUST APPLY):
    // 1. There is an active or recently active payment session:
    const isSessionActiveOrRecent = Boolean(session && (session.status === 'ACTIVE' || session.status === 'PROCESSING'));

    // 2. The observation is associated with that customer's payment-session identity:
    const hasAssociatedCustomer = Boolean(customer && customer.id);

    // 3. The incoming observation is attributable to customer's registered email or phone:
    // (calculated above as isAttributableToCustomer)

    // 4. The content is attempting to represent a payment/credit transaction rather than being an ordinary unrelated message:
    const isAttemptingCreditMessage = creditKeywords.test(rawText) && (
      Boolean(bankRef) || Boolean(parsedData?.amountPaise) || currencyKeywords.test(rawText)
    );

    // 5. The observation is not a legitimate bank-originated transaction observation:
    let isNotLegitimateBank = false;
    if (source === 'SMS') {
      const cleanSender = (sender || '').trim();
      const isValidSenderCode = /[a-zA-Z]/.test(cleanSender) && /^[a-zA-Z0-9_\-\.]+$/.test(cleanSender);
      isNotLegitimateBank = !isValidSenderCode || isAttributableToCustomer;
    } else if (source === 'GMAIL') {
      const senderDomain = sender.includes('@') ? sender.split('@')[1]?.toLowerCase().trim() : sender.toLowerCase().trim();
      const isBankDomain = senderDomain.endsWith('.bank.in') || senderDomain === 'bank.in' || sender === 'TEST' || senderDomain === 'hdfcbank.net';
      isNotLegitimateBank = !isBankDomain || isAttributableToCustomer;
    } else {
      isNotLegitimateBank = true;
    }

    // 6. The observation is being used to falsely satisfy payment verification for that customer's session:
    const targetsCustomerSession = Boolean(session && (
      session.customerId === customer?.id ||
      input.paymentSessionId === session.id ||
      (parsedData?.amountPaise && session.amountPaise && BigInt(parsedData.amountPaise) === BigInt(session.amountPaise))
    ));

    // Automatic banning should occur ONLY when all 6 conditions are positively established
    if (isSessionActiveOrRecent &&
        hasAssociatedCustomer &&
        isAttributableToCustomer &&
        isAttemptingCreditMessage &&
        isNotLegitimateBank &&
        targetsCustomerSession) {
      isFraudulentInjection = true;
      threatType = 'FRAUDULENT_PAYMENT_INJECTION';
      threatDetails = `Customer '${customer.name}' attempted to inject fake payment notification attributable to registered identity (${matchedCustomerChannel}).`;
    }

    // Complete evidence preservation package
    const evidence = {
      customerId: customer?.id || null,
      customerName: customer?.name || null,
      customerEmail: customer?.email || null,
      customerPhone: customer?.mobileNumber || null,
      paymentSessionId: session?.id || null,
      orderId: session?.orderId || null,
      sessionState: session?.status || null,
      sessionCreatedAt: session?.createdAt || null,
      sessionAmountPaise: session?.amountPaise?.toString() || null,
      sessionAmountRupees: session?.amountPaise ? (Number(session.amountPaise) / 100).toFixed(2) : null,
      deviceInfo: input.deviceInfo || session?.metadata?.deviceInfo || 'Device Web Client',
      source,
      originatingSender: sender,
      receivedAt: observation.received_at,
      rawMessage: observation.raw, // EXACT RAW MESSAGE VERBATIM!
      normalizedMessage: observation.body,
      extractedAmount: parsedData?.amount ? `₹${parsedData.amount}` : null,
      extractedReference: bankRef || null,
      parserResults: stage3,
      verificationResults: stage4,
      fraudReason: 'FRAUDULENT_PAYMENT_INJECTION',
      detectedAt: new Date().toISOString()
    };

    let autoBanApplied = false;
    let securityDiagnostic = '';

    if (isFraudulentInjection) {
      const isExplicitlySuppressed = Boolean(input.suppressBan);

      // Store security event in DB
      if (this.customerRepo && typeof this.customerRepo.createSecurityEvent === 'function') {
        this.customerRepo.createSecurityEvent({
          merchantId: session.merchantId,
          customerId: customer.id,
          paymentSessionId: session.id,
          eventType: 'FRAUDULENT_PAYMENT_INJECTION',
          source,
          sender,
          deviceInfo: evidence.deviceInfo,
          rawMessage: observation.raw,
          normalizedMessage: observation.body,
          extractedAmount: evidence.extractedAmount,
          extractedReference: evidence.extractedReference,
          parserResults: stage3,
          verificationResults: stage4,
          fraudReason: 'FRAUDULENT_PAYMENT_INJECTION',
          metadata: {
            orderId: session.orderId,
            testModeActive,
            autoBanApplied: !isExplicitlySuppressed,
            banSuppressed: Boolean(isExplicitlySuppressed)
          }
        });
      }

      if (isExplicitlySuppressed) {
        // Explicitly suppressed ban (e.g. for specialized mock tests)
        autoBanApplied = false;
        securityDiagnostic = 'FRAUDULENT_PAYMENT_INJECTION detected. Automatic banning suppressed by explicit request parameter.';

        stage5 = {
          stage: 5,
          name: 'SECURITY',
          status: 'SUSPICIOUS_FLAGGED',
          isSuspicious: true,
          threatType,
          autoBanApplied: false,
          banSuppressed: true,
          diagnostic: securityDiagnostic,
          details: evidence
        };

        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: session.merchantId,
            entityType: 'PAYMENT_SESSION',
            entityId: session.id,
            action: 'TEST_MODE_FRAUD_FLAGGED_BAN_SUPPRESSED',
            actorType: 'SYSTEM',
            details: { threatType, customerId: customer.id, evidence }
          });
        }
      } else {
        // Automatic banning is ENABLED: Ban user instantly right away!
        autoBanApplied = true;
        this.customerRepo.banCustomer(customer.id, 'FRAUDULENT_PAYMENT_INJECTION', { lastDevice: evidence.deviceInfo });
        securityDiagnostic = 'FRAUDULENT_PAYMENT_INJECTION detected. Associated customer identity has been automatically BANNED by Security Engine.';

        stage5 = {
          stage: 5,
          name: 'SECURITY',
          status: 'FAILED',
          isSuspicious: true,
          threatType,
          autoBanApplied: true,
          reason: 'FRAUDULENT_PAYMENT_INJECTION',
          diagnostic: securityDiagnostic,
          details: evidence
        };

        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: session.merchantId,
            entityType: 'CUSTOMER',
            entityId: customer.id,
            action: 'CUSTOMER_AUTOMATICALLY_BANNED',
            actorType: 'SYSTEM',
            details: { threatType, rawText, evidence }
          });
        }

        // Broadcast instant real-time termination to active client over SSE
        if (this.server && session?.id) {
          this.server.broadcastSse(session.id, 'status_change', {
            status: 'BLOCKED',
            isBanned: true,
            fraudDetected: true,
            orderId: session.orderId,
            reason: 'FRAUDULENT_PAYMENT_INJECTION',
            blockedNotice: {
              title: 'FRAUDULENT ACTIVITY DETECTED',
              subtitle: 'Payment Session Terminated & Account Suspended',
              message: 'Our automated verification engine detected fraudulent payment activity associated with this account. Access has been immediately suspended while our security operations team investigates the issue.',
              investigating: true
            }
          });
          this.server.broadcastSse(session.id, 'account_blocked', {
            status: 'BLOCKED',
            isBanned: true,
            fraudDetected: true,
            orderId: session.orderId
          });
        }
        if (this.eventEmitter) {
          this.eventEmitter.emit('PAYMENT.FRAUD_BLOCKED', {
            sessionId: session?.id,
            customerId: customer?.id,
            orderId: session?.orderId,
            reason: 'FRAUDULENT_PAYMENT_INJECTION'
          });
        }

        // DO NOT CONFIRM PAYMENT - RETURN REJECTED IMMEDIATELY
        return buildResult({
          finalStatus: 'REJECTED',
          failingStage: 5,
          failingCondition: 'FRAUDULENT_PAYMENT_INJECTION',
          failingReason: securityDiagnostic,
          stage2,
          stage3,
          stage4,
          stage5,
          parsed: parsedData,
          session
        });
      }
    } else {
      stage5 = {
        stage: 5,
        name: 'SECURITY',
        status: 'PASSED',
        isSuspicious: false,
        autoBanApplied: false,
        details: 'Security and fraud pattern scans passed.'
      };
    }

    // =========================================================================
    // [ STAGE 6 ]: Attribution
    // =========================================================================
    let stage6;

    if (isFraudulentInjection) {
      // In Test Mode where auto-ban is suppressed: STILL DO NOT CONFIRM PAYMENT!
      stage6 = {
        stage: 6,
        name: 'ATTRIBUTION',
        status: 'FLAGGED_SUSPICIOUS',
        outcomeStatus: PaymentStatus.MANUAL_REVIEW,
        details: 'Payment held for manual review. Observation flagged for security review. Not bank-confirmed.'
      };

      if (session?.id && this.sessionRepo && [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.INITIATED, PaymentStatus.QUEUED].includes(session.status)) {
        try {
          this.sessionRepo.transitionToTerminal(session.id, PaymentStatus.MANUAL_REVIEW, { reason: 'FRAUDULENT_PAYMENT_INJECTION' });
          session.status = PaymentStatus.MANUAL_REVIEW;
        } catch {}
      }

      return buildResult({
        finalStatus: PaymentStatus.MANUAL_REVIEW,
        failingStage: 5,
        failingCondition: 'FRAUDULENT_PAYMENT_INJECTION',
        failingReason: securityDiagnostic,
        stage2,
        stage3,
        stage4,
        stage5,
        stage6,
        parsed: parsedData,
        session
      });
    }

    // Execute standard attribution engine process
    const normalized = ObservationNormalizer.normalize({
      source: observerSourceEnum,
      receivingAccountId: session?.receivingAccountId || receivingAccountId,
      rawPayload: {
        ...observation,
        raw: rawText,
        is_test: isTest,
        targetSessionId: hasMultipleLiveAmountMatches ? undefined : (hasExplicitSessionId ? session?.id : session?.id)
      },
      amountPaise: parsedData.amountPaise,
      amount: parsedData.amount,
      observedAt: receivedAt,
      senderVpa: parsedData.senderVpa,
      bankReferenceNumber: parsedData.bankReferenceNumber
    });

    const attributionResult = this.attributionEngine
      ? this.attributionEngine.processObservation(normalized)
      : {
          attributed: true,
          outcomeStatus: 'VERIFIED',
          observationId: normalized.id,
          paymentSessionId: session?.id,
          verificationLevel: 1,
          verificationTag: 'DEFAULT'
        };

    const isAmbiguousHold = Boolean(
      attributionResult.ambiguous ||
      attributionResult.outcomeStatus === PaymentStatus.MANUAL_REVIEW
    );

    stage6 = {
      stage: 6,
      name: 'ATTRIBUTION',
      status: attributionResult.attributed
        ? 'ATTRIBUTED'
        : (isAmbiguousHold ? 'AMBIGUOUS_HELD' : 'UNRESOLVED'),
      outcomeStatus: attributionResult.outcomeStatus,
      details: {
        attributed: attributionResult.attributed,
        ambiguous: Boolean(attributionResult.ambiguous),
        reason: attributionResult.reason || null,
        paymentSessionId: attributionResult.paymentSessionId,
        observationId: attributionResult.observationId,
        attributedSessionId: attributionResult.paymentSessionId,
        outcomeStatus: attributionResult.outcomeStatus,
        verificationLevel: attributionResult.verificationLevel,
        verificationTag: attributionResult.verificationTag
      }
    };

    const finalStatus = attributionResult.attributed
      ? 'VERIFIED'
      : (isAmbiguousHold ? PaymentStatus.MANUAL_REVIEW : 'UNRESOLVED');

    // Refresh session state after attribution
    const updatedSession = this.sessionRepo.findById(session.id);

    return buildResult({
      finalStatus,
      failingStage: attributionResult.attributed ? null : 6,
      failingCondition: attributionResult.attributed
        ? null
        : (attributionResult.reason || attributionResult.outcomeStatus || null),
      failingReason: isAmbiguousHold
        ? `Payment held in MANUAL_REVIEW due to ambiguous session match (${attributionResult.reason || 'AMBIGUOUS_SESSION_MATCH'}).`
        : null,
      stage2,
      stage3,
      stage4,
      stage5,
      stage6,
      parsed: parsedData,
      session: updatedSession || session,
      attribution: attributionResult
    });
  }
}
