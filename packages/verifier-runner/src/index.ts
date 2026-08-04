/**
 * @skillos/verifier-runner — portable offline-eval bundle consumer +
 * deterministic verifier runner. No Simpl3 import; digests + redacted traces only.
 *
 * ## Report-seam invariant (F-004 / F-005)
 *
 * A public symbol may emit verifier/catalog identity on multi-axis or
 * hard-failure reports only when content derives from
 * `runDeterministicBundleVerifier`. Caller-constructed report/result structures
 * never reach a public identity-stamping path.
 *
 * Synthetic multi-axis / hard-failure builders and formatters are intentionally
 * not re-exported. Advisory-benchmark helpers that derive rows from the runner
 * remain public and are out of that deny surface.
 *
 * Public runtime exports are fail-closed by an exhaustive reviewed manifest in
 * `test/multi-axis.test.ts` (F-005). Adding a new public symbol without updating
 * that classification fails the package tests — do not rely on name heuristics.
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
  PRE_SANITIZE_VERIFIER_VERSION,
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
  LEGACY_MULTI_AXIS_REPORT_VERSION,
  // Report-seam invariant: synthetic multi-axis / hard-failure builders are
  // intentionally NOT re-exported (F-004 / F-005). Public reports only via
  // runDeterministicBundleVerifier. See module header + README.
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
export {
  ADVISORY_BENCHMARK_REPORT_VERSION,
  ADVISORY_GOLDEN_FILES,
  buildAdvisoryBenchmarkReport,
  buildAdvisoryBenchmarkFromGoldenFixtures,
  buildAdvisoryRowFromBundle,
  formatAdvisoryBenchmarkHuman,
  isTrustworthyAdvisoryReport,
  publicErrorCode,
  sanitizeFixtureFileLabel,
  sanitizeCiBinding,
  type AdvisoryNumericAxis,
  type AdvisoryBenchmarkRow,
  type AdvisoryBenchmarkSummary,
  type AdvisoryBenchmarkReport,
  type AdvisoryBenchmarkRunOptions,
  type AdvisoryFixtureSpec,
} from "./advisoryBenchmark.js";
