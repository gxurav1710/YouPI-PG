-- SQLite Schema for YOUPI PG
-- Native Local / Zero-Dependency Execution

-- 1. Merchants Table
CREATE TABLE IF NOT EXISTS merchants (
    id TEXT PRIMARY KEY,
    business_name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    contact_email TEXT NOT NULL,
    contact_phone TEXT NOT NULL,
    webhook_url TEXT,
    webhook_secret TEXT NOT NULL,
    api_key_hash TEXT,
    branding TEXT NOT NULL DEFAULT '{"primaryColor":"#2563eb","appName":"YOUPI PG","logoUrl":null}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Payment Receiving Accounts
CREATE TABLE IF NOT EXISTS payment_receiving_accounts (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    upi_id TEXT NOT NULL,
    payee_name TEXT NOT NULL,
    is_merchant_enabled INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_slot_busy INTEGER NOT NULL DEFAULT 0,
    current_active_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_vpa_per_merchant ON payment_receiving_accounts (merchant_id) WHERE is_active = 1;

-- 3. Customers Table (Gateway-owned Customer Identity with WhatsApp Berry OTP)
CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    mobile_number TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    otp_code TEXT,
    otp_expires_at TEXT,
    otp_attempts INTEGER NOT NULL DEFAULT 0,
    is_phone_verified INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    ban_reason TEXT,
    banned_at TEXT,
    unbanned_at TEXT,
    last_device TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_mobile ON customers (mobile_number);

-- 3b. Customer Sessions Table (Server-authoritative session engine)
CREATE TABLE IF NOT EXISTS customer_sessions (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions (token, is_active);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions (customer_id);

-- 3c. Devices Table (Cryptographic Device Binding & Hardware Context Fingerprinting)
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

CREATE INDEX IF NOT EXISTS idx_devices_customer ON devices (customer_id);
CREATE INDEX IF NOT EXISTS idx_devices_fingerprint ON devices (fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_devices_token ON devices (device_token);

-- 4. Payment Sessions Table
CREATE TABLE IF NOT EXISTS payment_sessions (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    receiving_account_id TEXT REFERENCES payment_receiving_accounts(id),
    order_id TEXT NOT NULL,
    attempt_id TEXT,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    currency TEXT NOT NULL DEFAULT 'INR',
    method TEXT NOT NULL DEFAULT 'UPI',
    status TEXT NOT NULL DEFAULT 'INITIATED',
    queue_position INTEGER DEFAULT 0,
    slot_acquired_at TEXT,
    expires_at TEXT,
    processing_started_at TEXT,
    processing_expires_at TEXT,
    completed_at TEXT,
    return_url TEXT,
    attributed_observation_id TEXT,
    idempotency_key TEXT,
    device_id TEXT REFERENCES devices(id),
    verification_level INTEGER DEFAULT 0,
    verification_sources TEXT DEFAULT '[]',
    verification_tag TEXT DEFAULT 'UNVERIFIED',
    customer_utr TEXT,
    utr_submitted_at TEXT,
    manual_reviewed_by TEXT,
    manual_reviewed_at TEXT,
    manual_review_reason TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_sessions_active ON payment_sessions (receiving_account_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_order ON payment_sessions (merchant_id, order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_device ON payment_sessions (device_id);
-- At most one active/processing/queued/successful session per merchant order.
-- Retrying a terminal (FAILED, EXPIRED, CANCELLED) order allows a new attempt with the true orderId.
CREATE UNIQUE INDEX IF NOT EXISTS idx_single_active_session_per_order
  ON payment_sessions (merchant_id, order_id)
  WHERE status NOT IN ('FAILED', 'EXPIRED', 'CANCELLED');
-- Slot exclusivity is a database invariant, not an application convention: at most one
-- session per receiving account may occupy the slot (ACTIVE or PROCESSING) at any time.
-- Concurrent writers are rejected by the engine instead of relying on lock contention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_slot_per_receiving_account
  ON payment_sessions (receiving_account_id)
  WHERE status IN ('ACTIVE', 'PROCESSING') AND receiving_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_sessions_attributed_obs
  ON payment_sessions (attributed_observation_id)
  WHERE attributed_observation_id IS NOT NULL;

-- 5. Payment Observations Table
CREATE TABLE IF NOT EXISTS payment_observations (
    id TEXT PRIMARY KEY,
    receiving_account_id TEXT NOT NULL REFERENCES payment_receiving_accounts(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
    sender_vpa TEXT,
    bank_reference_number TEXT,
    fingerprint_hash TEXT NOT NULL,
    raw_payload TEXT NOT NULL DEFAULT '{}',
    attribution_status TEXT NOT NULL DEFAULT 'UNATTRIBUTED',
    attributed_payment_id TEXT REFERENCES payment_sessions(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    device_name TEXT NOT NULL,
    device_model TEXT,
    signing_key_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_heartbeat_at TEXT,
    last_observation_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7. Webhook Deliveries Table
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    payment_id TEXT NOT NULL REFERENCES payment_sessions(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    endpoint_url TEXT NOT NULL,
    response_status INTEGER,
    response_body TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    is_successful INTEGER NOT NULL DEFAULT 0,
    next_retry_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_merchant ON support_tickets (merchant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer ON support_tickets (customer_id);

CREATE TABLE IF NOT EXISTS ticket_messages (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    message TEXT NOT NULL,
    attachments TEXT DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages (ticket_id);

-- 9. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    merchant_id TEXT REFERENCES merchants(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_merchant ON audit_logs (merchant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);

-- 10. Security Events Table (Forensic evidence for fraud, automatic and manual bans)
CREATE TABLE IF NOT EXISTS security_events (
    id TEXT PRIMARY KEY,
    merchant_id TEXT,
    customer_id TEXT,
    payment_session_id TEXT,
    event_type TEXT NOT NULL,
    source TEXT,
    sender TEXT,
    device_info TEXT,
    raw_message TEXT NOT NULL,
    normalized_message TEXT,
    extracted_amount TEXT,
    extracted_reference TEXT,
    parser_results TEXT DEFAULT '{}',
    verification_results TEXT DEFAULT '{}',
    fraud_reason TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_security_events_customer ON security_events (customer_id);
CREATE INDEX IF NOT EXISTS idx_security_events_session ON security_events (payment_session_id);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events (event_type);

-- 11. Bank statement lines imported by an operator. Observers do not write this table.
CREATE TABLE IF NOT EXISTS bank_statement_lines (
    id TEXT PRIMARY KEY,
    receiving_account_id TEXT NOT NULL REFERENCES payment_receiving_accounts(id) ON DELETE CASCADE,
    source_hash TEXT NOT NULL,
    booked_on TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    direction TEXT NOT NULL,
    utr TEXT,
    narration TEXT NOT NULL DEFAULT '',
    match_status TEXT NOT NULL,
    match_reason TEXT,
    payment_session_id TEXT REFERENCES payment_sessions(id),
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_statement_lines_source
  ON bank_statement_lines (receiving_account_id, source_hash);
CREATE INDEX IF NOT EXISTS idx_statement_lines_utr
  ON bank_statement_lines (receiving_account_id, utr);


