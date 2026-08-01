/**
 * @skillos/protocol v0.1.0
 * Domain-neutral offchain Arena/Evidence protocol (ADR 0005).
 */

export {
  PROTOCOL_VERSION,
  ProtocolError,
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
  type SchemaId,
  type DigestProjection,
  type ProtocolErrorCode,
} from "./types.js";

export {
  canonicalize,
  utf8Bytes,
  assertIJsonValue,
  assertNoLoneSurrogates,
  snapshotIJsonValue,
  isPlainObject,
} from "./jcs.js";
export { parseJsonStrict } from "./json-parse.js";
export {
  assertJcsNumber,
  assertProtocolNumber,
  assertProtocolNumbers,
  parseProtocolNumberInput,
} from "./numbers.js";

export {
  DIGEST_FORMAT_RE,
  assertDigestFormat,
  sha256Hex,
  digestJsonValue,
  applyProjection,
  computeDigest,
  digestManifest,
  digestEvidence,
  digestVerifier,
  digestResult,
} from "./digest.js";

export {
  parseAndValidateSchema,
  assertDigestBinding,
  type DigestBindingInput,
} from "./validate.js";

export {
  assertMeasurements,
  assertRequiredMeasurements,
  assertUniqueMeasurementIds,
} from "./measurements.js";

export { SCHEMA_REGISTRY, SCHEMA_IDS } from "./schemas.js";

export {
  type LegacyGameScoreSubmission,
  type AdaptGameScoreOptions,
  buildGameScoreManifest,
  buildGameScoreManifestAsync,
  adaptGameScoreToEvidence,
} from "./adapt/gameScore.js";
