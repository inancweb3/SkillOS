/**
 * SkillOS-owned hard-gate catalog v0.1 for portable offline-eval bundles.
 *
 * Catalog codes are stable SkillOS disqualification strings emitted on
 * VerificationResult.disqualifications when a hard gate fires.
 *
 * Producer codes (e.g. Simpl3 EXECUTE_ATTEMPT_HARD_FAILURE) are mapped here.
 * Unknown producer codes fail closed to the generic `hard_failure` code — never dropped.
 *
 * Verifier version 0.2.0 binds this catalog immutably (see types.ts VERIFIER_CATALOG_BINDING).
 *
 * Do not invent undetectable gates from private preimage or non-portable fields.
 * Provenance tamper remains fail-closed at verify/load; this catalog only surfaces
 * producer-declared provenance codes when present on an already-accepted bundle body.
 */

import { BundleConsumerError } from "./errors.js";
import type { OfflineEvalBundleBody } from "./types.js";

/** Hard-gate catalog version (independent of protocolVersion / bundleVersion). */
export const HARD_GATE_CATALOG_VERSION = "0.1.0" as const;

/**
 * Canonical hard-gate codes (stable order for report inventory).
 * Order is fixed for deterministic disqualification lists when multiple fire.
 */
export const HARD_GATE_CODES = [
  "pause_violation",
  "execute_attempt",
  "secret_leakage",
  "provider_allowlist_violation",
  "budget_violation",
  "provenance_tamper",
  "hard_failure",
] as const;

export type HardGateCode = (typeof HARD_GATE_CODES)[number];

const HARD_GATE_CODE_SET: ReadonlySet<string> = new Set(HARD_GATE_CODES);

/**
 * Exact canonical pathStage / path_stage value for Simpl3 execute-attempt hard deny.
 * Matched case-insensitively after trim; substring matching is intentionally not used.
 */
export const CANONICAL_EXECUTE_ATTEMPT_PATH = "execute_attempt_hard_deny" as const;

/**
 * Known producer hardFailureCode / evidence hard_failure_code → catalog code.
 * Keys are matched case-insensitively after exact lookup.
 */
const PRODUCER_CODE_TO_CATALOG: Readonly<Record<string, HardGateCode>> = {
  // Simpl3 offline-eval runner (v0.1)
  EXECUTE_ATTEMPT_HARD_FAILURE: "execute_attempt",
  // Catalog-native / snake_case aliases
  pause_violation: "pause_violation",
  PAUSE_VIOLATION: "pause_violation",
  execute_attempt: "execute_attempt",
  EXECUTE_ATTEMPT: "execute_attempt",
  secret_leakage: "secret_leakage",
  SECRET_LEAKAGE: "secret_leakage",
  provider_allowlist_violation: "provider_allowlist_violation",
  PROVIDER_ALLOWLIST_VIOLATION: "provider_allowlist_violation",
  budget_violation: "budget_violation",
  BUDGET_VIOLATION: "budget_violation",
  provenance_tamper: "provenance_tamper",
  PROVENANCE_TAMPER: "provenance_tamper",
  hard_failure: "hard_failure",
  HARD_FAILURE: "hard_failure",
};

const PRODUCER_CODE_LOWER: ReadonlyMap<string, HardGateCode> = new Map(
  Object.entries(PRODUCER_CODE_TO_CATALOG).map(([k, v]) => [k.toLowerCase(), v]),
);

/**
 * Map a producer-declared hard-failure code to a catalog code.
 * Empty / null / unknown → `hard_failure` (generic; never drop).
 */
export function mapProducerHardFailureCode(
  code: string | null | undefined,
): HardGateCode {
  if (code === null || code === undefined) {
    return "hard_failure";
  }
  if (typeof code !== "string") {
    return "hard_failure";
  }
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return "hard_failure";
  }
  const exact = PRODUCER_CODE_TO_CATALOG[trimmed];
  if (exact) return exact;
  const lower = PRODUCER_CODE_LOWER.get(trimmed.toLowerCase());
  if (lower) return lower;
  if (HARD_GATE_CODE_SET.has(trimmed)) {
    return trimmed as HardGateCode;
  }
  return "hard_failure";
}

