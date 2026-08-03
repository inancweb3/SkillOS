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
export const VERIFIER_VERSION = "0.1.0" as const;

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
