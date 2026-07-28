// Public outbound delivery queue facade for storage and recovery operations.
export {
  ackDelivery,
  completeDelivery,
  enqueueDelivery,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  loadPendingDelivery,
  loadPendingDeliveries,
  loadSentDelivery,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
  moveToFailed,
} from "./delivery-queue-storage.js";
export type {
  QueuedDelivery,
  QueuedDeliveryPayload,
  QueuedReplyPayloadSendingHook,
  QueuedRenderedMessageBatchPlan,
} from "./delivery-queue-storage.js";
export {
  computeBackoffMs,
  drainPendingDeliveries,
  isEntryEligibleForRecoveryRetry,
  isPermanentDeliveryError,
  MAX_RETRIES,
  reconcilePendingDeliveryOutcome,
  recoverPendingDeliveries,
  withActiveDeliveryClaim,
} from "./delivery-queue-recovery.js";
export type {
  ActiveDeliveryClaimResult,
  DeliverFn,
  PendingDeliveryReconciliationResult,
  PendingDeliveryDrainDecision,
  RecoveryLogger,
  RecoverySummary,
} from "./delivery-queue-recovery.js";
