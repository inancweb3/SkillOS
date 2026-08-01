/**
 * Separate validation APIs (ADR 0005 D3.3):
 * - parseAndValidateSchema
 * - assertDigestFormat (re-exported from digest)
 * - computeDigest (re-exported from digest)
 * - assertDigestBinding
 */

import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";

import { SCHEMA_REGISTRY } from "./schemas.js";
import {
  assertDigestFormat,
  computeDigest,
  digestEvidence,
  digestManifest,
  digestResult,
  digestVerifier,
} from "./digest.js";
import { assertIJsonValue } from "./jcs.js";
import { parseJsonStrict } from "./json-parse.js";
import { assertMeasurements } from "./measurements.js";
import { assertProtocolNumbers } from "./numbers.js";
import {
  type BenchmarkManifest,
  type EvidenceEnvelope,
  type SchemaId,
  type VerificationResult,
  type VerifierDescriptor,
  PROTOCOL_VERSION,
  ProtocolError,
} from "./types.js";

// CJS/ESM interop for ajv + ajv-formats under NodeNext.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020 = ((Ajv2020Import as any).default ?? Ajv2020Import) as new (opts?: object) => {
  compile: (schema: object) => ValidateFunction;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats = ((addFormatsImport as any).default ??
  addFormatsImport) as (ajv: unknown) => unknown;

type AjvInstance = InstanceType<typeof Ajv2020>;

let ajv: AjvInstance | null = null;
const validators = new Map<SchemaId, ValidateFunction>();

function getAjv(): AjvInstance {
  if (!ajv) {
    ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateSchema: true,
    });
    addFormats(ajv);
  }
  return ajv;
}

function getValidator(schemaId: SchemaId): ValidateFunction {
  const cached = validators.get(schemaId);
  if (cached) {
    return cached;
  }
  const schema = SCHEMA_REGISTRY[schemaId];
  if (!schema) {
    throw new ProtocolError("UNKNOWN_SCHEMA", `unknown schema id: ${schemaId}`);
  }
  const compiled = getAjv().compile(schema);
  validators.set(schemaId, compiled);
  return compiled;
}

function isProtocolVersionFailure(
  errors: ErrorObject[] | null | undefined,
): boolean {
  if (!errors) return false;
  return errors.some(
    (e) =>
      (e.instancePath === "/protocolVersion" ||
        e.instancePath === ".protocolVersion" ||
        e.schemaPath.includes("protocolVersion")) &&
      (e.keyword === "const" || e.keyword === "type" || e.keyword === "required"),
  );
}

/**
 * parseAndValidateSchema — JSON parse (if needed) + Draft 2020-12 validation
 * including additionalProperties: false and protocolVersion const "0.1.0".
 * Does NOT recompute digests.
 *
 * String input uses parseJsonStrict (duplicate keys fail closed).
 */
export function parseAndValidateSchema<T = unknown>(
  document: unknown,
  schemaId: SchemaId,
): T {
  let value: unknown = document;
  if (typeof document === "string") {
    value = parseJsonStrict(document);
  }

  // Full I-JSON structural fail-closed (surrogates, non-plain, cycles, …)
  assertIJsonValue(value);
  // Protocol document numbers: safe integers (stricter than bare JCS)
  assertProtocolNumbers(value);

  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value as object, "protocolVersion")
  ) {
    const pv = (value as { protocolVersion?: unknown }).protocolVersion;
    if (pv !== undefined && pv !== PROTOCOL_VERSION) {
      throw new ProtocolError(
        "UNSUPPORTED_PROTOCOL_VERSION",
        `unsupported protocolVersion: expected "${PROTOCOL_VERSION}", got ${JSON.stringify(pv)}`,
        { protocolVersion: pv },
      );
    }
  }

  const validate = getValidator(schemaId);
  const ok = validate(value);
  if (!ok) {
    const errors = validate.errors ?? [];
    if (isProtocolVersionFailure(errors)) {
      const pv =
        value !== null && typeof value === "object"
          ? (value as { protocolVersion?: unknown }).protocolVersion
          : undefined;
      throw new ProtocolError(
        "UNSUPPORTED_PROTOCOL_VERSION",
        `unsupported or missing protocolVersion (v0.1 accepts only "${PROTOCOL_VERSION}")`,
        { protocolVersion: pv, errors },
      );
    }
    throw new ProtocolError(
      "SCHEMA_VALIDATION_FAILED",
      `schema validation failed for ${schemaId}`,
      { errors },
    );
  }

  return value as T;
}

export interface DigestBindingInput {
  manifest?: BenchmarkManifest;
  evidence?: EvidenceEnvelope;
  verifier?: VerifierDescriptor;
  result?: VerificationResult;
  /**
   * When true (default), run assertMeasurements for manifest+evidence pairs.
   */
  checkMeasurements?: boolean;
}

