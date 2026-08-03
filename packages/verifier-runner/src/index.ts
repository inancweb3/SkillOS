/**
 * @skillos/verifier-runner — portable offline-eval bundle consumer +
 * deterministic verifier runner. No Simpl3 import; digests + redacted traces only.
 */

export {
  BundleConsumerError,
  type BundleConsumerErrorCode,
} from "./errors.js";
export {
  EVAL_BUNDLE_VERSION,
  EVAL_BUNDLE_PRODUCER_ID,
  VERIFIER_ID,
  VERIFIER_VERSION,
  LEGACY_VERIFIER_VERSION,
  LEGACY_VERIFIER_DIGEST,
  VERIFIER_CATALOG_BINDING,
  BUNDLE_TOOL_TRACE_FIELDS,
  OFFLINE_EVAL_BUNDLE_BODY_KEYS,
  type BundleToolCallRecord,
  type OfflineEvalBundleBody,
  type OfflineEvalBundle,
  type BundleVerifyOk,
  type BundleVerifyFail,
  type BundleVerifyResult,
  type RunVerifierOptions,
} from "./types.js";
export { projectOfflineEvalBundleBody } from "./project.js";
export {
  isValidDigestString,
  assertBundleIdentityCoherence,
  assertPortableInputDigestCoherence,
  assertScenarioIdentityCoherence,
} from "./identity.js";
export {
  projectToolTraceRecordsForBundle,
  projectToolTraceForDigest,
  digestToolTraceProjection,
  assertToolTraceConsumerReady,
} from "./toolTrace.js";
export {
  redactDeep,
  isSensitiveKey,
  isSecretValue,
} from "./redaction.js";
export { verifyPortableOfflineEvalBundle } from "./verify.js";
export {
  runDeterministicBundleVerifier,
  runDeterministicBundleVerifierOrThrow,
  type RunVerifierSuccess,
  type RunVerifierFailure,
  type RunVerifierOutcome,
} from "./run.js";
export { loadBundleFile } from "./load.js";
export {
  HARD_GATE_CATALOG_VERSION,
  HARD_GATE_CODES,
  CANONICAL_EXECUTE_ATTEMPT_PATH,
  mapProducerHardFailureCode,
  evaluateHardGates,
  assertPortableHardGateBody,
  isCanonicalExecuteAttemptPath,
  type HardGateCode,
  type HardGateEvaluation,
} from "./hardGates.js";
export {
  MULTI_AXIS_REPORT_VERSION,
  buildMultiAxisReport,
  buildHardFailureReport,
  buildAxisInventory,
  formatHardFailureReportHuman,
  declaredNumericMeasurements,
  type AxisGate,
  type AxisValueType,
  type AxisReportEntry,
  type MultiAxisBindings,
  type MultiAxisReport,
  type HardFailureReport,
  type BuildMultiAxisInput,
} from "./multiAxis.js";
export {
  sanitizeReportLabel,
  hasControlChars,
  SAFE_LABEL_MAX_CHARS,
  UNSAFE_OMITTED,
} from "./reportSafe.js";
export { writeOutputsAtomic, assertSafeOutputPath } from "./atomicWrite.js";
