import { PaymentStatus, ObservationAttributionStatus, TicketStatus, SenderType, isTerminalStatus, calculateObservationFingerprint } from '@youpi/common';

export function getChannelFamily(source) {
  const normalized = String(source || '').trim().toUpperCase();
  if (normalized === 'GMAIL') return 'GMAIL';
  if (['SMS', 'SMS_GATEWAY', 'GOOGLE_MESSAGES', 'ANDROID_OBSERVER'].includes(normalized)) {
    return 'SMS';
  }
  return normalized || 'SMS';
}

export class AttributionEngine {
  /**
   * @param {{
   *   sessionRepo: import('@youpi/db').PaymentSessionRepository,
   *   obsRepo: import('@youpi/db').ObservationRepository,
   *   ticketRepo?: import('@youpi/db').SupportTicketRepository,
   *   auditRepo?: import('@youpi/db').AuditLogRepository,
   *   eventEmitter?: { emit: (event: string, payload: any) => void }
   * }} options
   */
  constructor(options) {
    this.sessionRepo = options.sessionRepo;
    this.obsRepo = options.obsRepo;
    this.ticketRepo = options.ticketRepo;
    this.auditRepo = options.auditRepo;
    this.eventEmitter = options.eventEmitter || { emit: () => {} };
    const isTestExecution = process.env.NODE_ENV === 'test' ||
      Boolean(process.env.NODE_TEST_CONTEXT) ||
      (process.execArgv && process.execArgv.some(a => a.includes('test'))) ||
      (process.argv && process.argv.some(a => a.includes('test')));

    this.gracePeriodMs = options.gracePeriodMs !== undefined
      ? options.gracePeriodMs
      : (process.env.PAYMENT_GRACE_PERIOD_MS !== undefined
        ? Number(process.env.PAYMENT_GRACE_PERIOD_MS)
        : (isTestExecution ? 0 : 5000));
    /** @type {Map<string, NodeJS.Timeout>} */
    this.pendingGraceTimers = new Map();
  }

