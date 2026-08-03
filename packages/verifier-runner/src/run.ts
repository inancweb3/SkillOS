import {
  PROTOCOL_VERSION,
  assertDigestBinding,
  assertMeasurements,
  digestEvidence,
  digestResult,
  digestVerifier,
  parseAndValidateSchema,
  type BenchmarkManifest,
  type EvidenceEnvelope,
  type VerificationResult,
  type VerifierDescriptor,
} from "@skillos/protocol";
import { BundleConsumerError } from "./errors.js";
import {
  VERIFIER_ID,
  VERIFIER_VERSION,
  type OfflineEvalBundle,
  type OfflineEvalBundleBody,
  type RunVerifierOptions,
} from "./types.js";
import { verifyPortableOfflineEvalBundle } from "./verify.js";

async function buildVerifierDescriptor(): Promise<VerifierDescriptor> {
  const body: Omit<VerifierDescriptor, "digest"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: VERIFIER_ID,
    version: VERIFIER_VERSION,
    capabilities: ["deterministic"],
  };
  const verifier: VerifierDescriptor = {
    ...body,
    digest: await digestVerifier(body),
  };
  parseAndValidateSchema(verifier, "VerifierDescriptor");
  return verifier;
}

/**
 * Build VerificationResult.measurements only from manifest-declared definitions.
 * VerificationResult requires a number map — booleans become 0/1; strings are omitted
 * (already validated against the manifest by assertMeasurements).
 */
function declaredNumericMeasurements(
  manifest: BenchmarkManifest,
  evidence: EvidenceEnvelope,
): Record<string, number> {
  const out: Record<string, number> = {};
  const bag = evidence.measurements ?? {};
  for (const def of manifest.measurements) {
    if (!Object.prototype.hasOwnProperty.call(bag, def.id)) continue;
    const v = bag[def.id];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[def.id] = v;
    } else if (typeof v === "boolean") {
      out[def.id] = v ? 1 : 0;
    }
    // string measurements validated but not projected into number-only result map
  }
  return out;
}

/**
 * Verify a portable offline-eval bundle and emit a protocol-valid VerificationResult
 * bound to evidence + verifier digests (signature optional per v0.1).
 */
export async function runDeterministicBundleVerifier(
  bundle: OfflineEvalBundle | Record<string, unknown>,
  options: RunVerifierOptions = {},
): Promise<
  | {
      ok: true;
      bundleDigest: string;
      body: OfflineEvalBundleBody;
      verifier: VerifierDescriptor;
      result: VerificationResult;
    }
  | {
      ok: false;
      code: string;
      reason: string;
    }
> {
  const verified = await verifyPortableOfflineEvalBundle(bundle);
  if (!verified.ok) {
    return verified;
  }

  const { body, bundleDigest } = verified;

  // Second-boundary measurement check before result emission (defense in depth).
  try {
    assertMeasurements(body.manifest, body.evidence);
  } catch (err) {
    return {
      ok: false,
      code: "MEASUREMENTS_INVALID",
      reason: `MEASUREMENTS_INVALID: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const verifier = await buildVerifierDescriptor();
  const evidenceDigest = await digestEvidence(body.evidence);

  const disqualifications: string[] = [];
  if (body.hardFailure) {
    disqualifications.push(body.hardFailureCode ?? "hard_failure");
  }

  const status: VerificationResult["status"] = body.hardFailure
    ? "rejected"
    : "verified";

  const verifiedAt =
    options.verifiedAt ??
    // Deterministic default when omitted: use evidence clock (no wall clock in digests).
    body.evidence.createdAt;

  const base: Omit<VerificationResult, "resultDigest"> = {
    protocolVersion: PROTOCOL_VERSION,
    evidenceId: body.evidence.evidenceId,
    manifestDigest: body.manifestDigest,
    evidenceDigest,
    verifierId: verifier.id,
    verifierVersion: verifier.version,
    verifierDigest: verifier.digest,
    status,
    disqualifications,
    measurements: declaredNumericMeasurements(body.manifest, body.evidence),
    verifiedAt,
  };

  const result: VerificationResult = {
    ...base,
    resultDigest: await digestResult(base as VerificationResult),
  };

  parseAndValidateSchema(result, "VerificationResult");
  try {
    await assertDigestBinding({
      manifest: body.manifest,
      evidence: body.evidence,
      verifier,
      result,
      checkMeasurements: true,
    });
  } catch (err) {
    return {
      ok: false,
      code: "MEASUREMENTS_INVALID",
      reason: `result binding/measurements failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    ok: true,
    bundleDigest,
    body,
    verifier,
    result,
  };
}

/**
 * Throw on verify failure; return success payload. Useful for programmatic APIs.
 */
export async function runDeterministicBundleVerifierOrThrow(
  bundle: OfflineEvalBundle | Record<string, unknown>,
  options: RunVerifierOptions = {},
): Promise<{
  bundleDigest: string;
  body: OfflineEvalBundleBody;
  verifier: VerifierDescriptor;
  result: VerificationResult;
}> {
  const out = await runDeterministicBundleVerifier(bundle, options);
  if (!out.ok) {
    throw new BundleConsumerError(
      (out.code as BundleConsumerError["code"]) || "BUNDLE_INVALID",
      out.reason,
    );
  }
  return {
    bundleDigest: out.bundleDigest,
    body: out.body,
    verifier: out.verifier,
    result: out.result,
  };
}
