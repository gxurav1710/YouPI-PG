-- PostgreSQL Schema for YOUPI PG
-- Canonical Production Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Merchants Table
CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    business_name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(20) NOT NULL,
    webhook_url VARCHAR(1024),
    webhook_secret VARCHAR(255) NOT NULL,
    api_key_hash VARCHAR(64),
    branding TEXT NOT NULL DEFAULT '{"primaryColor":"#2563eb","appName":"YOUPI PG","logoUrl":null}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Payment Receiving Accounts
CREATE TABLE IF NOT EXISTS payment_receiving_accounts (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    upi_id VARCHAR(255) NOT NULL,
    payee_name VARCHAR(255) NOT NULL,
    is_merchant_enabled BOOLEAN NOT NULL DEFAULT true,
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_slot_busy BOOLEAN NOT NULL DEFAULT false,
    current_active_session_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_vpa_per_merchant ON payment_receiving_accounts (merchant_id) WHERE is_active = true;

-- 3. Customers Table (Gateway-owned Customer Identity with WhatsApp Berry OTP)
CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    mobile_number VARCHAR(20) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    otp_code VARCHAR(10),
    otp_expires_at TIMESTAMPTZ,
    otp_attempts INT NOT NULL DEFAULT 0,
    is_phone_verified BOOLEAN DEFAULT false,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    ban_reason TEXT,
    banned_at TIMESTAMPTZ,
    unbanned_at TIMESTAMPTZ,
    last_device TEXT,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_mobile ON customers (mobile_number);

-- 3b. Customer Sessions Table (Server-authoritative session engine)
CREATE TABLE IF NOT EXISTS customer_sessions (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions (token, is_active);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions (customer_id);

-- 3c. Devices Table (Cryptographic Device Binding & Hardware Context Fingerprinting)
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    public_key TEXT NOT NULL,
    fingerprint_hash VARCHAR(64) NOT NULL,
    user_agent TEXT,
    platform VARCHAR(100),
    browser VARCHAR(100),
    timezone VARCHAR(100),
    language VARCHAR(50),
    screen_signature VARCHAR(100),
    device_token VARCHAR(255) UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices (customer_id);
CREATE INDEX IF NOT EXISTS idx_devices_fingerprint ON devices (fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices (device_token);

-- 4. Payment Sessions Table
CREATE TABLE IF NOT EXISTS payment_sessions (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    receiving_account_id TEXT REFERENCES payment_receiving_accounts(id),
    order_id VARCHAR(255) NOT NULL,
    attempt_id TEXT,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    method VARCHAR(50) NOT NULL DEFAULT 'UPI',
    status VARCHAR(50) NOT NULL DEFAULT 'INITIATED',
    queue_position INT DEFAULT 0,
    slot_acquired_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    processing_started_at TIMESTAMPTZ,
    processing_expires_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    return_url VARCHAR(1024),
    attributed_observation_id TEXT,
    idempotency_key VARCHAR(255),
    device_id TEXT REFERENCES devices(id),
    verification_level INT DEFAULT 0,
    verification_sources TEXT DEFAULT '[]',
    verification_tag VARCHAR(100) DEFAULT 'UNVERIFIED',
    customer_utr TEXT,
    utr_submitted_at TIMESTAMPTZ,
    manual_reviewed_by TEXT,
    manual_reviewed_at TIMESTAMPTZ,
    manual_review_reason TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_active ON payment_sessions (receiving_account_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_order ON payment_sessions (merchant_id, order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_device ON payment_sessions (device_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_session_per_order
  ON payment_sessions (merchant_id, order_id)
  WHERE status NOT IN ('FAILED', 'EXPIRED', 'CANCELLED');
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_slot_per_receiving_account
  ON payment_sessions (receiving_account_id)
  WHERE status IN ('ACTIVE', 'PROCESSING') AND receiving_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_sessions_attributed_obs
  ON payment_sessions (attributed_observation_id)
  WHERE attributed_observation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_upi_utr_per_receiving_account
  ON payment_sessions (receiving_account_id, upper(customer_utr))
  WHERE method = 'MANUAL_UPI' AND customer_utr IS NOT NULL;

-- 5. Payment Observations Table
CREATE TABLE IF NOT EXISTS payment_observations (
    id TEXT PRIMARY KEY,
    receiving_account_id TEXT NOT NULL REFERENCES payment_receiving_accounts(id) ON DELETE CASCADE,
    source VARCHAR(50) NOT NULL,
    amount_paise BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sender_vpa VARCHAR(255),
    bank_reference_number VARCHAR(255),
    fingerprint_hash VARCHAR(64) NOT NULL,
    raw_payload TEXT NOT NULL DEFAULT '{}',
    attribution_status VARCHAR(50) NOT NULL DEFAULT 'UNATTRIBUTED',
    attributed_payment_id TEXT REFERENCES payment_sessions(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observations_match ON payment_observations (receiving_account_id, amount_paise, attribution_status);
CREATE INDEX IF NOT EXISTS idx_observations_bank_ref ON payment_observations (bank_reference_number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_unique_attributed_bank_ref
  ON payment_observations (bank_reference_number)
  WHERE bank_reference_number IS NOT NULL AND attributed_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_observations_fingerprint ON payment_observations (fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_observations_attributed_payment ON payment_observations (attributed_payment_id);

-- 6. Android Devices Table
CREATE TABLE IF NOT EXISTS android_devices (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    device_name VARCHAR(255) NOT NULL,
    device_model VARCHAR(255),
    signing_key_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    last_heartbeat_at TIMESTAMPTZ,
    last_observation_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Webhook Deliveries Table
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    payment_id TEXT NOT NULL REFERENCES payment_sessions(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    payload TEXT NOT NULL,
    endpoint_url VARCHAR(1024) NOT NULL,
    response_status INT,
    response_body TEXT,
    attempt_count INT NOT NULL DEFAULT 1,
    is_successful BOOLEAN NOT NULL DEFAULT false,
    next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries (is_successful, next_retry_at);

-- Durable terminal-event outbox: populated in the same SQLite transaction as the status update.
-- Only NEW terminal transitions are queued; migrations must never replay historic orders.
CREATE TABLE IF NOT EXISTS payment_webhook_outbox (
    payment_id TEXT NOT NULL REFERENCES payment_sessions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN ('SUCCESS','FAILED','EXPIRED','CANCELLED','OBSERVED_SUCCESS','MANUAL_REVIEW','RECONCILED')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (payment_id, event_type)
);

CREATE TRIGGER IF NOT EXISTS trg_terminal_payment_webhook_outbox
AFTER UPDATE OF status ON payment_sessions
WHEN NEW.status IN ('SUCCESS','FAILED','EXPIRED','CANCELLED','OBSERVED_SUCCESS','MANUAL_REVIEW','RECONCILED')
 AND OLD.status != NEW.status
BEGIN
    INSERT OR IGNORE INTO payment_webhook_outbox (payment_id, event_type)
    VALUES (NEW.id, NEW.status);
END;

-- 8. Support Tickets & Ticket Messages
CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    payment_id TEXT REFERENCES payment_sessions(id) ON DELETE SET NULL,
    subject VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'OPEN',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_merchant ON support_tickets (merchant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer ON support_tickets (customer_id);

CREATE TABLE IF NOT EXISTS ticket_messages (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    sender_type VARCHAR(20) NOT NULL,
    sender_id TEXT NOT NULL,
    message TEXT NOT NULL,
    attachments TEXT DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id);

-- 9. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    merchant_id TEXT REFERENCES merchants(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL,
    entity_id TEXT NOT NULL,
    action VARCHAR(100) NOT NULL,
    actor_type VARCHAR(50) NOT NULL,
    actor_id VARCHAR(255),
    details TEXT NOT NULL DEFAULT '{}',
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_merchant ON audit_logs (merchant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);

-- 10. Security Events Table
CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY,
    merchant_id TEXT,
    customer_id TEXT,
    payment_session_id TEXT,
    event_type VARCHAR(100) NOT NULL,
    source VARCHAR(50),
    sender VARCHAR(255),
    device_info TEXT,
    raw_message TEXT NOT NULL,
    normalized_message TEXT,
    extracted_amount VARCHAR(50),
    extracted_reference VARCHAR(100),
    parser_results TEXT DEFAULT '{}',
    verification_results TEXT DEFAULT '{}',
    fraud_reason VARCHAR(255) NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_events_customer ON security_events (customer_id);
CREATE INDEX IF NOT EXISTS idx_security_events_session ON security_events (payment_session_id);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events (event_type);

-- 11. Bank statement lines imported by an operator. Observers do not write this table.
CREATE TABLE IF NOT EXISTS bank_statement_lines (
    id TEXT PRIMARY KEY,
    receiving_account_id TEXT NOT NULL REFERENCES payment_receiving_accounts(id) ON DELETE CASCADE,
    source_hash VARCHAR(64) NOT NULL,
    booked_on DATE NOT NULL,
    amount_paise BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    direction VARCHAR(10) NOT NULL,
    utr VARCHAR(32),
    narration TEXT NOT NULL DEFAULT '',
    match_status VARCHAR(32) NOT NULL,
    match_reason VARCHAR(64),
    payment_session_id TEXT REFERENCES payment_sessions(id),
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_statement_lines_source
  ON bank_statement_lines (receiving_account_id, source_hash);
CREATE INDEX IF NOT EXISTS idx_statement_lines_utr
  ON bank_statement_lines (receiving_account_id, utr);

