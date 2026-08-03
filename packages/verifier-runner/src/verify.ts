import {
  ProtocolError,
  assertDigestBinding,
  digestEvidence,
  digestJsonValue,
  digestManifest,
  parseAndValidateSchema,
} from "@skillos/protocol";
import { BundleConsumerError } from "./errors.js";
import {
  assertBundleIdentityCoherence,
  assertPortableInputDigestCoherence,
  assertScenarioIdentityCoherence,
} from "./identity.js";
import { projectOfflineEvalBundleBody } from "./project.js";
import { assertToolTraceConsumerReady } from "./toolTrace.js";
import type {
  BundleVerifyResult,
  OfflineEvalBundle,
  OfflineEvalBundleBody,
} from "./types.js";

/**
 * Nested protocol integrity (fixed order):
 * 1. Schema-validate manifest
 * 2. Schema-validate evidence
 * 3. assertDigestBinding (checkMeasurements: true — fail closed on unknown axes)
 * 4. body.manifestDigest vs Digest(manifest)
 * 5. body.evidenceDigest vs Digest(evidence)
 */
async function assertManifestEvidenceIntegrity(
  body: OfflineEvalBundleBody,
): Promise<void> {
  try {
    parseAndValidateSchema(body.manifest, "BenchmarkManifest");
  } catch (err) {
    throw new BundleConsumerError(
      "MANIFEST_SCHEMA_INVALID",
      err instanceof Error
        ? `manifest schema validation failed: ${err.message}`
        : "manifest schema validation failed",
    );
  }

  try {
    parseAndValidateSchema(body.evidence, "EvidenceEnvelope");
  } catch (err) {
    throw new BundleConsumerError(
      "EVIDENCE_SCHEMA_INVALID",
      err instanceof Error
        ? `evidence schema validation failed: ${err.message}`
        : "evidence schema validation failed",
    );
  }

  try {
    // Fail-closed on unknown/missing/wrong-type measurements (protocol default).
    await assertDigestBinding({
      manifest: body.manifest,
      evidence: body.evidence,
      checkMeasurements: true,
    });
  } catch (err: unknown) {
    if (err instanceof ProtocolError) {
      const code = err.code;
      if (
        code === "UNKNOWN_MEASUREMENT" ||
        code === "MISSING_REQUIRED_MEASUREMENT" ||
        code === "MEASUREMENT_TYPE_MISMATCH" ||
        code === "DUPLICATE_MEASUREMENT_ID" ||
        code === "INVALID_INPUT"
      ) {
        throw new BundleConsumerError(
          "MEASUREMENTS_INVALID",
          `evidence measurements invalid: ${err.message}`,
        );
      }
    }
    throw new BundleConsumerError(
      "EVIDENCE_MANIFEST_BINDING",
      err instanceof Error
        ? `evidence/manifest digest binding failed: ${err.message}`
        : "evidence/manifest digest binding failed",
    );
  }

  const recomputedManifestDigest = await digestManifest(body.manifest);
  if (recomputedManifestDigest !== body.manifestDigest) {
    throw new BundleConsumerError(
      "MANIFEST_DIGEST_MISMATCH",
      "body.manifestDigest does not match recomputed Digest(manifest)",
    );
  }

  const recomputedEvidenceDigest = await digestEvidence(body.evidence);
  if (recomputedEvidenceDigest !== body.evidenceDigest) {
    throw new BundleConsumerError(
      "EVIDENCE_DIGEST_MISMATCH",
      "body.evidenceDigest does not match recomputed Digest(evidence)",
    );
  }
}

/**
 * Fail-closed portable bundle verification (bundle-only; no private scenario).
 *
 * Order:
 * 1. Allowlist projection
 * 2. Nested protocol integrity
 * 3. Version / producer coherence
 * 4. Portable inputDigest coherence
 * 5. scenario.fixedNow ↔ evidence.createdAt
 * 6. toolTrace allowlist + redaction + exactly-one artifact + digest
 * 7. Outer bundleDigest recompute equality
 *
 * Does not import Simpl3. Does not recompute inputDigest from private preimage.
 */
export async function verifyPortableOfflineEvalBundle(
  bundle: OfflineEvalBundle | Record<string, unknown>,
): Promise<BundleVerifyResult> {
  try {
    const rec = bundle as Record<string, unknown>;
    const claimed = rec.bundleDigest;
    if (typeof claimed !== "string" || !claimed.startsWith("sha256:")) {
      return {
        ok: false,
        code: "BUNDLE_DIGEST_INVALID",
        reason: "missing or invalid bundleDigest",
      };
    }

    const body = projectOfflineEvalBundleBody(bundle);

    await assertManifestEvidenceIntegrity(body);
    assertBundleIdentityCoherence(body);
    assertPortableInputDigestCoherence(body.provenance, body.evidence);
    assertScenarioIdentityCoherence(body);
    await assertToolTraceConsumerReady(body.toolTrace, body.evidence);

    const recomputed = await digestJsonValue(body);
    if (recomputed !== claimed) {
      return {
        ok: false,
        code: "BUNDLE_DIGEST_MISMATCH",
        reason: `bundleDigest mismatch: claimed=${claimed} recomputed=${recomputed}`,
      };
    }
    return { ok: true, bundleDigest: recomputed, body };
  } catch (err) {
    if (err instanceof BundleConsumerError) {
      return {
        ok: false,
        code: err.code,
        reason: `${err.code}: ${err.message}`,
      };
    }
    return {
      ok: false,
      code: "BUNDLE_INVALID",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
