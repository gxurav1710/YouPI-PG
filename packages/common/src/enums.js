/**
 * Internal high-resolution payment session lifecycle states.
 */
export const PaymentStatus = Object.freeze({
  INITIATED: 'INITIATED',
  QUEUED: 'QUEUED',
  ACTIVE: 'ACTIVE',
  PROCESSING: 'PROCESSING',
  /** Observer alert matched. Not a bank-statement confirmation. Do not fulfill. */
  OBSERVED_SUCCESS: 'OBSERVED_SUCCESS',
  /** Reserved for a future statement-import match. Observers must not set this. */
  RECONCILED: 'RECONCILED',
  /** Ambiguous or suspicious evidence. Not payable. */
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  /** COD or counter order placed. Not an observer settlement. */
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

/**
 * Public-facing payment outcomes consumed by external merchants.
 */
export const PublicPaymentOutcome = Object.freeze({
  OBSERVED_SUCCESS: 'OBSERVED_SUCCESS',
  RECONCILED: 'RECONCILED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED'
});

/**
 * Supported payment modalities.
 */
export const PaymentMethod = Object.freeze({
  UPI: 'UPI',
  MANUAL_UPI: 'MANUAL_UPI',
  COD: 'COD',
  CASH_COUNTER: 'CASH_COUNTER',
  CARD_COUNTER: 'CARD_COUNTER'
});

/**
 * Merchant gateway selling modes.
 */
export const SellingMode = Object.freeze({
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE'
});

/**
 * Observation channel sources feeding the payment detection engine (2-Layer: SMS + Gmail).
 * Android observer layer is completely removed.
 */
export const ObserverSource = Object.freeze({
  GMAIL: 'GMAIL',
  GOOGLE_MESSAGES: 'GOOGLE_MESSAGES',
  ANDROID_OBSERVER: 'ANDROID_OBSERVER',
  SMS_GATEWAY: 'SMS_GATEWAY',
  MANUAL_COUNTER: 'MANUAL_COUNTER'
});

/**
 * Attribution status for raw observations.
 */
export const ObservationAttributionStatus = Object.freeze({
  UNATTRIBUTED: 'UNATTRIBUTED',
  ATTRIBUTED: 'ATTRIBUTED',
  LATE_UNMATCHED: 'LATE_UNMATCHED',
  DUPLICATE_IGNORED: 'DUPLICATE_IGNORED',
  AMBIGUOUS: 'AMBIGUOUS'
});

/**
 * Support ticket lifecycle states.
 */
export const TicketStatus = Object.freeze({
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED'
});

/**
 * Live chat message sender identity type.
 */
export const SenderType = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN'
});

/**
 * Audit log actor classifications.
 */
export const AuditActorType = Object.freeze({
  SYSTEM: 'SYSTEM',
  CUSTOMER: 'CUSTOMER',
  ADMIN: 'ADMIN',
  OBSERVER: 'OBSERVER'
});
