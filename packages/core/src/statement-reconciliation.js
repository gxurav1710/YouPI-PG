import crypto from 'node:crypto';
import { PaymentStatus } from '@youpi/common';
import { parseStatementCsv } from './statement-parser.js';

/** Statement value date may post on the observation day or the next two calendar days. */
export const STATEMENT_POSTING_DAYS = 2;

export function calendarDateInIndia(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

function addCalendarDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sourceHash(receivingAccountId, line) {
  return crypto.createHash('sha256').update([
    receivingAccountId,
    line.bookedOn || '',
    String(line.amountPaise),
    line.direction,
    line.utr || '',
    line.referenceCount,
    line.narration
  ].join('|')).digest('hex');
}

function sameAmount(session, amountPaise) {
  return BigInt(session.amountPaise) === BigInt(amountPaise);
}

/**
 * Applies operator-imported statement lines. An observer alert cannot call this.
 * RECONCILED is written only when one session on the same receiving account has
 * the same paise amount and the same 12-digit reference, inside the posting window.
 */
export class StatementReconciliation {
  constructor({ db, sessionRepo, auditRepo = null, eventEmitter = null }) {
    this.db = db;
    this.sessionRepo = sessionRepo;
    this.auditRepo = auditRepo;
    this.eventEmitter = eventEmitter;
  }

  importCsv({ receivingAccountId, csvText }) {
    const parsed = parseStatementCsv(csvText);
    if (parsed.error) return { error: parsed.error, lines: [] };
    const lines = parsed.lines.map(line => this.applyLine(receivingAccountId, line));
    return {
      lines,
      reconciled: lines.filter(line => line.outcome === 'RECONCILED').length,
      conflicts: lines.filter(line => line.outcome === 'CONFLICT').length,
      unmatched: lines.filter(line => line.outcome === 'UNMATCHED').length
    };
  }

  applyLine(receivingAccountId, line) {
    const hash = sourceHash(receivingAccountId, line);
    const existing = this.db.queryOne(
      'SELECT * FROM bank_statement_lines WHERE receiving_account_id = ? AND source_hash = ?',
      [receivingAccountId, hash]
    );
    if (existing && existing.match_status === 'RECONCILED') {
      return {
        outcome: 'DUPLICATE',
        matchStatus: 'RECONCILED',
        paymentSessionId: existing.payment_session_id,
        statementLineId: existing.id,
        utr: existing.utr
      };
    }

    const rowId = existing?.id || crypto.randomUUID();
    if (!existing) {
      this.db.execute(`
        INSERT INTO bank_statement_lines (
          id, receiving_account_id, source_hash, booked_on, amount_paise, currency,
          direction, utr, narration, match_status, match_reason, payment_session_id, imported_at
        ) VALUES (?, ?, ?, ?, ?, 'INR', ?, ?, ?, 'UNMATCHED', NULL, NULL, ?)
      `, [
        rowId,
        receivingAccountId,
        hash,
        line.bookedOn,
        line.amountPaise,
        line.direction,
        line.utr,
        line.narration,
        new Date().toISOString()
      ]);
    }

    if (line.direction !== 'CREDIT') {
      return this.finish(rowId, 'IGNORED', 'DEBIT', null);
    }
    if (!line.utr) {
      const reason = line.referenceCount > 1 ? 'AMBIGUOUS_REFERENCE' : 'MISSING_REFERENCE';
      return this.finish(rowId, 'CONFLICT', reason, null);
    }

    const already = this.findReconciled(receivingAccountId, line);
    if (already) {
      return this.finish(rowId, 'RECONCILED', 'ALREADY_RECONCILED', already.id, { emit: false });
    }

    const attributed = this.findAttributed(receivingAccountId, line.utr)
      .filter(session => session.currency === 'INR' || !session.currency);
    const exact = attributed.filter(session => sameAmount(session, line.amountPaise));
    const amountConflicts = attributed.filter(session => !sameAmount(session, line.amountPaise));

    if (exact.length > 1 || amountConflicts.length > 0) {
      this.holdAll([...exact, ...amountConflicts], 'STATEMENT_AMOUNT_OR_DUPLICATE');
      return this.finish(rowId, 'CONFLICT', exact.length > 1 ? 'MULTIPLE_SESSIONS' : 'AMOUNT_MISMATCH', null);
    }
    if (exact.length === 1) {
      const session = exact[0];
      const observedOn = this.observedCalendarDate(session);
      if (!observedOn || !this.withinPostingWindow(observedOn, line.bookedOn)) {
        this.holdAll([session], 'STATEMENT_DATE_OUTSIDE_WINDOW');
        return this.finish(rowId, 'CONFLICT', 'STATEMENT_DATE_OUTSIDE_WINDOW', null);
      }
      return this.reconcile(rowId, session);
    }

    const held = this.findManualReviewByAmount(receivingAccountId, line.amountPaise);
    const seen = this.observationsForReference(receivingAccountId, line);
    if (held.length === 1 && seen.length >= 1) {
      const observedOn = calendarDateInIndia(seen[0].observed_at);
      if (!observedOn || !this.withinPostingWindow(observedOn, line.bookedOn)) {
        return this.finish(rowId, 'CONFLICT', 'STATEMENT_DATE_OUTSIDE_WINDOW', null);
      }
      return this.reconcile(rowId, held[0], seen[0]);
    }
    if (held.length > 1 && seen.length >= 1) {
      return this.finish(rowId, 'CONFLICT', 'MULTIPLE_SESSIONS', null);
    }
    if (seen.length >= 1) {
      let candidateSessionId = seen[0].attributed_payment_id || null;
      if (!candidateSessionId && seen[0].raw_payload) {
        try {
          const parsedPayload = typeof seen[0].raw_payload === 'string'
            ? JSON.parse(seen[0].raw_payload)
            : seen[0].raw_payload;
          candidateSessionId = parsedPayload?.lateMatchedSessionId || parsedPayload?.targetSessionId || null;
        } catch {}
      }
      this.auditRepo?.log({
        entityType: 'PAYMENT_OBSERVATION',
        entityId: seen[0].id,
        action: 'UNMATCHED_STATEMENT_OBSERVATION_CORROBORATED',
        actorType: 'ADMIN',
        details: {
          statementLineId: rowId,
          receivingAccountId,
          utr: line.utr,
          amountPaise: String(line.amountPaise),
          attributionStatus: seen[0].attribution_status,
          candidatePaymentSessionId: candidateSessionId
        }
      });
      this.eventEmitter?.emit('PAYMENT.UNMATCHED_RECONCILIATION_NEEDED', {
        receivingAccountId,
        observationId: seen[0].id,
        candidatePaymentSessionId: candidateSessionId,
        utr: line.utr,
        amountPaise: BigInt(line.amountPaise),
        statementLineId: rowId
      });
      return this.finish(rowId, 'UNMATCHED', 'NO_OBSERVED_SESSION', null, {
        observationId: seen[0].id,
        candidatePaymentSessionId: candidateSessionId
      });
    }
    return this.finish(rowId, 'UNMATCHED', 'NO_OBSERVED_SESSION', null);
  }

  withinPostingWindow(observedOn, bookedOn) {
    return bookedOn >= observedOn && bookedOn <= addCalendarDays(observedOn, STATEMENT_POSTING_DAYS);
  }

  observedCalendarDate(session) {
    const row = this.db.queryOne(
      'SELECT observed_at FROM payment_observations WHERE id = ? OR attributed_payment_id = ? ORDER BY observed_at ASC LIMIT 1',
      [session.attributedObservationId || '', session.id]
    );
    return calendarDateInIndia(row?.observed_at || session.completedAt || session.createdAt);
  }

  findAttributed(receivingAccountId, utr) {
    const rows = this.db.query(`
      SELECT DISTINCT ps.*
      FROM payment_sessions ps
      JOIN payment_observations po
        ON po.attributed_payment_id = ps.id OR ps.attributed_observation_id = po.id
      WHERE ps.receiving_account_id = ?
        AND ps.status IN ('OBSERVED_SUCCESS', 'MANUAL_REVIEW')
        AND po.bank_reference_number = ?
    `, [receivingAccountId, utr]);
    return rows.map(row => this.sessionRepo.mapRow(row));
  }

  findReconciled(receivingAccountId, line) {
    const row = this.db.queryOne(`
      SELECT ps.*
      FROM payment_sessions ps
      JOIN payment_observations po
        ON po.attributed_payment_id = ps.id OR ps.attributed_observation_id = po.id
      WHERE ps.receiving_account_id = ?
        AND ps.status = 'RECONCILED'
        AND ps.amount_paise = ?
        AND po.bank_reference_number = ?
      LIMIT 1
    `, [receivingAccountId, line.amountPaise, line.utr]);
    return row ? this.sessionRepo.mapRow(row) : null;
  }

  findManualReviewByAmount(receivingAccountId, amountPaise) {
    const rows = this.db.query(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status = 'MANUAL_REVIEW' AND amount_paise = ?
    `, [receivingAccountId, amountPaise]);
    return rows.map(row => this.sessionRepo.mapRow(row));
  }

  observationsForReference(receivingAccountId, line) {
    return this.db.query(`
      SELECT id, observed_at, attribution_status, attributed_payment_id, raw_payload
      FROM payment_observations
      WHERE receiving_account_id = ? AND bank_reference_number = ? AND amount_paise = ?
      ORDER BY observed_at ASC
    `, [receivingAccountId, line.utr, line.amountPaise]);
  }

  holdAll(sessions, reason) {
    for (const session of sessions) {
      if (session.status !== PaymentStatus.OBSERVED_SUCCESS && session.status !== PaymentStatus.MANUAL_REVIEW) continue;
      const before = session.status;
      try {
        const updated = this.sessionRepo.transitionToTerminal(session.id, PaymentStatus.MANUAL_REVIEW);
        if (before !== PaymentStatus.MANUAL_REVIEW && updated.status === PaymentStatus.MANUAL_REVIEW) {
          this.eventEmitter?.emit('PAYMENT.MANUAL_REVIEW', {
            paymentId: session.id,
            orderId: session.orderId,
            merchantId: session.merchantId,
            reason
          });
        }
      } catch {
        // An illegal edge leaves the session unreconciled. The statement row records the conflict.
      }
    }
  }

  reconcile(rowId, session, matchedObs = null) {
    const before = session.status;
    const updated = this.sessionRepo.transitionToTerminal(session.id, PaymentStatus.RECONCILED);
    if (updated.status !== PaymentStatus.RECONCILED) {
      return this.finish(rowId, 'CONFLICT', 'TRANSITION_REJECTED', null);
    }
    if (matchedObs?.id) {
      try {
        this.db.execute(
          `UPDATE payment_observations
           SET attribution_status = 'ATTRIBUTED',
               attributed_payment_id = COALESCE(attributed_payment_id, ?)
           WHERE id = ?`,
          [session.id, matchedObs.id]
        );
        this.db.execute(
          `UPDATE payment_sessions
           SET attributed_observation_id = COALESCE(attributed_observation_id, ?)
           WHERE id = ?`,
          [matchedObs.id, session.id]
        );
      } catch {
        // If another observation already holds the unique UTR attribution index, still mark ATTRIBUTED
        this.db.execute(
          `UPDATE payment_observations SET attribution_status = 'ATTRIBUTED' WHERE id = ?`,
          [matchedObs.id]
        );
      }
    }
    const emit = before !== PaymentStatus.RECONCILED;
    return this.finish(rowId, 'RECONCILED', 'BANK_STATEMENT_MATCH', updated.id, { emit, session: updated });
  }

  finish(rowId, matchStatus, matchReason, paymentSessionId, options = {}) {
    this.db.execute(`
      UPDATE bank_statement_lines
      SET match_status = ?, match_reason = ?, payment_session_id = ?
      WHERE id = ?
    `, [matchStatus, matchReason, paymentSessionId, rowId]);
    if (options.emit && options.session) {
      this.auditRepo?.log({
        merchantId: options.session.merchantId,
        entityType: 'PAYMENT_SESSION',
        entityId: options.session.id,
        action: 'BANK_STATEMENT_RECONCILED',
        actorType: 'ADMIN',
        details: { statementLineId: rowId, amountPaise: options.session.amountPaise.toString() }
      });
      this.eventEmitter?.emit('PAYMENT.RECONCILED', {
        paymentId: options.session.id,
        orderId: options.session.orderId,
        merchantId: options.session.merchantId,
        amountPaise: options.session.amountPaise,
        statementLineId: rowId
      });
    }
    return {
      outcome: matchStatus === 'RECONCILED' && options.emit === false && matchReason === 'ALREADY_RECONCILED'
        ? 'DUPLICATE'
        : matchStatus,
      matchStatus,
      matchReason,
      paymentSessionId,
      statementLineId: rowId,
      ...(options.observationId ? { observationId: options.observationId } : {}),
      ...(options.candidatePaymentSessionId ? { candidatePaymentSessionId: options.candidatePaymentSessionId } : {})
    };
  }
}
