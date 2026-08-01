/**
 * Runtime helpers + re-exports of schema-generated document types.
 *
 * Document interfaces (ArenaDefinition, …) live in types.generated.ts and are
 * produced by `npm run generate-types` from packages/protocol/schemas/*.json.
 * Do not hand-edit types.generated.ts — CI drift gate fails if it diverges.
 */

export {
  type ProtocolVersion,
  type Digest,
  type MeasurementValue,
  type MeasurementValueType,
  type MeasurementDefinition,
  type EvaluatorRef,
  type VerifierRef,
  type TaskBinding,
  type ArenaDefinition,
  type EnvironmentSummary,
  type DatasetPin,
  type BenchmarkManifest,
  type SubjectType,
  type Subject,
  type Provenance,
  type ArtifactAvailability,
  type ArtifactDescriptor,
  type EvidenceEnvelope,
  type VerifierCapability,
  type VerifierDescriptor,
  type VerificationStatus,
  type VerificationResult,
} from "./types.generated.js";

/** Exact protocol document version accepted by v0.1 schemas. */
export const PROTOCOL_VERSION = "0.1.0" as const;

/** Schema registry ids for parseAndValidateSchema. */
export type SchemaId =
  | "ArenaDefinition"
  | "BenchmarkManifest"
  | "MeasurementDefinition"
  | "EvidenceEnvelope"
  | "VerifierDescriptor"
  | "VerificationResult";

/** Normative digest projection kinds (ADR 0005 D3.1). */
export type DigestProjection =
  | "manifest"
  | "evidence"
  | "verifier"
  | "result";

export type ProtocolErrorCode =
  | "UNSUPPORTED_PROTOCOL_VERSION"
  | "SCHEMA_VALIDATION_FAILED"
  | "INVALID_DIGEST_FORMAT"
  | "DIGEST_MISMATCH"
  | "BINDING_MISMATCH"
  | "UNSAFE_NUMBER"
  | "NEGATIVE_ZERO"
  | "NON_FINITE_NUMBER"
  | "MISSING_REQUIRED_MEASUREMENT"
  | "DUPLICATE_MEASUREMENT_ID"
  | "MEASUREMENT_TYPE_MISMATCH"
  | "UNKNOWN_MEASUREMENT"
  | "DUPLICATE_KEY"
  | "LONE_SURROGATE"
  | "CYCLE"
  | "INVALID_JSON"
  | "UNKNOWN_SCHEMA"
  | "INVALID_INPUT";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly details?: unknown;

  constructor(code: ProtocolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }
}
