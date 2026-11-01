import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getCoinStoreWebhookSecret, LEGACY_DEFAULT_WEBHOOK_SECRET, resolveDefaultBranding } from '@youpi/common';
import { getDatabase } from './database.js';
import { MerchantRepository } from './repositories/merchant.repository.js';
import { ReceivingAccountRepository } from './repositories/receiving-account.repository.js';
import { CustomerRepository } from './repositories/customer.repository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Runs database migrations and applies base seeds.
 * @param {import('./database.js').Database} [targetDb]
 */
export function runMigrations(targetDb) {
  const db = targetDb || getDatabase();
  const schemaPath = path.join(__dirname, 'sqlite-schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Detect if customers table has an obsolete schema (phone_number/merchant_id instead of email/mobile_number, or password_hash NOT NULL).
  // The old table is only rebuilt when it holds no customers: a schema mismatch must never destroy customer data.
  try {
    const tableInfo = db.query ? db.query("PRAGMA table_info(customers)") : [];
    const colNames = (tableInfo || []).map(c => c.name);
    const hasOldColumns = colNames.length > 0 && (
      !colNames.includes('email') ||
      colNames.includes('phone_number') ||
      colNames.includes('merchant_id') ||
      !colNames.includes('otp_code') ||
      tableInfo.some(c => c.name === 'password_hash' && c.notnull === 1)
    );
    if (hasOldColumns) {
      const customerCount = Number(db.queryOne('SELECT COUNT(*) AS n FROM customers')?.n || 0);
      if (customerCount === 0) {
        try { db.exec("PRAGMA foreign_keys = OFF;"); } catch {}
        try { db.exec("DROP TABLE IF EXISTS customer_sessions;"); } catch {}
        try { db.exec("DROP TABLE IF EXISTS customers;"); } catch {}
        try { db.exec("PRAGMA foreign_keys = ON;"); } catch {}
      } else {
        console.error(`[migrate] customers table has an obsolete schema but holds ${customerCount} row(s); leaving it untouched. Back up and migrate it manually.`);
      }
    }
  } catch (err) {
    console.error('[migrate] Could not inspect customers table schema; skipping rebuild:', err.message);
  }

  // Fallback alter columns if customers/sessions table exists without new columns
  try { db.exec("ALTER TABLE merchants ADD COLUMN api_key_hash TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN email TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN mobile_number TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN otp_code TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN otp_expires_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN otp_attempts INTEGER NOT NULL DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN is_phone_verified INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN ban_reason TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN banned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN unbanned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN last_device TEXT;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN device_id TEXT;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_level INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_sources TEXT DEFAULT '[]';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_tag TEXT DEFAULT 'UNVERIFIED';"); } catch {}
  try { db.exec('ALTER TABLE payment_sessions ADD COLUMN customer_utr TEXT;'); } catch {}
  try { db.exec('ALTER TABLE payment_sessions ADD COLUMN utr_submitted_at TEXT;'); } catch {}
  try { db.exec('ALTER TABLE payment_sessions ADD COLUMN manual_reviewed_by TEXT;'); } catch {}
  try { db.exec('ALTER TABLE payment_sessions ADD COLUMN manual_reviewed_at TEXT;'); } catch {}
  try { db.exec('ALTER TABLE payment_sessions ADD COLUMN manual_review_reason TEXT;'); } catch {}

  // Phase 9C/9D: Preflight conflict check for existing databases prior to applying DDL / indexes
  try {
    const hasSessions = db.query ? db.queryOne("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='payment_sessions'") : null;
    if (hasSessions && Number(hasSessions.count) > 0) {
      const conflicts = db.query(`
        SELECT receiving_account_id, COUNT(*) as active_count
        FROM payment_sessions
        WHERE status IN ('ACTIVE', 'PROCESSING')
        GROUP BY receiving_account_id
        HAVING COUNT(*) > 1
      `);
      if (conflicts && conflicts.length > 0) {
        throw new Error(`[migrate] Cannot apply idx_single_active_session: Detected ${conflicts.length} receiving account(s) with multiple active/processing sessions: ${JSON.stringify(conflicts)}`);
      }
    }
  } catch (err) {
    if (err.message && err.message.includes('Cannot apply idx_single_active_session')) {
      throw err;
    }
  }

  // Older outboxes allowed only one legacy terminal event per payment. A UPI
  // payment can emit OBSERVED_SUCCESS and then RECONCILED, so retain each event.
  // Copy only already-pending rows: upgrading must not notify historic orders.
  const outboxColumns = db.query("PRAGMA table_info(payment_webhook_outbox)");
  if (outboxColumns.length && !outboxColumns.some(column => column.name === 'event_type' && column.pk)) {
    db.transaction(() => {
      db.exec('DROP TRIGGER IF EXISTS trg_terminal_payment_webhook_outbox;');
      db.exec(`
        CREATE TABLE payment_webhook_outbox_upgrade (
          payment_id TEXT NOT NULL REFERENCES payment_sessions(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL CHECK(event_type IN ('SUCCESS','FAILED','EXPIRED','CANCELLED','OBSERVED_SUCCESS','MANUAL_REVIEW','RECONCILED')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (payment_id, event_type)
        );
        INSERT INTO payment_webhook_outbox_upgrade (payment_id, event_type, created_at)
          SELECT payment_id, event_type, created_at FROM payment_webhook_outbox;
        DROP TABLE payment_webhook_outbox;
        ALTER TABLE payment_webhook_outbox_upgrade RENAME TO payment_webhook_outbox;
      `);
      // Reinstall the new trigger in the same transaction as the table upgrade.
      db.exec(schemaSql);
    });
  }

  // Execute schema DDL
  db.exec(schemaSql);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_upi_utr_per_receiving_account
    ON payment_sessions (receiving_account_id, upper(customer_utr))
    WHERE method = 'MANUAL_UPI' AND customer_utr IS NOT NULL;`);

  // Alter table columns if migrating existing databases
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_level INTEGER DEFAULT 0;"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_sources TEXT DEFAULT '[]';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN verification_tag TEXT DEFAULT 'UNVERIFIED';"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN attempt_id TEXT;"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_session_per_order ON payment_sessions (merchant_id, order_id) WHERE status NOT IN ('FAILED', 'EXPIRED', 'CANCELLED');"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_one_slot_per_receiving_account ON payment_sessions (receiving_account_id) WHERE status IN ('ACTIVE', 'PROCESSING') AND receiving_account_id IS NOT NULL;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_payment_sessions_order ON payment_sessions (merchant_id, order_id, created_at);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries (is_successful, next_retry_at);"); } catch {}
  try { db.exec("ALTER TABLE payment_receiving_accounts ADD COLUMN is_merchant_enabled INTEGER NOT NULL DEFAULT 1;"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_vpa_per_merchant ON payment_receiving_accounts (merchant_id) WHERE is_active = 1;"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers (email);"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_mobile ON customers (mobile_number);"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN ban_reason TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN banned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN unbanned_at TEXT;"); } catch {}
  try { db.exec("ALTER TABLE customers ADD COLUMN last_device TEXT;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions (token, is_active);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions (customer_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_security_events_customer ON security_events (customer_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_security_events_session ON security_events (payment_session_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events (event_type);"); } catch {}
  try { db.exec("ALTER TABLE payment_sessions ADD COLUMN device_id TEXT REFERENCES devices(id);"); } catch {}
  try { db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
      public_key TEXT NOT NULL,
      fingerprint_hash TEXT NOT NULL,
      user_agent TEXT,
      platform TEXT,
      browser TEXT,
      timezone TEXT,
      language TEXT,
      screen_signature TEXT,
      device_token TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices (customer_id);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_devices_fingerprint ON devices (fingerprint_hash);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_payment_sessions_device ON payment_sessions (device_id);"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_sessions_attributed_obs ON payment_sessions (attributed_observation_id) WHERE attributed_observation_id IS NOT NULL;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_observations_bank_ref ON payment_observations (bank_reference_number);"); } catch {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_unique_attributed_bank_ref ON payment_observations (bank_reference_number) WHERE bank_reference_number IS NOT NULL AND attributed_payment_id IS NOT NULL;"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_observations_fingerprint ON payment_observations (fingerprint_hash);"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_observations_attributed_payment ON payment_observations (attributed_payment_id);"); } catch {}

  // Seed default merchant if empty
  const merchantRepo = new MerchantRepository(db);
  const existing = merchantRepo.findAll();

  let defaultMerchant;
  if (existing.length === 0) {
    const branding = resolveDefaultBranding();
    const businessName = process.env.DEFAULT_MERCHANT_NAME || 'YOUPI Demo Store';
    const slug = process.env.DEFAULT_MERCHANT_SLUG || 'demo-store';
    const contactEmail = process.env.DEFAULT_SUPPORT_EMAIL || 'merchant@youpi.local';
    const contactPhone = process.env.DEFAULT_SUPPORT_PHONE || '9876543210';

    defaultMerchant = merchantRepo.create({
      id: '00000000-0000-0000-0000-000000000001',
      businessName,
      slug,
      contactEmail,
      contactPhone,
      webhookUrl: process.env.COIN_STORE_WEBHOOK_URL || 'http://localhost:5000/api/webhook',
      webhookSecret: getCoinStoreWebhookSecret(),
      branding: {
        appName: branding.appName,
        primaryColor: branding.primaryColor,
        logoUrl: branding.logoUrl,
        trustBadgeText: branding.trustBadgeText,
        footerGuarantee: branding.footerGuarantee
      }
    });
  } else {
    defaultMerchant = existing[0];
    if (!defaultMerchant.webhookSecret) {
      merchantRepo.update(defaultMerchant.id, {
        webhookUrl: 'http://localhost:5000/api/webhook',
        webhookSecret: getCoinStoreWebhookSecret()
      });
    } else if (defaultMerchant.webhookSecret === LEGACY_DEFAULT_WEBHOOK_SECRET) {
      // Older installs were seeded with a publicly known secret: rotate it.
      merchantRepo.update(defaultMerchant.id, { webhookSecret: getCoinStoreWebhookSecret() });
      console.warn('[migrate] Rotated the default merchant webhook secret away from the legacy public value. Update your merchant webhook verifier.');
    }
  }

  // Seed default UPI receiving account if none
  const accountRepo = new ReceivingAccountRepository(db);
  const accounts = accountRepo.findByMerchantId(defaultMerchant.id);
  if (accounts.length === 0) {
    accountRepo.create({
      id: '00000000-0000-0000-0000-000000000002',
      merchantId: defaultMerchant.id,
      upiId: 'merchant@upi',
      payeeName: defaultMerchant.businessName,
      isActive: true
    });
  }

  // Demo customer seeding is opt-in and never carries real personal data.
  // Previously this unconditionally created a customer with a real name, phone number and
  // email, and flagged the phone as verified — shipping someone's PII (and a pre-authorised
  // OTP login identity) into every merchant deployment.
  if (process.env.YOUPI_SEED_DEMO_CUSTOMER === 'true') {
    const customerRepo = new CustomerRepository(db);
    const demoMobile = '9000000000';
    if (!customerRepo.findByMobile(demoMobile)) {
      customerRepo.create({
        id: '00000000-0000-0000-0000-000000000002',
        name: 'Demo Customer',
        email: 'demo-customer@youpi.local',
        mobileNumber: demoMobile,
        isPhoneVerified: false
      });
    }
  }

  return {
    db,
    defaultMerchant
  };
}

/**
 * Completely wipes all customer identity records and active sessions,
 * reinitializing the customer identity store to a pristine state.
 * @param {import('./database.js').Database} [targetDb]
 */
export function reinitializeCustomerIdentity(targetDb) {
  const db = targetDb || getDatabase();
  try { db.exec("PRAGMA foreign_keys = OFF;"); } catch {}
  try { db.exec("UPDATE payment_sessions SET customer_id = NULL WHERE customer_id IS NOT NULL;"); } catch {}
  try { db.exec("DELETE FROM customer_sessions;"); } catch {}
  try { db.exec("DELETE FROM customers;"); } catch {}
  try { db.exec("PRAGMA foreign_keys = ON;"); } catch {}
  return { success: true, message: 'All old customer identity records wiped and reinitialized.' };
}

// Auto-run if executed directly as script
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('Running YOUPI PG database migrations...');
  const result = runMigrations();
  console.log(`Migration completed successfully. Default merchant: ${result.defaultMerchant.businessName} (${result.defaultMerchant.id})`);
}