export function isCanonicalExecuteAttemptPath(
  path: string | null | undefined,
): boolean {
  if (typeof path !== "string") return false;
  return path.trim().toLowerCase() === CANONICAL_EXECUTE_ATTEMPT_PATH;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

/**
 * Runtime-validate portable body fields used by hard gates before evaluation.
 * Fail closed on wrong types, wrapper/evidence incoherence, and reserved
 * hard-gate measurement type violations. Does not invent private preimage checks.
 */
export function assertPortableHardGateBody(body: OfflineEvalBundleBody): void {
  // --- wrapper types ---
  if (typeof body.hardFailure !== "boolean") {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "body.hardFailure must be a boolean",
    );
  }
  if (!isStringOrNull(body.hardFailureCode)) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "body.hardFailureCode must be string or null",
    );
  }
  if (typeof body.decision !== "string" || body.decision.length === 0) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "body.decision must be a non-empty string",
    );
  }
  if (!isStringOrNull(body.pathStage)) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "body.pathStage must be string or null",
    );
  }
  if (!isStringOrNull(body.pathOutcome)) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "body.pathOutcome must be string or null",
    );
  }
  if (
    typeof body.logicalLatencyTotalMs !== "number" ||
    !Number.isFinite(body.logicalLatencyTotalMs)
  ) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "body.logicalLatencyTotalMs must be a finite number",
    );
  }
  if (
    !body.scenario ||
    typeof body.scenario !== "object" ||
    typeof body.scenario.scenarioId !== "string" ||
    body.scenario.scenarioId.length === 0
  ) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "body.scenario.scenarioId must be a non-empty string",
    );
  }

  const bag = body.evidence?.measurements ?? {};

  // --- reserved hard-gate measurement types when present ---
  if (Object.prototype.hasOwnProperty.call(bag, "hard_failure")) {
    if (typeof bag.hard_failure !== "boolean") {
      throw new BundleConsumerError(
        "MEASUREMENTS_INVALID",
        "evidence.measurements.hard_failure must be boolean when present",
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(bag, "hard_failure_code")) {
    if (typeof bag.hard_failure_code !== "string") {
      throw new BundleConsumerError(
        "MEASUREMENTS_INVALID",
        "evidence.measurements.hard_failure_code must be string when present",
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(bag, "path_stage")) {
    if (typeof bag.path_stage !== "string") {
      throw new BundleConsumerError(
        "MEASUREMENTS_INVALID",
        "evidence.measurements.path_stage must be string when present",
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(bag, "path_outcome")) {
    if (typeof bag.path_outcome !== "string") {
      throw new BundleConsumerError(
        "MEASUREMENTS_INVALID",
        "evidence.measurements.path_outcome must be string when present",
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(bag, "decision")) {
    if (typeof bag.decision !== "string" || bag.decision.length === 0) {
      throw new BundleConsumerError(
        "MEASUREMENTS_INVALID",
        "evidence.measurements.decision must be a non-empty string when present",
      );
    }
  }

  // --- wrapper / evidence coherence (boolean hard flags) ---
  if (Object.prototype.hasOwnProperty.call(bag, "hard_failure")) {
    if (bag.hard_failure !== body.hardFailure) {
      throw new BundleConsumerError(
        "BUNDLE_INVALID",
        "body.hardFailure must equal evidence.measurements.hard_failure when both present",
      );
    }
  }

  // Code presence coherence: if both sides declare a non-empty code they may differ
  // (union mapping preserves execute_attempt). Empty vs non-empty with hardFailure
  // true is allowed (fallback mapping). If hardFailure is false, codes must be absent
  // or empty on both sides.
  const bodyCode =
    typeof body.hardFailureCode === "string" && body.hardFailureCode.length > 0
      ? body.hardFailureCode
      : null;
  const evidenceCode =
    typeof bag.hard_failure_code === "string" && bag.hard_failure_code.length > 0
      ? bag.hard_failure_code
      : null;

  if (!body.hardFailure) {
    // No hard failure: residual codes are incoherent
    if (bodyCode !== null || evidenceCode !== null) {
      throw new BundleConsumerError(
        "BUNDLE_INVALID",
        "hardFailureCode / hard_failure_code must be absent when hardFailure is false",
      );
    }
  }

  // Path stage coherence when both present
  if (
    body.pathStage !== null &&
    Object.prototype.hasOwnProperty.call(bag, "path_stage")
  ) {
    if (body.pathStage !== bag.path_stage) {
      throw new BundleConsumerError(
        "BUNDLE_INVALID",
        "body.pathStage must equal evidence.measurements.path_stage when both present",
      );
    }
  }

  // Decision coherence when evidence decision present
  if (Object.prototype.hasOwnProperty.call(bag, "decision")) {
    if (bag.decision !== body.decision) {
      throw new BundleConsumerError(
        "BUNDLE_INVALID",
        "body.decision must equal evidence.measurements.decision when both present",
      );
    }
  }

  // Path outcome coherence when both present
  if (
    body.pathOutcome !== null &&
    Object.prototype.hasOwnProperty.call(bag, "path_outcome")
  ) {
    if (body.pathOutcome !== bag.path_outcome) {
      throw new BundleConsumerError(
        "BUNDLE_INVALID",
        "body.pathOutcome must equal evidence.measurements.path_outcome when both present",
      );
    }
  }
}

export type HardGateEvaluation = {
  /** True when any hard gate fires (status must be rejected). */
  hardFailure: boolean;
  /** Catalog codes in stable catalog order (deduped, union of all sources). */
  disqualifications: HardGateCode[];
  /**
   * Whether any producer code string was present (raw value is never exported —
   * only catalog-mapped disqualifications appear on the report surface).
   */
  producerCodePresent: boolean;
  /** Diagnostic signal labels only — fixed allowlisted tokens, no raw producer strings. */
  signals: string[];
};

/**
 * Evaluate hard gates from allowlisted portable bundle fields only.
 * Call after assertPortableHardGateBody.
 *
 * Sources (SkillOS consumer policy, no Simpl3 import):
 * - body.hardFailure / body.hardFailureCode
 * - evidence.measurements.hard_failure / hard_failure_code
 * - exact canonical pathStage / path_stage = execute_attempt_hard_deny
 *
 * Multiple mapped codes are **unioned** (never suppress execute_attempt).
 * Honest pause/budget scenarios without hardFailure / execute path remain verified.
 */
export function evaluateHardGates(
  body: OfflineEvalBundleBody,
): HardGateEvaluation {
  const signals: string[] = [];
  const fired = new Set<HardGateCode>();

  const bodyHard = body.hardFailure === true;
  const meas = body.evidence.measurements ?? {};
  const evidenceHard = meas.hard_failure === true;

  const bodyCode =
    typeof body.hardFailureCode === "string" && body.hardFailureCode.length > 0
      ? body.hardFailureCode
      : null;
  const evidenceCode =
    typeof meas.hard_failure_code === "string" &&
    meas.hard_failure_code.length > 0
      ? meas.hard_failure_code
      : null;

  const producerCodePresent = bodyCode !== null || evidenceCode !== null;

  if (bodyHard) signals.push("body.hardFailure");
  if (evidenceHard) signals.push("evidence.hard_failure");

  if (bodyHard || evidenceHard) {
    const codesToMap: Array<string | null> = [];
    if (bodyCode !== null) codesToMap.push(bodyCode);
    if (evidenceCode !== null && evidenceCode !== bodyCode) {
      codesToMap.push(evidenceCode);
    }
    if (codesToMap.length === 0) {
      codesToMap.push(null);
    }
    for (const c of codesToMap) {
      fired.add(mapProducerHardFailureCode(c));
    }
    signals.push("producerCode:present_or_absent_mapped");
  }

  // Exact canonical execute-attempt path (body and/or evidence) — never lost.
  const pathBody = body.pathStage;
  const pathMeas =
    typeof meas.path_stage === "string" ? meas.path_stage : null;
  if (
    isCanonicalExecuteAttemptPath(pathBody) ||
    isCanonicalExecuteAttemptPath(pathMeas)
  ) {
    fired.add("execute_attempt");
    signals.push("pathStage:execute_attempt_hard_deny");
  }

  // Stable catalog order
  const disqualifications = HARD_GATE_CODES.filter((c) => fired.has(c));
  for (const c of disqualifications) {
    signals.push(`catalog:${c}`);
  }

  return {
    hardFailure: disqualifications.length > 0,
    disqualifications,
    producerCodePresent,
    signals,
  };
}
