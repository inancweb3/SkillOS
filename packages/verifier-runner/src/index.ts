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
} from "./run.js";
export { loadBundleFile } from "./load.js";
