import {
  PROTOCOL_VERSION,
  assertDigestBinding,
  assertMeasurements,
  digestEvidence,
  digestResult,
  digestVerifier,
  parseAndValidateSchema,
  type VerificationResult,
  type VerifierDescriptor,
} from "@skillos/protocol";
import { BundleConsumerError } from "./errors.js";
import {
  assertPortableHardGateBody,
  evaluateHardGates,
  HARD_GATE_CATALOG_VERSION,
} from "./hardGates.js";
import {
  buildHardFailureReport,
  buildMultiAxisReport,
  declaredNumericMeasurements,
  MULTI_AXIS_REPORT_VERSION,
  type HardFailureReport,
  type MultiAxisReport,
} from "./multiAxis.js";
import {
  LEGACY_VERIFIER_DIGEST,
  LEGACY_VERIFIER_VERSION,
  PRE_SANITIZE_VERIFIER_VERSION,
  VERIFIER_CATALOG_BINDING,
  VERIFIER_ID,
  VERIFIER_VERSION,
  type OfflineEvalBundle,
  type OfflineEvalBundleBody,
  type RunVerifierOptions,
} from "./types.js";
import { verifyPortableOfflineEvalBundle } from "./verify.js";

export type RunVerifierSuccess = {
  ok: true;
  bundleDigest: string;
  body: OfflineEvalBundleBody;
  verifier: VerifierDescriptor;
  result: VerificationResult;
  /** Structured multi-axis + hard-gate report bound to result digests. */
  multiAxisReport: MultiAxisReport;
  /** Present when hard gate rejects; null when verified. */
  hardFailureReport: HardFailureReport | null;
};

export type RunVerifierFailure = {
  ok: false;
  code: string;
  reason: string;
};

export type RunVerifierOutcome = RunVerifierSuccess | RunVerifierFailure;

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
  // Fail closed if we accidentally claim legacy or pre-sanitize identity.
  if (verifier.version === LEGACY_VERIFIER_VERSION) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "refusing to emit legacy verifier version for multi-axis gate semantics",
    );
  }
  if (verifier.version === PRE_SANITIZE_VERIFIER_VERSION) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "refusing to emit pre-sanitize verifier version for measurement-id report projection",
    );
  }
  if (verifier.digest === LEGACY_VERIFIER_DIGEST) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "refusing to emit legacy verifier digest for multi-axis gate semantics",
    );
  }
  if (
    VERIFIER_CATALOG_BINDING.verifierVersion !== VERIFIER_VERSION ||
    VERIFIER_CATALOG_BINDING.hardGateCatalogVersion !== HARD_GATE_CATALOG_VERSION ||
    VERIFIER_CATALOG_BINDING.multiAxisReportVersion !== MULTI_AXIS_REPORT_VERSION
  ) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "VERIFIER_CATALOG_BINDING out of sync with VERIFIER_VERSION / catalog / report",
    );
  }
  return verifier;
}

/**
 * Verify a portable offline-eval bundle and emit a protocol-valid VerificationResult
 * bound to evidence + verifier digests (signature optional per v0.1), plus a
 * multi-axis / hard-failure report (SkillOS consumer surface, not protocol schema).
 */
export async function runDeterministicBundleVerifier(
  bundle: OfflineEvalBundle | Record<string, unknown>,
  options: RunVerifierOptions = {},
): Promise<RunVerifierOutcome> {
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

  // F-001: runtime-validate gate-related portable body fields (types + coherence).
  try {
    assertPortableHardGateBody(body);
  } catch (err) {
    if (err instanceof BundleConsumerError) {
      return { ok: false, code: err.code, reason: err.message };
    }
    return {
      ok: false,
      code: "BUNDLE_INVALID",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let verifier: VerifierDescriptor;
  try {
    verifier = await buildVerifierDescriptor();
  } catch (err) {
    if (err instanceof BundleConsumerError) {
      return { ok: false, code: err.code, reason: err.message };
    }
    throw err;
  }
  const evidenceDigest = await digestEvidence(body.evidence);

  const evaluation = evaluateHardGates(body);
  const disqualifications = [...evaluation.disqualifications];
  const status: VerificationResult["status"] = evaluation.hardFailure
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

  const multiAxisReport = buildMultiAxisReport({
    body,
    bundleDigest,
    result,
    evaluation,
  });
  const hardFailureReport = buildHardFailureReport(multiAxisReport);

  return {
    ok: true,
    bundleDigest,
    body,
    verifier,
    result,
    multiAxisReport,
    hardFailureReport,
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
  multiAxisReport: MultiAxisReport;
  hardFailureReport: HardFailureReport | null;
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
    multiAxisReport: out.multiAxisReport,
    hardFailureReport: out.hardFailureReport,
  };
}
