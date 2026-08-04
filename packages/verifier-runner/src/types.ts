/**
 * Portable offline-eval bundle types (bundleVersion 0.1.0).
 * Field set matches producer allowlist; SkillOS does not import Simpl3 types.
 */

import type {
  BenchmarkManifest,
  EvidenceEnvelope,
} from "@skillos/protocol";

/** Pinned bundle format version (independent of protocolVersion). */
export const EVAL_BUNDLE_VERSION = "0.1.0" as const;

/** Canonical Simpl3 offline eval producer id (coherence only — no trust of codeCommit). */
export const EVAL_BUNDLE_PRODUCER_ID = "simpl3.offline.eval-runner" as const;

/** Deterministic SkillOS verifier identity for this runner. */
export const VERIFIER_ID = "skillos.offline.bundle-verifier" as const;

/**
 * Verifier implementation version bound into VerificationResult.verifierVersion
 * and VerifierDescriptor.digest.
 *
 * 0.3.0 — multi-axis report surface sanitizes measurement ids via
 * sanitizeReportLabel (fail-closed omission for unsafe labels). Distinct from
 * 0.2.0 which projected raw def.id onto AxisReportEntry.id.
 *
 * 0.2.0 — multi-axis hard-gate catalog evaluation (union codes, execute path,
 * evidence/body coherence, redacted report surface) without id sanitization.
 * Distinct from legacy 0.1.0 which only projected body.hardFailure without
 * catalog mapping.
 *
 * Immutable binding: VERIFIER_VERSION 0.3.0 ↔ HARD_GATE_CATALOG_VERSION 0.1.0
 * ↔ multiAxisReportVersion 0.2.0 (see VERIFIER_CATALOG_BINDING). Do not claim
 * legacy or pre-sanitize identity for this code path.
 */
export const VERIFIER_VERSION = "0.3.0" as const;

/** Pre-multi-axis verifier version (must not be emitted by this implementation). */
export const LEGACY_VERIFIER_VERSION = "0.1.0" as const;

/**
 * Multi-axis catalog verifier without measurement-id sanitization on report
 * surfaces (must not be emitted by this implementation).
 */
export const PRE_SANITIZE_VERIFIER_VERSION = "0.2.0" as const;

/**
 * Pinned legacy VerifierDescriptor digest for id=skillos.offline.bundle-verifier
 * version=0.1.0 capabilities=[deterministic] protocolVersion=0.1.0.
 * New results must not reuse this digest.
 */
export const LEGACY_VERIFIER_DIGEST =
  "sha256:99102b3571cf55d2950fc6c79ade0f32a3d6effd8de58d644b1c74f0a598b474" as const;

/**
 * Immutable mapping from this verifier version to catalog / report surface versions.
 * Protocol VerifierDescriptor cannot carry a catalog digest in v0.1 — consumers
 * must treat verifierVersion as the policy pin.
 *
 * multiAxisReportVersion 0.2.0 = sanitized AxisReportEntry.id projection
 * (pre-sanitize multi-axis report contract was 0.1.0).
 */
export const VERIFIER_CATALOG_BINDING = {
  verifierId: VERIFIER_ID,
  verifierVersion: VERIFIER_VERSION,
  hardGateCatalogVersion: "0.1.0",
  multiAxisReportVersion: "0.2.0",
} as const;

export const BUNDLE_TOOL_TRACE_FIELDS = [
  "tool",
  "args",
  "ok",
  "errorCode",
  "logicalLatencyMs",
  "result",
] as const;

/** Top-level body keys hashed into bundleDigest (no bundleDigest, no diagnostic). */
export const OFFLINE_EVAL_BUNDLE_BODY_KEYS = [
  "bundleVersion",
  "protocolVersion",
  "scenario",
  "producer",
  "decision",
  "hardFailure",
  "hardFailureCode",
  "pathStage",
  "pathOutcome",
  "logicalLatencyTotalMs",
  "provenance",
  "manifest",
  "manifestDigest",
  "evidence",
  "evidenceDigest",
  "toolTrace",
] as const;

export type BundleToolCallRecord = {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  errorCode: string | null;
  logicalLatencyMs: number;
  result: unknown;
};

export type OfflineEvalBundleBody = {
  bundleVersion: typeof EVAL_BUNDLE_VERSION | string;
  protocolVersion: string;
  scenario: {
    scenarioId: string;
    title: string;
    seed: string;
    fixedNow: string;
    mode: string;
  };
  producer: {
    id: string;
    version: string;
    codeCommit: string;
  };
  decision: string;
  hardFailure: boolean;
  hardFailureCode: string | null;
  pathStage: string | null;
  pathOutcome: string | null;
  logicalLatencyTotalMs: number;
  provenance: {
    codeCommit: string;
    configDigest: string;
    inputDigest: string;
    toolCatalogDigest: string;
  };
  manifest: BenchmarkManifest;
  manifestDigest: string;
  evidence: EvidenceEnvelope;
  evidenceDigest: string;
  toolTrace: BundleToolCallRecord[];
};

export type OfflineEvalBundle = OfflineEvalBundleBody & {
  bundleDigest: string;
};

export type BundleVerifyOk = {
  ok: true;
  bundleDigest: string;
  body: OfflineEvalBundleBody;
};

export type BundleVerifyFail = {
  ok: false;
  code: string;
  reason: string;
};

export type BundleVerifyResult = BundleVerifyOk | BundleVerifyFail;

export type RunVerifierOptions = {
  /**
   * ISO-8601 timestamp for VerificationResult.verifiedAt.
   * Defaults to a fixed synthetic clock for deterministic unit tests when set;
   * production CLI uses wall clock unless overridden.
   */
  verifiedAt?: string;
};
