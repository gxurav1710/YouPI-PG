import crypto from 'node:crypto';
import { PaymentStatus, PaymentMethod, isValidTransition, TERMINAL_STATES, IMMUTABLE_STATES } from '@youpi/common';

export class PaymentSessionRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const metadata = typeof data.metadata === 'object' ? JSON.stringify(data.metadata) : (data.metadata || '{}');
    const attemptId = data.attemptId || id;

    const sql = `
      INSERT INTO payment_sessions (
        id, merchant_id, customer_id, receiving_account_id, order_id, attempt_id,
        amount_paise, currency, method, status, queue_position,
        return_url, idempotency_key, device_id, verification_level, verification_sources,
        verification_tag, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', 'UNVERIFIED', ?, ?, ?)
    `;

    this.db.execute(sql, [
      id,
      data.merchantId,
      data.customerId || null,
      data.receivingAccountId || null,
      data.orderId,
      attemptId,
      Number(data.amountPaise),
      data.currency || 'INR',
      data.method || PaymentMethod.UPI,
      data.status || PaymentStatus.INITIATED,
      data.queuePosition || 0,
      data.returnUrl || null,
      data.idempotencyKey || null,
      data.deviceId || null,
      metadata,
      now,
      now
    ]);

    return this.findById(id);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM payment_sessions WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  findByOrderId(merchantId, orderId) {
    // The schema allows a second row for the same (merchant, order) once the previous one
    // is terminal, so the newest row must win. Without an explicit ordering a stale
    // terminal row could be returned and the caller would miss a SUCCESS session.
    const row = this.db.queryOne(
      'SELECT * FROM payment_sessions WHERE merchant_id = ? AND order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      [merchantId, orderId]
    );
    if (!row) return null;
    return this.mapRow(row);
  }

  findByCustomerId(customerId) {
    const rows = this.db.query(
      'SELECT * FROM payment_sessions WHERE customer_id = ? ORDER BY created_at DESC',
      [customerId]
    );
    return rows.map(r => this.mapRow(r));
  }

  findByMerchantId(merchantId, limit = 50) {
    const rows = this.db.query(
      'SELECT * FROM payment_sessions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?',
      [merchantId, limit]
    );
    return rows.map(r => this.mapRow(r));
  }

  /**
   * Atomic slot acquisition transaction for UPI payments.
   * Invariant: Only ONE active or processing session per receiving account.
   * If slot is free, session transitions to ACTIVE with 5:00 window.
   * If slot is occupied, session transitions to QUEUED with sequence position.
   */
  acquireSlotAtomic(sessionId, receivingAccountId, durationMs = 300000) {
    if (!receivingAccountId) {
      throw new Error('receivingAccountId is mandatory for acquiring an active payment slot');
    }

    const runAcquisition = () => {
      return this.db.transaction(() => {
      const now = new Date();
      const nowIso = now.toISOString();

      // Check for current active or processing session on this receiving account
      let activeRow = this.db.queryOne(`
        SELECT id, status, expires_at, processing_expires_at
        FROM payment_sessions
        WHERE receiving_account_id = ? AND status IN (?, ?)
        LIMIT 1
      `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

      if (activeRow) {
        const isStale = (activeRow.status === PaymentStatus.ACTIVE && activeRow.expires_at && new Date(activeRow.expires_at) <= now) ||
          (activeRow.status === PaymentStatus.PROCESSING && activeRow.processing_expires_at && new Date(activeRow.processing_expires_at) <= now);
        if (isStale) {
          const terminalStatus = activeRow.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
          if (!isValidTransition(activeRow.status, terminalStatus)) {
            throw new Error(`Illegal payment state transition: cannot move from '${activeRow.status}' to '${terminalStatus}'.`);
          }
          this.db.execute(`
            UPDATE payment_sessions
            SET status = ?, completed_at = ?, updated_at = ?
            WHERE id = ?
          `, [terminalStatus, nowIso, nowIso, activeRow.id]);
          activeRow = null;
        }
      }

      // CRITICAL GUARD: If activeRow is THIS session itself, it's ALREADY ACTIVE! Do not demote to QUEUED!
      if (activeRow && activeRow.id === sessionId) {
        return {
          status: PaymentStatus.ACTIVE,
          queuePosition: 0,
          expiresAt: activeRow.expires_at ? new Date(activeRow.expires_at) : new Date(now.getTime() + durationMs)
        };
      }

      if (!activeRow) {
        // Slot is vacant! Grant ACTIVE slot.
        // Enforce the transition graph: a terminal or PROCESSING session must never be
        // revived to ACTIVE by a concurrent queue tick.
        const currentStatus = this.findById(sessionId)?.status;
        if (currentStatus && !isValidTransition(currentStatus, PaymentStatus.ACTIVE)) {
          throw new Error(`Illegal payment state transition: cannot move from '${currentStatus}' to 'ACTIVE'.`);
        }

        const expiresAt = new Date(now.getTime() + durationMs).toISOString();

        try {
          this.db.execute(`
            UPDATE payment_sessions
            SET status = ?, slot_acquired_at = ?, expires_at = ?, queue_position = 0, updated_at = ?
            WHERE id = ?
          `, [PaymentStatus.ACTIVE, nowIso, expiresAt, nowIso, sessionId]);

          // Mark receiving account as busy
          this.db.execute(`
            UPDATE payment_receiving_accounts
            SET is_slot_busy = 1, current_active_session_id = ?, updated_at = ?
            WHERE id = ?
          `, [sessionId, nowIso, receivingAccountId]);

          return {
            status: PaymentStatus.ACTIVE,
            queuePosition: 0,
            expiresAt: new Date(expiresAt)
          };
        } catch (slotErr) {
          if (slotErr.message && (slotErr.message.includes('idx_one_slot_per_receiving_account') || slotErr.message.includes('idx_single_active_session') || slotErr.message.includes('UNIQUE constraint failed'))) {
            activeRow = this.db.queryOne(`
              SELECT id, status, expires_at FROM payment_sessions
              WHERE receiving_account_id = ? AND status IN (?, ?) LIMIT 1
            `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);
          } else {
            throw slotErr;
          }
        }
      } else {
        // Slot is busy! Place in QUEUED
        const existingSession = this.findById(sessionId);
        let queuePosition = existingSession?.queuePosition;
        if (!queuePosition || queuePosition <= 0) {
          const posRow = this.db.queryOne(`
            SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_pos
            FROM payment_sessions
            WHERE receiving_account_id = ? AND status = ?
          `, [receivingAccountId, PaymentStatus.QUEUED]);

          queuePosition = posRow ? posRow.next_pos : 1;
        }

        if (existingSession && existingSession.status !== PaymentStatus.QUEUED && !isValidTransition(existingSession.status, PaymentStatus.QUEUED)) {
          throw new Error(`Illegal payment state transition: cannot move from '${existingSession.status}' to 'QUEUED'.`);
        }

        this.db.execute(`
          UPDATE payment_sessions
          SET status = ?, queue_position = ?, updated_at = ?
          WHERE id = ?
        `, [PaymentStatus.QUEUED, queuePosition, nowIso, sessionId]);

        return {
          status: PaymentStatus.QUEUED,
          queuePosition,
          expiresAt: null
        };
      }
    }, { mode: 'IMMEDIATE' });
  };

  return typeof this.db.withRetry === 'function'
    ? this.db.withRetry(runAcquisition)
    : runAcquisition();
}

  /**
   * Transitions an ACTIVE session to PROCESSING upon customer clicking Payment Done.
   * Starts independent 30-second verification timer.
   */
  transitionToProcessing(sessionId, durationMs = 30000) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      // Idempotency: if already processing, return existing
      if (session.status === PaymentStatus.PROCESSING) {
        return session;
      }

      if (session.status !== PaymentStatus.ACTIVE) {
        throw new Error(`Cannot transition to PROCESSING from status: ${session.status}`);
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const processingExpiresAt = new Date(now.getTime() + durationMs).toISOString();

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?, processing_started_at = ?, processing_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `, [PaymentStatus.PROCESSING, nowIso, processingExpiresAt, nowIso, sessionId, PaymentStatus.ACTIVE]);

      return this.findById(sessionId);
    });
  }

  /**
   * Transitions session to terminal state (SUCCESS, FAILED, EXPIRED, CANCELLED).
   * Atomically releases receiving account slot.
   */
  transitionToTerminal(sessionId, targetStatus, options = {}) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);

      // Immutable outcomes stay put. OBSERVED_SUCCESS and MANUAL_REVIEW may still
      // move to RECONCILED later, but only by an explicit statement workflow.
      if (IMMUTABLE_STATES.includes(session.status) || session.status === targetStatus) {
        return session;
      }

      if (!TERMINAL_STATES.includes(targetStatus)) {
        throw new Error(`Not a terminal target status: ${targetStatus}`);
      }
      if (!isValidTransition(session.status, targetStatus)) {
        throw new Error(`Illegal payment state transition: cannot move from '${session.status}' to '${targetStatus}'.`);
      }

      const now = new Date().toISOString();
      const completedAtIso = session.completedAt ? new Date(session.completedAt).toISOString() : now;
      const attributedObsId = options.attributedObservationId || session.attributedObservationId || null;

      let metadata = session.metadata || {};
      if (typeof metadata === 'string') {
        try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
      }
      if (options.reason) {
        metadata = { ...metadata, cancelledReason: options.reason };
      }
      if (options.replacedByDeviceId) {
        metadata = { ...metadata, replacedByDeviceId: options.replacedByDeviceId };
      }
      if (options.replacedBySessionId) {
        metadata = { ...metadata, replacedBySessionId: options.replacedBySessionId };
      }
      if (options.replacedByDeviceId) {
        metadata = { ...metadata, replacedByDeviceId: options.replacedByDeviceId };
      }
      if (options.replacedBySessionId) {
        metadata = { ...metadata, replacedBySessionId: options.replacedBySessionId };
      }

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?, completed_at = ?, attributed_observation_id = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `, [targetStatus, completedAtIso, attributedObsId, JSON.stringify(metadata), now, sessionId]);

      // Release slot on receiving account if this session owned it
      if (session.receivingAccountId) {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND (current_active_session_id = ? OR current_active_session_id IS NULL)
        `, [now, session.receivingAccountId, sessionId]);
      }

      return this.findById(sessionId);
    });
  }

  /** Record a customer supplied UTR without treating it as payment evidence. */
  submitManualUtr(sessionId, rawUtr) {
    const utr = String(rawUtr || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{6,35}$/.test(utr)) {
      throw new Error('Enter a valid UPI reference (6–35 letters or digits).');
    }
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error('Session not found');
      if (session.method !== PaymentMethod.MANUAL_UPI) throw new Error('Manual UTR submission is not enabled for this payment.');
      if (session.status === PaymentStatus.MANUAL_REVIEW && session.customerUtr === utr) return session;
      if (session.status !== PaymentStatus.ACTIVE) throw new Error('This payment is no longer accepting a UTR.');
      if (!isValidTransition(session.status, PaymentStatus.MANUAL_REVIEW)) {
        throw new Error(`Illegal payment state transition: cannot move from '${session.status}' to '${PaymentStatus.MANUAL_REVIEW}'.`);
      }
      const now = new Date().toISOString();
      this.db.execute(`
        UPDATE payment_sessions
        SET customer_utr = ?, utr_submitted_at = ?, status = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `, [utr, now, PaymentStatus.MANUAL_REVIEW, now, now, sessionId, PaymentStatus.ACTIVE]);
      const updated = this.findById(sessionId);
      if (updated.status !== PaymentStatus.MANUAL_REVIEW || updated.customerUtr !== utr) {
        throw new Error('Payment state changed; refresh and try again.');
      }
      if (session.receivingAccountId) {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND current_active_session_id = ?
        `, [now, session.receivingAccountId, sessionId]);
      }
      return updated;
    });
  }

  findCurrentActiveOrProcessing(receivingAccountId) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status IN (?, ?)
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findCurrentActiveOrProcessingForMerchant(merchantId) {
    if (!merchantId) return null;
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE merchant_id = ? AND status IN (?, ?)
      ORDER BY created_at DESC
      LIMIT 1
    `, [merchantId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING]);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findActiveForCustomer(customerId, excludeSessionId = null) {
    if (!customerId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE customer_id = ? AND status IN (?, ?, ?)
    `;
    const params = [customerId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findActiveForDevice(deviceId, excludeSessionId = null) {
    if (!deviceId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE device_id = ? AND status IN (?, ?, ?)
    `;
    const params = [deviceId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findConflictingActiveSession({ customerId = null, deviceId = null, excludeSessionId = null }) {
    if (!customerId && !deviceId) return null;
    let query = `
      SELECT * FROM payment_sessions
      WHERE status IN (?, ?, ?)
    `;
    const params = [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED];
    if (excludeSessionId) {
      query += ` AND id != ? `;
      params.push(excludeSessionId);
    }
    if (customerId && deviceId) {
      query += ` AND (customer_id = ? OR device_id = ?) `;
      params.push(customerId, deviceId);
    } else if (customerId) {
      query += ` AND customer_id = ? `;
      params.push(customerId);
    } else {
      query += ` AND device_id = ? `;
      params.push(deviceId);
    }
    query += ` ORDER BY created_at DESC LIMIT 1 `;
    const row = this.db.queryOne(query, params);

    if (!row) return null;
    const now = new Date();
    const isStale = (row.status === PaymentStatus.ACTIVE && row.expires_at && new Date(row.expires_at) <= now) ||
      (row.status === PaymentStatus.PROCESSING && row.processing_expires_at && new Date(row.processing_expires_at) <= now);
    if (isStale) {
      const terminalStatus = row.status === PaymentStatus.PROCESSING ? PaymentStatus.FAILED : PaymentStatus.EXPIRED;
      this.transitionToTerminal(row.id, terminalStatus);
      return null;
    }
    return this.mapRow(row);
  }

  findAllActiveOrPendingForCustomer(customerId) {
    if (!customerId) return [];
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE customer_id = ? AND status IN (?, ?, ?, ?)
      ORDER BY created_at DESC
    `, [customerId, PaymentStatus.ACTIVE, PaymentStatus.PROCESSING, PaymentStatus.QUEUED, PaymentStatus.INITIATED]);
    return rows.map(r => this.mapRow(r));
  }

  findQueuedSessions(receivingAccountId) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = ?
      ORDER BY queue_position ASC, created_at ASC
    `, [receivingAccountId, PaymentStatus.QUEUED]);

    return rows.map(r => this.mapRow(r));
  }

  getNextQueuedSession(receivingAccountId) {
    const row = this.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = ?
      ORDER BY queue_position ASC, created_at ASC
      LIMIT 1
    `, [receivingAccountId, PaymentStatus.QUEUED]);

    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Re-indexes remaining queued sessions after a promotion.
   */
  reindexQueue(receivingAccountId) {
    const queued = this.findQueuedSessions(receivingAccountId);
    let pos = 1;
    for (const session of queued) {
      this.db.execute(`
        UPDATE payment_sessions SET queue_position = ?, updated_at = ?
        WHERE id = ?
      `, [pos++, new Date().toISOString(), session.id]);
    }
  }

  findRecentlyExpiredOrFailed(receivingAccountId, sinceDate) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ?
        AND status IN (?, ?, ?)
        AND updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT 20
    `, [receivingAccountId, PaymentStatus.EXPIRED, PaymentStatus.FAILED, PaymentStatus.CANCELLED, sinceDate.toISOString()]);

    return rows.map(r => this.mapRow(r));
  }

  /**
   * Records observation confirmation, calculates 2-level verification tier (SMS + Gmail),
   * updates the verification tag, and transitions to SUCCESS if level >= 1 and shouldFinalize is true.
   * @param {string} sessionId
   * @param {string} source E.g. 'GMAIL', 'GOOGLE_MESSAGES'
   * @param {string} observationId
   * @param {{ finalizeSuccess?: boolean }} [options={}]
   * @returns {{ session: any, level: number, sources: string[], tag: string, isFirstSuccess: boolean }}
   */
  recordVerificationSource(sessionId, source, observationId, options = {}) {
    return this.db.transaction(() => {
      const session = this.findById(sessionId);
      if (!session) throw new Error(`Payment session not found: ${sessionId}`);

      // A dead outcome is final. recordVerificationSource is called from the attribution engine
      // on previously attributed sessions with no status check, so without this guard an
      // out-of-window or duplicated observation flips an EXPIRED/FAILED/CANCELLED session back
      // to SUCCESS and emits a webhook for a payment that was never settled.
      // An already-SUCCESS session is NOT blocked: recording a second channel there is the
      // legitimate SMS+Gmail verification upgrade, which must not re-emit SUCCESS.
      const DEAD_STATES = [
        PaymentStatus.FAILED,
        PaymentStatus.EXPIRED,
        PaymentStatus.CANCELLED,
        PaymentStatus.MANUAL_REVIEW,
        PaymentStatus.RECONCILED
      ];
      if (DEAD_STATES.includes(session.status)) {
        return {
          session,
          level: session.verificationLevel || 0,
          sources: session.verificationSources || [],
          tag: session.verificationTag || 'UNVERIFIED',
          isFirstSuccess: false
        };
      }

      // Read current verification sources
      const sourcesSet = new Set(session.verificationSources || []);
      sourcesSet.add(source);
      const sources = Array.from(sourcesSet);

      const level = Math.min(2, sources.length); // 1 or 2 (2-Layer Engine: SMS + Gmail)
      const sourceLabels = sources.map(s => {
        if (s === 'GOOGLE_MESSAGES') return 'SMS';
        if (s === 'GMAIL') return 'Gmail';
        return s;
      });

      let tag = `Single Verification (${sourceLabels.join(', ')})`;
      if (level >= 2) {
        tag = `Dual Verification (${sourceLabels.join(' + ')})`;
      }

      const alreadyClosed = session.status === PaymentStatus.OBSERVED_SUCCESS
        || session.status === PaymentStatus.SUCCESS
        || session.status === PaymentStatus.RECONCILED;
      const shouldFinalize = options.finalizeSuccess !== false;
      const wantsObserved = shouldFinalize && level >= 1 && !alreadyClosed;
      if (wantsObserved && !isValidTransition(session.status, PaymentStatus.OBSERVED_SUCCESS)) {
        throw new Error(`Illegal payment state transition: cannot move from '${session.status}' to 'OBSERVED_SUCCESS'.`);
      }
      const isFirstSuccess = wantsObserved;
      const targetStatus = wantsObserved ? PaymentStatus.OBSERVED_SUCCESS : session.status;
      if (wantsObserved) {
        tag = `${tag} | OBSERVED_NOT_RECONCILED`;
      }
      const now = new Date().toISOString();

      this.db.execute(`
        UPDATE payment_sessions
        SET status = ?,
            verification_level = ?,
            verification_sources = ?,
            verification_tag = ?,
            attributed_observation_id = COALESCE(attributed_observation_id, ?),
            completed_at = COALESCE(completed_at, ?),
            updated_at = ?
        WHERE id = ?
      `, [
        targetStatus,
        level,
        JSON.stringify(sources),
        tag,
        observationId,
        targetStatus === PaymentStatus.OBSERVED_SUCCESS ? now : null,
        now,
        sessionId
      ]);

      // If this transition made it terminal SUCCESS, release slot on receiving account
      if (targetStatus === PaymentStatus.OBSERVED_SUCCESS && session.receivingAccountId) {
        this.db.execute(`
          UPDATE payment_receiving_accounts
          SET is_slot_busy = 0, current_active_session_id = NULL, updated_at = ?
          WHERE id = ? AND current_active_session_id = ?
        `, [now, session.receivingAccountId, sessionId]);
      }

      const updated = this.findById(sessionId);
      return {
        session: updated,
        level,
        sources,
        tag,
        isFirstSuccess
      };
    });
  }

  bindDevice(sessionId, deviceId) {
    const now = new Date().toISOString();
    this.db.execute(
      'UPDATE payment_sessions SET device_id = ?, updated_at = ? WHERE id = ?',
      [deviceId, now, sessionId]
    );
    return this.findById(sessionId);
  }

  mapRow(row) {
    return {
      id: row.id,
      merchantId: row.merchant_id,
      customerId: row.customer_id,
      receivingAccountId: row.receiving_account_id,
      orderId: row.order_id,
      attemptId: row.attempt_id || row.id,
      amountPaise: BigInt(row.amount_paise),
      currency: row.currency,
      method: row.method,
      status: row.status,
      queuePosition: row.queue_position,
      slotAcquiredAt: row.slot_acquired_at ? new Date(row.slot_acquired_at) : null,
      expiresAt: row.expires_at ? new Date(row.expires_at) : null,
      processingStartedAt: row.processing_started_at ? new Date(row.processing_started_at) : null,
      processingExpiresAt: row.processing_expires_at ? new Date(row.processing_expires_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
      returnUrl: row.return_url,
      attributedObservationId: row.attributed_observation_id,
      idempotencyKey: row.idempotency_key,
      deviceId: row.device_id || null,
      verificationLevel: row.verification_level !== undefined && row.verification_level !== null ? Number(row.verification_level) : 0,
      verificationSources: JSON.parse(row.verification_sources || '[]'),
      verificationTag: row.verification_tag || 'UNVERIFIED',
      customerUtr: row.customer_utr || null,
      utrSubmittedAt: row.utr_submitted_at ? new Date(row.utr_submitted_at) : null,
      manualReviewedBy: row.manual_reviewed_by || null,
      manualReviewedAt: row.manual_reviewed_at ? new Date(row.manual_reviewed_at) : null,
      manualReviewReason: row.manual_review_reason || null,
      metadata: JSON.parse(row.metadata || '{}'),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }
}