  destroy() {
    for (const timer of this.pendingGraceTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingGraceTimers.clear();
  }

  /**
   * More than one session could explain this alert. Do not pick one.
   * Live sessions move to MANUAL_REVIEW. The observation is kept as evidence.
   */
  holdAmbiguous(savedObs, sessions, reason) {
    this.obsRepo.markAmbiguous(savedObs.id);
    const ids = [];
    for (const session of sessions) {
      if (!session?.id) continue;
      ids.push(session.id);
      const live = session.status === PaymentStatus.ACTIVE
        || session.status === PaymentStatus.PROCESSING
        || session.status === PaymentStatus.OBSERVED_SUCCESS;
      if (!live) continue;
      try {
        this.sessionRepo.transitionToTerminal(session.id, PaymentStatus.MANUAL_REVIEW, { reason });
        this.eventEmitter.emit('PAYMENT.MANUAL_REVIEW', {
          paymentId: session.id,
          orderId: session.orderId || session.order_id,
          merchantId: session.merchantId || session.merchant_id,
          observationId: savedObs.id,
          reason
        });
      } catch (err) {
        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: session.merchantId || session.merchant_id,
            entityType: 'PAYMENT_SESSION',
            entityId: session.id,
            action: 'AMBIGUOUS_MATCH_TRANSITION_FAILED',
            actorType: 'SYSTEM',
            details: { reason, error: err.message, observationId: savedObs.id }
          });
        }
      }
    }
    if (this.auditRepo && sessions[0]) {
      this.auditRepo.log({
        merchantId: sessions[0].merchantId || sessions[0].merchant_id,
        entityType: 'PAYMENT_OBSERVATION',
        entityId: savedObs.id,
        action: 'AMBIGUOUS_MATCH_MANUAL_REVIEW',
        actorType: 'SYSTEM',
        details: {
          reason,
          observationId: savedObs.id,
          sessionIds: ids,
          amountPaise: savedObs.amountPaise?.toString?.() || String(savedObs.amount_paise || '')
        }
      });
    }
    return {
      attributed: false,
      duplicate: false,
      lateMatch: false,
      ambiguous: true,
      observationId: savedObs.id,
      outcomeStatus: PaymentStatus.MANUAL_REVIEW,
      reason
    };
  }

  /**
   * Processes a normalized canonical observation through the attribution pipeline.
   * @param {ReturnType<typeof import('./normalizer.js').ObservationNormalizer.normalize>} normalizedObs
   * @returns {{
   *   attributed: boolean,
   *   duplicate: boolean,
   *   lateMatch: boolean,
   *   paymentSessionId?: string,
   *   observationId: string,
   *   outcomeStatus: string,
   *   verificationLevel?: number,
   *   verificationTag?: string,
   *   verificationSources?: string[]
   * }}
   */
  processObservation(normalizedObs) {
    if (normalizedObs && normalizedObs.amountPaise !== undefined && typeof normalizedObs.amountPaise !== 'bigint') {
      normalizedObs = { ...normalizedObs, amountPaise: BigInt(normalizedObs.amountPaise) };
    }
    if (normalizedObs && !(normalizedObs.observedAt instanceof Date)) {
      const parsedDate = normalizedObs.observedAt ? new Date(normalizedObs.observedAt) : new Date();
      normalizedObs = {
        ...normalizedObs,
        observedAt: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate
      };
    }
    if (normalizedObs && !normalizedObs.fingerprintHash) {
      normalizedObs = {
        ...normalizedObs,
        fingerprintHash: calculateObservationFingerprint({
          receivingAccountId: normalizedObs.receivingAccountId,
          amountPaise: normalizedObs.amountPaise,
          source: normalizedObs.source,
          bankReferenceNumber: normalizedObs.bankReferenceNumber,
          observedAt: normalizedObs.observedAt
        })
      };
    }

    const incomingFamily = getChannelFamily(normalizedObs.source);

    // Tier 1: Check fingerprint for deduplication
    // Look up this channel family first: once a second channel family has upgraded the payment, the
    // fingerprint has one row per channel family and the unfiltered lookup may return the other one.
    const existingSameFamily = this.obsRepo.findByFingerprintOrFamily
      ? this.obsRepo.findByFingerprintOrFamily(normalizedObs.fingerprintHash, normalizedObs.source)
      : this.obsRepo.findByFingerprint(normalizedObs.fingerprintHash, normalizedObs.source);
    const existing = existingSameFamily || this.obsRepo.findByFingerprint(normalizedObs.fingerprintHash);
    if (existing) {
      // If observation came from the SAME channel family (e.g. SMS_GATEWAY + ANDROID_OBSERVER or GOOGLE_MESSAGES),
      // drop as a redundant duplicate so same-channel-family events never falsely upgrade to Level 2.
      if (existing.source === normalizedObs.source || getChannelFamily(existing.source) === incomingFamily) {
        if (this.auditRepo) {
          this.auditRepo.log({
            entityType: 'PAYMENT_OBSERVATION',
            entityId: existing.id,
            action: 'DUPLICATE_OBSERVATION_DROPPED',
            actorType: 'OBSERVER',
            details: {
              fingerprintHash: normalizedObs.fingerprintHash,
              source: normalizedObs.source,
              existingSource: existing.source,
              channelFamily: incomingFamily
            }
          });
        }
        return {
          attributed: false,
          duplicate: true,
          lateMatch: false,
          paymentSessionId: existing.attributedPaymentId || undefined,
          observationId: existing.id,
          outcomeStatus: ObservationAttributionStatus.DUPLICATE_IGNORED
        };
      }

      // If observation came from a NEW, INDEPENDENT channel family (SMS vs GMAIL) and payment was already attributed:
      // Upgrade verification tier to Level 2 (Dual Verification)!
      if (existing.attributedPaymentId) {
        const targetSession = this.sessionRepo.findById(existing.attributedPaymentId);
        // Keep MANUAL_REVIEW sessions held until verified by authoritative bank statement
        if (targetSession && targetSession.status === PaymentStatus.MANUAL_REVIEW) {
          return {
            attributed: false,
            duplicate: false,
            lateMatch: false,
            ambiguous: true,
            paymentSessionId: targetSession.id,
            observationId: existing.id,
            outcomeStatus: PaymentStatus.MANUAL_REVIEW,
            reason: 'SESSION_HELD_IN_MANUAL_REVIEW'
          };
        }
        // If target session already has a verification source from this channel family, drop as duplicate
        if (
          targetSession &&
          Array.isArray(targetSession.verificationSources) &&
          targetSession.verificationSources.some(s => getChannelFamily(s) === incomingFamily)
        ) {
          return {
            attributed: false,
            duplicate: true,
            lateMatch: false,
            paymentSessionId: targetSession.id,
            observationId: existing.id,
            outcomeStatus: ObservationAttributionStatus.DUPLICATE_IGNORED
          };
        }
        const closedWithoutUpgrade = targetSession
          && isTerminalStatus(targetSession.status)
          && targetSession.status !== PaymentStatus.SUCCESS
          && targetSession.status !== PaymentStatus.OBSERVED_SUCCESS
          && targetSession.status !== PaymentStatus.RECONCILED;
        if (closedWithoutUpgrade) {
          const savedObs = this.obsRepo.create(normalizedObs);
          this.obsRepo.markLateUnmatched(savedObs.id, targetSession.id);
          if (this.auditRepo) {
            this.auditRepo.log({
              merchantId: targetSession.merchantId,
              entityType: 'PAYMENT_SESSION',
              entityId: targetSession.id,
              action: 'LATE_OBSERVATION_DETECTED',
              actorType: 'SYSTEM',
              details: {
                observationId: savedObs.id,
                source: normalizedObs.source,
                sessionStatus: targetSession.status
              }
            });
          }
          if (this.ticketRepo && targetSession.customerId) {
            this.ticketRepo.createTicket({
              merchantId: targetSession.merchantId,
              customerId: targetSession.customerId,
              paymentId: targetSession.id,
              subject: `[LATE PAYMENT DETECTED] Order #${targetSession.orderId}`,
              status: TicketStatus.OPEN,
              initialMessage: {
                senderType: SenderType.ADMIN,
                senderId: targetSession.merchantId,
                message: `A delayed payment observation of ${normalizedObs.amountPaise / 100n} INR was detected after session ${targetSession.id} ended with status ${targetSession.status}. Flagged for manual merchant reconciliation.`
              }
            });
          }
          this.eventEmitter.emit('PAYMENT.LATE_DETECTED', {
            paymentId: targetSession.id,
            orderId: targetSession.orderId,
            merchantId: targetSession.merchantId,
            amountPaise: normalizedObs.amountPaise,
            observationId: savedObs.id
          });
          return {
            attributed: false,
            duplicate: false,
            lateMatch: true,
            paymentSessionId: targetSession.id,
            observationId: savedObs.id,
            outcomeStatus: ObservationAttributionStatus.LATE_UNMATCHED
          };
        }

        // Cancel pending 5-second grace timer if any
        const pendingTimer = this.pendingGraceTimers.get(existing.attributedPaymentId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          this.pendingGraceTimers.delete(existing.attributedPaymentId);
        }

        const savedObs = this.obsRepo.create(normalizedObs);
        let verifyResult;
        try {
          verifyResult = this.sessionRepo.recordVerificationSource(
            existing.attributedPaymentId,
            normalizedObs.source,
            savedObs.id,
            { finalizeSuccess: true }
          );
          if (existing.bankReferenceNumber && savedObs.bankReferenceNumber && String(existing.bankReferenceNumber).trim() === String(savedObs.bankReferenceNumber).trim()) {
            this.obsRepo.db.execute(`
              UPDATE payment_observations
              SET attribution_status = ?
              WHERE id = ?
            `, [ObservationAttributionStatus.ATTRIBUTED, savedObs.id]);
          } else {
            this.obsRepo.markAttributed(savedObs.id, existing.attributedPaymentId);
          }
        } catch (dbErr) {
          const errMsg = dbErr?.message || '';
          if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('duplicate key value') || errMsg.includes('idx_observations_unique_attributed_bank_ref') || errMsg.includes('idx_payment_sessions_attributed_obs')) {
            return {
              attributed: false,
              duplicate: true,
              lateMatch: false,
              observationId: savedObs.id,
              outcomeStatus: 'REFERENCE_ALREADY_USED'
            };
          }
          throw dbErr;
        }

        if (this.auditRepo) {
          this.auditRepo.log({
            entityType: 'PAYMENT_SESSION',
            entityId: existing.attributedPaymentId,
            action: 'PAYMENT_VERIFICATION_UPGRADED',
            actorType: 'SYSTEM',
            details: {
              source: normalizedObs.source,
              level: verifyResult.level,
              tag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        if (verifyResult.isFirstSuccess) {
          this.eventEmitter.emit('PAYMENT.OBSERVED_SUCCESS', {
            paymentId: existing.attributedPaymentId,
            orderId: verifyResult.session.orderId,
            merchantId: verifyResult.session.merchantId,
            amountPaise: verifyResult.session.amountPaise,
            observationId: savedObs.id,
            verificationLevel: verifyResult.level,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });
        }

        this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
          paymentId: existing.attributedPaymentId,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          sources: verifyResult.sources
        });

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          paymentSessionId: existing.attributedPaymentId,
          observationId: savedObs.id,
          outcomeStatus: PaymentStatus.OBSERVED_SUCCESS,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    // Persist new observation as UNATTRIBUTED first
    const savedObs = this.obsRepo.create(normalizedObs);

    // Tier 2: Check currently active session on receiving account
    let currentSession = null;
    if (normalizedObs.rawPayload?.targetSessionId) {
      currentSession = this.sessionRepo.findById(normalizedObs.rawPayload.targetSessionId);
      if (currentSession && currentSession.status === PaymentStatus.MANUAL_REVIEW) {
        this.obsRepo.markAmbiguous(savedObs.id);
        return {
          attributed: false,
          duplicate: false,
          lateMatch: false,
          ambiguous: true,
          paymentSessionId: currentSession.id,
          observationId: savedObs.id,
          outcomeStatus: PaymentStatus.MANUAL_REVIEW,
          reason: 'SESSION_HELD_IN_MANUAL_REVIEW'
        };
      }
    }
    if (!currentSession || (currentSession.amountPaise !== normalizedObs.amountPaise)) {
      const matchRows = this.sessionRepo.db.query(`
        SELECT * FROM payment_sessions
        WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING') AND amount_paise = ?
      `, [normalizedObs.receivingAccountId, Number(normalizedObs.amountPaise)]);
      if (matchRows.length > 1) {
        return this.holdAmbiguous(
          savedObs,
          matchRows.map(row => this.sessionRepo.mapRow(row)),
          'MULTIPLE_LIVE_AMOUNT_MATCHES'
        );
      }
      if (matchRows.length === 1) {
        currentSession = this.sessionRepo.mapRow(matchRows[0]);
      } else if (!currentSession) {
        currentSession = this.sessionRepo.findCurrentActiveOrProcessing(normalizedObs.receivingAccountId);
      }
    } else if (!normalizedObs.rawPayload?.targetSessionId) {
      // Even if targetSessionId was not specified and currentSession matched amount, verify no other live session shares this amount
      const matchRows = this.sessionRepo.db.query(`
        SELECT * FROM payment_sessions
        WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING') AND amount_paise = ?
      `, [normalizedObs.receivingAccountId, Number(normalizedObs.amountPaise)]);
      if (matchRows.length > 1) {
        return this.holdAmbiguous(
          savedObs,
          matchRows.map(row => this.sessionRepo.mapRow(row)),
          'MULTIPLE_LIVE_AMOUNT_MATCHES'
        );
      }
    }

    if (currentSession) {
      // Invariant Check 1: Must be in ACTIVE or PROCESSING status
      const isEligibleStatus = [PaymentStatus.ACTIVE, PaymentStatus.PROCESSING].includes(currentSession.status);

      // Invariant Check 2: Exact Amount Match (in integer paise)
      const isAmountMatch = currentSession.amountPaise === normalizedObs.amountPaise;

      // Invariant Check 3: Temporal Window (with 5-minute clock skew tolerance, strictly preventing hijacking of prior expired sessions)
      let isPriorExpiredSession = false;
      if (currentSession.slotAcquiredAt && normalizedObs.observedAt < currentSession.slotAcquiredAt) {
        const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
        const recentExpired = this.sessionRepo.findRecentlyExpiredOrFailed(
          normalizedObs.receivingAccountId,
          thirtyMinutesAgo
        );
        isPriorExpiredSession = recentExpired.some(s => s.amountPaise === normalizedObs.amountPaise);
      }

      const slotStart = currentSession.slotAcquiredAt
        ? new Date(currentSession.slotAcquiredAt.getTime() - 300000)
        : new Date(currentSession.createdAt.getTime() - 300000);

      const isTimeValid = !isPriorExpiredSession && (normalizedObs.observedAt >= slotStart);

      // Invariant Check 0a: Transaction Reference Already Used Check
      let isUtrAlreadyUsed = false;
      const trimmedUtr = normalizedObs.bankReferenceNumber ? String(normalizedObs.bankReferenceNumber).trim() : '';
      if (trimmedUtr.length > 0) {
        const priorUsedSession = this.sessionRepo.db.queryOne(`
          SELECT ps.id, ps.order_id
          FROM payment_sessions ps
          JOIN payment_observations po ON (ps.attributed_observation_id = po.id OR po.attributed_payment_id = ps.id)
          WHERE ps.status NOT IN ('FAILED', 'EXPIRED', 'CANCELLED')
            AND ps.id != ?
            AND po.bank_reference_number = ?
          LIMIT 1
        `, [currentSession.id, trimmedUtr]);

        if (priorUsedSession) {
          isUtrAlreadyUsed = true;
          if (this.auditRepo) {
            this.auditRepo.log({
              merchantId: currentSession.merchantId,
              entityType: 'PAYMENT_SESSION',
              entityId: currentSession.id,
              action: 'REUSED_UTR_REJECTED',
              actorType: 'SYSTEM',
              details: {
                bankReferenceNumber: trimmedUtr,
                consumedByOrderId: priorUsedSession.order_id,
                consumedBySessionId: priorUsedSession.id
              }
            });
          }
        }
      }

      // Invariant Check 0b: Check if SMS is from personal numeric phone number (10-15 digits E.164, no letters)
      let isPersonalSms = false;
      const senderStr = (normalizedObs.rawPayload?.sender || normalizedObs.rawPayload?.from || '').toString().trim();
      if ((normalizedObs.source === 'SMS' || normalizedObs.source === 'ANDROID_OBSERVER') && senderStr) {
        const digitsOnly = senderStr.replace(/[\s+-]/g, '');
        if (digitsOnly.length >= 10 && /^\d+$/.test(digitsOnly) && !/[a-zA-Z]/.test(senderStr)) {
          isPersonalSms = true;
        }
      }

      if (isPriorExpiredSession && isEligibleStatus && isAmountMatch) {
        return this.holdAmbiguous(savedObs, [currentSession], 'LIVE_AND_RECENT_SAME_AMOUNT');
      }

      if (isUtrAlreadyUsed) {
        return {
          attributed: false,
          duplicate: true,
          lateMatch: false,
          observationId: savedObs.id,
          outcomeStatus: 'REFERENCE_ALREADY_USED'
        };
      }

      if (isPersonalSms) {
        return {
          attributed: false,
          duplicate: false,
          lateMatch: false,
          observationId: savedObs.id,
          outcomeStatus: 'PERSONAL_SMS_REJECTED'
        };
      }

      if (isEligibleStatus && isAmountMatch && isTimeValid) {
        const wasActive = currentSession.status === PaymentStatus.ACTIVE;

        // Check if currentSession already has an attributed primary observation (e.g. during grace window or REQUIRE_DUAL_CHANNEL)
        const primaryObs = currentSession.attributedObservationId
          ? this.obsRepo.findById(currentSession.attributedObservationId)
          : null;

        if (primaryObs) {
          const hasConflictingUtr = Boolean(
            primaryObs.bankReferenceNumber &&
            savedObs.bankReferenceNumber &&
            String(primaryObs.bankReferenceNumber).trim() !== String(savedObs.bankReferenceNumber).trim()
          );
          if (hasConflictingUtr) {
            const pendingGrace = this.pendingGraceTimers.get(currentSession.id);
            if (pendingGrace) {
              clearTimeout(pendingGrace);
              this.pendingGraceTimers.delete(currentSession.id);
            }
            return this.holdAmbiguous(savedObs, [currentSession], 'CONFLICTING_UTR_ON_SESSION');
          }

          if (getChannelFamily(primaryObs.source) === incomingFamily) {
            this.obsRepo.markDuplicate(savedObs.id);
            return {
              attributed: false,
              duplicate: true,
              lateMatch: false,
              paymentSessionId: currentSession.id,
              observationId: savedObs.id,
              outcomeStatus: ObservationAttributionStatus.DUPLICATE_IGNORED
            };
          }
        }

        // Check if there is already an active grace period awaiting second source for this session
        const pendingGrace = this.pendingGraceTimers.get(currentSession.id);
        if (pendingGrace) {
          clearTimeout(pendingGrace);
          this.pendingGraceTimers.delete(currentSession.id);

          // Second independent source confirmed within 5-second grace window -> LEVEL 2 DUAL VERIFICATION!
          let verifyResult;
          try {
            verifyResult = this.sessionRepo.recordVerificationSource(
              currentSession.id,
              normalizedObs.source,
              savedObs.id,
              { finalizeSuccess: true }
            );

            const sameUtrAsPrimary = Boolean(
              primaryObs &&
              primaryObs.bankReferenceNumber &&
              savedObs.bankReferenceNumber &&
              String(primaryObs.bankReferenceNumber).trim() === String(savedObs.bankReferenceNumber).trim()
            );

            if (!sameUtrAsPrimary) {
              this.obsRepo.markAttributed(savedObs.id, currentSession.id);
            } else {
              // Secondary dual-verification observation corroborates existing attributed UTR
              this.obsRepo.db.execute(`
                UPDATE payment_observations
                SET attribution_status = ?
                WHERE id = ?
              `, [ObservationAttributionStatus.ATTRIBUTED, savedObs.id]);
            }
          } catch (dbErr) {
            const errMsg = dbErr?.message || '';
            if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('duplicate key value') || errMsg.includes('idx_observations_unique_attributed_bank_ref') || errMsg.includes('idx_payment_sessions_attributed_obs')) {
              return {
                attributed: false,
                duplicate: true,
                lateMatch: false,
                observationId: savedObs.id,
                outcomeStatus: 'REFERENCE_ALREADY_USED'
              };
            }
            throw dbErr;
          }

          if (this.auditRepo) {
            this.auditRepo.log({
              merchantId: currentSession.merchantId,
              entityType: 'PAYMENT_SESSION',
              entityId: currentSession.id,
              action: 'PAYMENT_VERIFICATION_UPGRADED_L2',
              actorType: 'SYSTEM',
              details: {
                observationId: savedObs.id,
                source: normalizedObs.source,
                verificationLevel: 2,
                verificationTag: verifyResult.tag,
                sources: verifyResult.sources
              }
            });
          }

          this.eventEmitter.emit('PAYMENT.OBSERVED_SUCCESS', {
            paymentId: currentSession.id,
            orderId: currentSession.orderId,
            merchantId: currentSession.merchantId,
            amountPaise: currentSession.amountPaise,
            observationId: savedObs.id,
            verificationLevel: 2,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });

          this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
            paymentId: currentSession.id,
            orderId: currentSession.orderId,
            verificationLevel: 2,
            verificationTag: verifyResult.tag,
            sources: verifyResult.sources
          });

          return {
            attributed: true,
            duplicate: false,
            lateMatch: false,
            wasActive,
            paymentSessionId: currentSession.id,
            observationId: savedObs.id,
            outcomeStatus: PaymentStatus.OBSERVED_SUCCESS,
            verificationLevel: 2,
            verificationTag: verifyResult.tag,
            verificationSources: verifyResult.sources
          };
        }

        // FIRST SOURCE CONFIRMATION:
        // Record Level 1 verification source without immediate finalization (start 5-second grace window)
        let verifyResult;
        try {
          verifyResult = this.sessionRepo.recordVerificationSource(
            currentSession.id,
            normalizedObs.source,
            savedObs.id,
            { finalizeSuccess: false }
          );

          this.obsRepo.markAttributed(savedObs.id, currentSession.id);
        } catch (dbErr) {
          const errMsg = dbErr.message || '';
          if (errMsg.includes('UNIQUE constraint failed') || errMsg.includes('duplicate key value') || errMsg.includes('idx_observations_unique_attributed_bank_ref') || errMsg.includes('idx_payment_sessions_attributed_obs')) {
            if (this.auditRepo) {
              this.auditRepo.log({
                merchantId: currentSession.merchantId,
                entityType: 'PAYMENT_SESSION',
                entityId: currentSession.id,
                action: 'REUSED_UTR_REJECTED',
                actorType: 'SYSTEM',
                details: {
                  bankReferenceNumber: trimmedUtr,
                  error: 'Concurrent UTR or observation attribution race prevented by database unique constraint.'
                }
              });
            }
            return {
              attributed: false,
              duplicate: true,
              lateMatch: false,
              observationId: savedObs.id,
              outcomeStatus: 'REFERENCE_ALREADY_USED'
            };
          }
          throw dbErr;
        }

        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: currentSession.merchantId,
            entityType: 'PAYMENT_SESSION',
            entityId: currentSession.id,
            action: 'PAYMENT_LEVEL1_VERIFIED',
            actorType: 'SYSTEM',
            details: {
              observationId: savedObs.id,
              source: normalizedObs.source,
              amountPaise: normalizedObs.amountPaise.toString(),
              verificationLevel: 1,
              verificationTag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        this.eventEmitter.emit('PAYMENT.LEVEL1_VERIFIED', {
          paymentId: currentSession.id,
          orderId: currentSession.orderId,
          merchantId: currentSession.merchantId,
          amountPaise: currentSession.amountPaise,
          observationId: savedObs.id,
          verificationLevel: 1,
          verificationTag: verifyResult.tag,
          sources: verifyResult.sources
        });

        // If grace period is 0 (e.g. in instant tests), finalize immediately unless dual channel is required
        if (this.verificationPolicy !== 'REQUIRE_DUAL_CHANNEL' && (this.verificationPolicy === 'SINGLE_CHANNEL_VALIDATED_GMAIL' || this.gracePeriodMs <= 0)) {
          const finalResult = this.sessionRepo.recordVerificationSource(
            currentSession.id,
            normalizedObs.source,
            savedObs.id,
            { finalizeSuccess: true }
          );
          this.eventEmitter.emit('PAYMENT.OBSERVED_SUCCESS', {
            paymentId: currentSession.id,
            orderId: currentSession.orderId,
            merchantId: currentSession.merchantId,
            amountPaise: currentSession.amountPaise,
            observationId: savedObs.id,
            verificationLevel: finalResult.level,
            verificationTag: finalResult.tag,
            sources: finalResult.sources
          });

          return {
            attributed: true,
            duplicate: false,
            lateMatch: false,
            wasActive,
            paymentSessionId: currentSession.id,
            observationId: savedObs.id,
            outcomeStatus: PaymentStatus.OBSERVED_SUCCESS,
            verificationLevel: finalResult.level,
            verificationTag: finalResult.tag,
            verificationSources: finalResult.sources
          };
        }

        if (this.verificationPolicy === 'REQUIRE_DUAL_CHANNEL') {
          return {
            attributed: true,
            duplicate: false,
            lateMatch: false,
            wasActive,
            paymentSessionId: currentSession.id,
            observationId: savedObs.id,
            outcomeStatus: PaymentStatus.PROCESSING,
            verificationLevel: verifyResult.level,
            verificationTag: verifyResult.tag,
            verificationSources: verifyResult.sources
          };
        }

        // Start 5-second grace window awaiting second poller
        const targetSessionId = currentSession.id;
        const targetObsId = savedObs.id;
        const targetSource = normalizedObs.source;
        const targetOrderId = currentSession.orderId;
        const targetMerchantId = currentSession.merchantId;
        const targetAmountPaise = currentSession.amountPaise;

        const graceTimer = setTimeout(() => {
          this.pendingGraceTimers.delete(targetSessionId);
          // Check if session became terminal during the grace window
          const latestSession = this.sessionRepo.findById(targetSessionId);
          const alreadyObserved = latestSession && (
            latestSession.status === PaymentStatus.SUCCESS
            || latestSession.status === PaymentStatus.OBSERVED_SUCCESS
            || latestSession.status === PaymentStatus.RECONCILED
          );
          if (!latestSession || (isTerminalStatus(latestSession.status) && !alreadyObserved)) {
            const sessionStatus = latestSession ? latestSession.status : 'EXPIRED';
            this.obsRepo.markLateUnmatched(targetObsId);
            if (this.auditRepo) {
              this.auditRepo.log({
                merchantId: targetMerchantId,
                entityType: 'PAYMENT_SESSION',
                entityId: targetSessionId,
                action: 'LATE_OBSERVATION_DETECTED',
                actorType: 'SYSTEM',
                details: {
                  observationId: targetObsId,
                  source: targetSource,
                  sessionStatus
                }
              });
            }
            if (this.ticketRepo && latestSession?.customerId) {
              this.ticketRepo.createTicket({
                merchantId: targetMerchantId,
                customerId: latestSession.customerId,
                paymentId: targetSessionId,
                subject: `[LATE PAYMENT DETECTED] Order #${targetOrderId}`,
                status: TicketStatus.OPEN,
                initialMessage: {
                  senderType: SenderType.ADMIN,
                  senderId: targetMerchantId,
                  message: `A delayed payment observation of ${targetAmountPaise / 100n} INR was detected after session ${targetSessionId} ended with status ${sessionStatus}. Flagged for manual merchant reconciliation.`
                }
              });
            }
            this.eventEmitter.emit('PAYMENT.LATE_DETECTED', {
              paymentId: targetSessionId,
              orderId: targetOrderId,
              merchantId: targetMerchantId,
              amountPaise: targetAmountPaise,
              observationId: targetObsId
            });
            return;
          }

          if (alreadyObserved) {
            return;
          }

          // 5 seconds elapsed without second source: finalize as Level 1
          const finalResult = this.sessionRepo.recordVerificationSource(
            targetSessionId,
            targetSource,
            targetObsId,
            { finalizeSuccess: true }
          );

          if (this.auditRepo) {
            this.auditRepo.log({
              merchantId: targetMerchantId,
              entityType: 'PAYMENT_SESSION',
              entityId: targetSessionId,
              action: 'PAYMENT_ATTRIBUTED_SUCCESS_L1',
              actorType: 'SYSTEM',
              details: {
                observationId: targetObsId,
                source: targetSource,
                verificationLevel: finalResult.level,
                verificationTag: finalResult.tag
              }
            });
          }

          this.eventEmitter.emit('PAYMENT.OBSERVED_SUCCESS', {
            paymentId: targetSessionId,
            orderId: targetOrderId,
            merchantId: targetMerchantId,
            amountPaise: targetAmountPaise,
            observationId: targetObsId,
            verificationLevel: finalResult.level,
            verificationTag: finalResult.tag,
            sources: finalResult.sources
          });
        }, this.gracePeriodMs);

        if (graceTimer.unref) graceTimer.unref();
        this.pendingGraceTimers.set(targetSessionId, graceTimer);

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          wasActive,
          paymentSessionId: currentSession.id,
          observationId: savedObs.id,
          outcomeStatus: 'VERIFYING',
          verificationLevel: 1,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    // Check if observation confirms a recently successful session on this receiving account (within 60s)
    // Upgrades verification level (e.g. from Level 1 -> Level 2 -> Level 3)
    const sixtySecsAgo = new Date(Date.now() - 60000).toISOString();
    const recentSuccessSession = this.sessionRepo.db.queryOne(`
      SELECT * FROM payment_sessions
      WHERE receiving_account_id = ? AND status IN ('SUCCESS', 'OBSERVED_SUCCESS')
        AND amount_paise = ? AND completed_at >= ?
      ORDER BY completed_at DESC LIMIT 1
    `, [normalizedObs.receivingAccountId, Number(normalizedObs.amountPaise), sixtySecsAgo]);

    if (recentSuccessSession) {
      // Check if this session's attributed observation had a UTR
      const existingObs = recentSuccessSession.attributed_observation_id
        ? this.obsRepo.findById(recentSuccessSession.attributed_observation_id)
        : null;

      // If both have UTRs and they do NOT match, this is NOT the same transaction!
      const isUtrConflict = normalizedObs.bankReferenceNumber &&
        existingObs?.bankReferenceNumber &&
        normalizedObs.bankReferenceNumber !== existingObs.bankReferenceNumber;

      if (isUtrConflict) {
        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: recentSuccessSession.merchant_id,
            entityType: 'PAYMENT_SESSION',
            entityId: recentSuccessSession.id,
            action: 'DUPLICATE_PAYMENT_UTR_CONFLICT',
            actorType: 'SYSTEM',
            details: {
              observationId: savedObs.id,
              existingUtr: existingObs?.bankReferenceNumber,
              newUtr: normalizedObs.bankReferenceNumber,
              amountPaise: normalizedObs.amountPaise.toString()
            }
          });
        }
        if (this.ticketRepo && recentSuccessSession.customer_id) {
          this.ticketRepo.createTicket({
            merchantId: recentSuccessSession.merchant_id,
            customerId: recentSuccessSession.customer_id,
            paymentId: recentSuccessSession.id,
            subject: `[DUPLICATE PAYMENT DETECTED] Order #${recentSuccessSession.order_id}`,
            status: TicketStatus.OPEN,
            initialMessage: {
              senderType: SenderType.ADMIN,
              senderId: recentSuccessSession.merchant_id,
              message: `A duplicate payment of ${normalizedObs.amountPaise / 100n} INR with reference ${normalizedObs.bankReferenceNumber} was received within 60s of completed order #${recentSuccessSession.order_id} (reference ${existingObs?.bankReferenceNumber || 'N/A'}). Flagged for merchant refund reconciliation.`
            }
          });
        }
        this.eventEmitter.emit('PAYMENT.DUPLICATE_DETECTED', {
          paymentId: recentSuccessSession.id,
          orderId: recentSuccessSession.order_id,
          merchantId: recentSuccessSession.merchant_id,
          observationId: savedObs.id,
          existingUtr: existingObs?.bankReferenceNumber,
          newUtr: normalizedObs.bankReferenceNumber,
          amountPaise: normalizedObs.amountPaise
        });
      }

      const sessionSlotStart = recentSuccessSession.slot_acquired_at
        ? new Date(new Date(recentSuccessSession.slot_acquired_at).getTime() - 30000)
        : new Date(new Date(recentSuccessSession.created_at).getTime() - 30000);
      const sessionCompleted = recentSuccessSession.completed_at
        ? new Date(new Date(recentSuccessSession.completed_at).getTime() + 30000)
        : new Date();

      // Temporal check: observation must have been observed during this session's window
      if (!isUtrConflict && normalizedObs.observedAt >= sessionSlotStart && normalizedObs.observedAt <= sessionCompleted) {
        const mappedRecentSession = this.sessionRepo.mapRow(recentSuccessSession);
        if (
          Array.isArray(mappedRecentSession.verificationSources) &&
          mappedRecentSession.verificationSources.some(s => getChannelFamily(s) === incomingFamily)
        ) {
          this.obsRepo.markDuplicate(savedObs.id);
          return {
            attributed: false,
            duplicate: true,
            lateMatch: false,
            paymentSessionId: recentSuccessSession.id,
            observationId: savedObs.id,
            outcomeStatus: ObservationAttributionStatus.DUPLICATE_IGNORED
          };
        }

        const verifyResult = this.sessionRepo.recordVerificationSource(
          recentSuccessSession.id,
          normalizedObs.source,
          savedObs.id
        );

        this.obsRepo.markAttributed(savedObs.id, recentSuccessSession.id);

        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: recentSuccessSession.merchant_id,
            entityType: 'PAYMENT_SESSION',
            entityId: recentSuccessSession.id,
            action: 'PAYMENT_VERIFICATION_UPGRADED',
            actorType: 'SYSTEM',
            details: {
              observationId: savedObs.id,
              source: normalizedObs.source,
              amountPaise: normalizedObs.amountPaise.toString(),
              verificationLevel: verifyResult.level,
              verificationTag: verifyResult.tag,
              sources: verifyResult.sources
            }
          });
        }

        this.eventEmitter.emit('PAYMENT.VERIFICATION_UPGRADED', {
          paymentId: recentSuccessSession.id,
          orderId: recentSuccessSession.order_id,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          sources: verifyResult.sources
        });

        return {
          attributed: true,
          duplicate: false,
          lateMatch: false,
          paymentSessionId: recentSuccessSession.id,
          observationId: savedObs.id,
          outcomeStatus: PaymentStatus.OBSERVED_SUCCESS,
          verificationLevel: verifyResult.level,
          verificationTag: verifyResult.tag,
          verificationSources: verifyResult.sources
        };
      }
    }

    // Tier 3: Late Observation Handling
    // Check if observation matches a recently expired or failed session on this receiving account (< 30 mins)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentExpired = this.sessionRepo.findRecentlyExpiredOrFailed(
      normalizedObs.receivingAccountId,
      thirtyMinutesAgo
    );

    const lateMatches = recentExpired.filter(s => s.amountPaise === normalizedObs.amountPaise);
    if (lateMatches.length > 1) {
      return this.holdAmbiguous(savedObs, lateMatches, 'MULTIPLE_LATE_AMOUNT_MATCHES');
    }
    const lateMatchedSession = lateMatches[0];

    if (lateMatchedSession) {
      // Mark observation as LATE_UNMATCHED and preserve candidate session ID in raw_payload
      this.obsRepo.markLateUnmatched(savedObs.id, lateMatchedSession.id);

      if (this.auditRepo) {
        this.auditRepo.log({
          merchantId: lateMatchedSession.merchantId,
          entityType: 'PAYMENT_SESSION',
          entityId: lateMatchedSession.id,
          action: 'LATE_OBSERVATION_DETECTED',
          actorType: 'SYSTEM',
          details: {
            observationId: savedObs.id,
            source: normalizedObs.source,
            amountPaise: normalizedObs.amountPaise.toString(),
            sessionStatus: lateMatchedSession.status
          }
        });
      }

      // Automatically create a high-priority reconciliation support ticket if customer exists
      if (this.ticketRepo && lateMatchedSession.customerId) {
        this.ticketRepo.createTicket({
          merchantId: lateMatchedSession.merchantId,
          customerId: lateMatchedSession.customerId,
          paymentId: lateMatchedSession.id,
          subject: `[LATE PAYMENT DETECTED] Order #${lateMatchedSession.orderId}`,
          status: TicketStatus.OPEN,
          initialMessage: {
            senderType: SenderType.ADMIN,
            senderId: lateMatchedSession.merchantId,
            message: `A delayed payment observation of ${normalizedObs.amountPaise / 100n} INR was detected after session ${lateMatchedSession.id} ended with status ${lateMatchedSession.status}. Flagged for manual merchant reconciliation.`
          }
        });
      }

      // Emit LATE_DETECTED event
      this.eventEmitter.emit('PAYMENT.LATE_DETECTED', {
        paymentId: lateMatchedSession.id,
        orderId: lateMatchedSession.orderId,
        merchantId: lateMatchedSession.merchantId,
        amountPaise: normalizedObs.amountPaise,
        observationId: savedObs.id
      });

      return {
        attributed: false,
        duplicate: false,
        lateMatch: true,
        paymentSessionId: lateMatchedSession.id,
        observationId: savedObs.id,
        outcomeStatus: ObservationAttributionStatus.LATE_UNMATCHED
      };
    }

    // Unattributed observation
    return {
      attributed: false,
      duplicate: false,
      lateMatch: false,
      observationId: savedObs.id,
      outcomeStatus: ObservationAttributionStatus.UNATTRIBUTED
    };
  }

  /**
   * Re-evaluates unmatched (UNATTRIBUTED / LATE_UNMATCHED) observations for a receiving account
   * against eligible sessions to surface late-payment correlation or manual review holds.
   * Never auto-confirms an immutable terminal session (EXPIRED/FAILED/CANCELLED).
   * @param {string} receivingAccountId
   */
  reconcileUnmatchedObservations(receivingAccountId) {
    const unattributed = this.obsRepo.findUnattributed(receivingAccountId);
    const results = [];

    for (const obs of unattributed) {
      // 1. Check live sessions with matching amount
      const liveRows = this.sessionRepo.db.query(`
        SELECT * FROM payment_sessions
        WHERE receiving_account_id = ? AND status IN ('ACTIVE', 'PROCESSING') AND amount_paise = ?
      `, [receivingAccountId, Number(obs.amountPaise)]);

      if (liveRows.length > 1) {
        const held = this.holdAmbiguous(
          obs,
          liveRows.map(r => this.sessionRepo.mapRow(r)),
          'MULTIPLE_LIVE_AMOUNT_MATCHES'
        );
        results.push({ observationId: obs.id, action: 'HELD_AMBIGUOUS', ...held });
        continue;
      }

      // 2. Check recently expired or failed sessions (< 30 mins)
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      const recentExpired = this.sessionRepo.findRecentlyExpiredOrFailed(receivingAccountId, thirtyMinutesAgo);
      const lateMatches = recentExpired.filter(s => s.amountPaise === obs.amountPaise);

      if (lateMatches.length > 1) {
        const held = this.holdAmbiguous(obs, lateMatches, 'MULTIPLE_LATE_AMOUNT_MATCHES');
        results.push({ observationId: obs.id, action: 'HELD_AMBIGUOUS', ...held });
        continue;
      }

      if (lateMatches.length === 1) {
        const lateSession = lateMatches[0];
        this.obsRepo.markLateUnmatched(obs.id, lateSession.id);
        if (this.auditRepo) {
          this.auditRepo.log({
            merchantId: lateSession.merchantId,
            entityType: 'PAYMENT_SESSION',
            entityId: lateSession.id,
            action: 'LATE_OBSERVATION_RECONCILED_TO_TICKET',
            actorType: 'SYSTEM',
            details: {
              observationId: obs.id,
              source: obs.source,
              amountPaise: obs.amountPaise.toString(),
              sessionStatus: lateSession.status
            }
          });
        }
        if (this.ticketRepo && lateSession.customerId) {
          this.ticketRepo.createTicket({
            merchantId: lateSession.merchantId,
            customerId: lateSession.customerId,
            paymentId: lateSession.id,
            subject: `[LATE PAYMENT DETECTED] Order #${lateSession.orderId}`,
            status: TicketStatus.OPEN,
            initialMessage: {
              senderType: SenderType.ADMIN,
              senderId: lateSession.merchantId,
              message: `A delayed payment observation of ${obs.amountPaise / 100n} INR was matched during unmatched reconciliation after session ${lateSession.id} ended with status ${lateSession.status}.`
            }
          });
        }
        this.eventEmitter.emit('PAYMENT.LATE_DETECTED', {
          paymentId: lateSession.id,
          orderId: lateSession.orderId,
          merchantId: lateSession.merchantId,
          amountPaise: obs.amountPaise,
          observationId: obs.id
        });
        results.push({
          observationId: obs.id,
          action: 'MARKED_LATE_UNMATCHED',
          paymentSessionId: lateSession.id,
          outcomeStatus: ObservationAttributionStatus.LATE_UNMATCHED
        });
        continue;
      }

      results.push({
        observationId: obs.id,
        action: 'REMAINS_UNATTRIBUTED',
        outcomeStatus: ObservationAttributionStatus.UNATTRIBUTED
      });
    }

    return {
      processed: unattributed.length,
      reconciledCount: results.filter(r => r.action !== 'REMAINS_UNATTRIBUTED').length,
      results
    };
  }
}