/**
 * assertDigestBinding — recompute digests and assert cross-object field matches:
 *
 * - evidence ↔ manifest: evidence.manifestDigest === Digest(manifest)
 * - result ↔ evidence: evidenceId, evidenceDigest, manifestDigest
 * - result ↔ verifier: verifierId/id, verifierVersion/version, verifierDigest/digest
 * - self digests: verifier.digest, result.resultDigest
 */
export async function assertDigestBinding(
  input: DigestBindingInput,
): Promise<void> {
  const { manifest, evidence, verifier, result } = input;
  const checkMeasurements = input.checkMeasurements !== false;

  if (manifest) {
    parseAndValidateSchema(manifest, "BenchmarkManifest");
  }
  if (evidence) {
    parseAndValidateSchema(evidence, "EvidenceEnvelope");
  }
  if (verifier) {
    parseAndValidateSchema(verifier, "VerifierDescriptor");
  }
  if (result) {
    parseAndValidateSchema(result, "VerificationResult");
  }

  // evidence ↔ manifest
  if (manifest && evidence) {
    const expected = await digestManifest(manifest);
    assertDigestFormat(evidence.manifestDigest);
    if (evidence.manifestDigest !== expected) {
      throw new ProtocolError(
        "DIGEST_MISMATCH",
        "evidence.manifestDigest does not match Digest(manifest)",
        { expected, actual: evidence.manifestDigest },
      );
    }
  }

  // verifier self-digest
  if (verifier) {
    const expectedV = await digestVerifier(verifier);
    if (verifier.digest !== expectedV) {
      throw new ProtocolError(
        "DIGEST_MISMATCH",
        "verifier.digest does not match Digest(verifier without digest)",
        { expected: expectedV, actual: verifier.digest },
      );
    }
  }

  // result ↔ evidence field bindings + recomputed evidence digest
  if (result && evidence) {
    if (result.evidenceId !== evidence.evidenceId) {
      throw new ProtocolError(
        "BINDING_MISMATCH",
        "result.evidenceId does not match evidence.evidenceId",
        { expected: evidence.evidenceId, actual: result.evidenceId },
      );
    }
    if (result.manifestDigest !== evidence.manifestDigest) {
      throw new ProtocolError(
        "BINDING_MISMATCH",
        "result.manifestDigest does not match evidence.manifestDigest",
        {
          expected: evidence.manifestDigest,
          actual: result.manifestDigest,
        },
      );
    }
    const expectedEv = await digestEvidence(evidence);
    assertDigestFormat(result.evidenceDigest);
    if (result.evidenceDigest !== expectedEv) {
      throw new ProtocolError(
        "DIGEST_MISMATCH",
        "result.evidenceDigest does not match Digest(evidence without signature)",
        { expected: expectedEv, actual: result.evidenceDigest },
      );
    }
  } else if (result && !evidence) {
    // still validate format when alone
    assertDigestFormat(result.evidenceDigest);
    assertDigestFormat(result.manifestDigest);
  } else if (evidence && !result) {
    // evidence alone: digest recompute not required beyond schema
  }

  // result ↔ verifier
  if (result && verifier) {
    if (result.verifierId !== verifier.id) {
      throw new ProtocolError(
        "BINDING_MISMATCH",
        "result.verifierId does not match verifier.id",
        { expected: verifier.id, actual: result.verifierId },
      );
    }
    if (result.verifierVersion !== verifier.version) {
      throw new ProtocolError(
        "BINDING_MISMATCH",
        "result.verifierVersion does not match verifier.version",
        { expected: verifier.version, actual: result.verifierVersion },
      );
    }
    if (result.verifierDigest !== verifier.digest) {
      throw new ProtocolError(
        "BINDING_MISMATCH",
        "result.verifierDigest does not match verifier.digest",
        { expected: verifier.digest, actual: result.verifierDigest },
      );
    }
  }

  // result ↔ manifest (when both present, digest equality)
  if (result && manifest) {
    const expectedM = await digestManifest(manifest);
    if (result.manifestDigest !== expectedM) {
      throw new ProtocolError(
        "DIGEST_MISMATCH",
        "result.manifestDigest does not match Digest(manifest)",
        { expected: expectedM, actual: result.manifestDigest },
      );
    }
  }

  if (result) {
    const expectedR = await digestResult(result);
    if (result.resultDigest !== expectedR) {
      throw new ProtocolError(
        "DIGEST_MISMATCH",
        "result.resultDigest does not match Digest(result without resultDigest+signature)",
        { expected: expectedR, actual: result.resultDigest },
      );
    }
  }

  if (checkMeasurements && manifest && evidence) {
    assertMeasurements(manifest, evidence);
  }
}

export { assertDigestFormat, computeDigest } from "./digest.js";
export {
  assertMeasurements,
  assertRequiredMeasurements,
} from "./measurements.js";
