/**
 * Fail-closed consumer errors. Codes mirror the Simpl3 portable-bundle producer
 * contract (BUNDLE_EXPORT.md SkillOS consumer acceptance) without importing
 * Simpl3 source.
 */

export type BundleConsumerErrorCode =
  | "BUNDLE_INVALID"
  | "BUNDLE_UNKNOWN_FIELD"
  | "BUNDLE_MISSING_FIELD"
  | "BUNDLE_DIGEST_INVALID"
  | "BUNDLE_DIGEST_MISMATCH"
  | "BUNDLE_VERSION_UNSUPPORTED"
  | "PROTOCOL_VERSION_UNSUPPORTED"
  | "PRODUCER_ID_INVALID"
  | "PRODUCER_COHERENCE"
  | "MANIFEST_SCHEMA_INVALID"
  | "EVIDENCE_SCHEMA_INVALID"
  | "EVIDENCE_MANIFEST_BINDING"
  | "MANIFEST_DIGEST_MISMATCH"
  | "EVIDENCE_DIGEST_MISMATCH"
  | "INPUT_DIGEST_INVALID"
  | "INPUT_DIGEST_MISMATCH"
  | "SCENARIO_IDENTITY"
  | "TRACE_UNEXPECTED_FIELD"
  | "TRACE_ARTIFACT_COUNT"
  | "TRACE_DIGEST_MISMATCH"
  | "TRACE_NOT_REDACTED"
  | "MEASUREMENTS_INVALID"
  | "CLI_USAGE"
  | "LOAD_FAILED";

export class BundleConsumerError extends Error {
  readonly code: BundleConsumerErrorCode;

  constructor(code: BundleConsumerErrorCode, message: string) {
    super(message);
    this.name = "BundleConsumerError";
    this.code = code;
  }
}
