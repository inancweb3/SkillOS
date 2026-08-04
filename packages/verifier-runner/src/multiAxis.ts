/**
 * Multi-axis verification report + hard-failure report (SkillOS consumer surface).
 *
 * Protocol VerificationResult.measurements remains numeric-only (schema).
 * This module builds a structured axis inventory + hard-gate report bound to the
 * same digests as the emitted VerificationResult — no private preimage recompute.
 *
 * F-003: never copies raw producer string measurement values, raw hardFailureCode,
 * or secret/control-character labels into reports or human summaries.
 *
 * ## Report-seam invariant (F-004 / F-005)
 *
 * A public package symbol may emit verifier/catalog identity
 * (`reportVersion` / `catalogVersion` / `verifierVersion` on multi-axis or
 * hard-failure reports) only when content derives from
 * `runDeterministicBundleVerifier`. Caller-constructed report/result structures
 * never reach a public identity-stamping path.
 *
 * Builders in this module (`buildMultiAxisReport`, `buildAxisInventory`,
 * `buildHardFailureReport`, `formatHardFailureReportHuman`) are module-local /
 * package-internal only — not re-exported from `src/index.ts`. The package CLI
 * and advisory path that consume reports do so via the runner (or internal
 * imports), not a public synthetic builder surface.
 */

import type {
  BenchmarkManifest,
  EvidenceEnvelope,
  VerificationResult,
} from "@skillos/protocol";
import { BundleConsumerError } from "./errors.js";
import {
  HARD_GATE_CATALOG_VERSION,
  HARD_GATE_CODES,
  type HardGateCode,
  type HardGateEvaluation,
} from "./hardGates.js";
import { sanitizeReportLabel } from "./reportSafe.js";
import {
  LEGACY_VERIFIER_VERSION,
  PRE_SANITIZE_VERIFIER_VERSION,
  VERIFIER_VERSION,
  type OfflineEvalBundleBody,
} from "./types.js";

/**
 * Multi-axis / hard-failure report contract version.
 *
 * 0.2.0 — AxisReportEntry.id is sanitizeReportLabel(def.id) (fail-closed
 * omission for unsafe labels). Distinct from 0.1.0 which projected raw def.id.
 * Bound from VERIFIER_VERSION 0.3.0 via VERIFIER_CATALOG_BINDING.
 */
export const MULTI_AXIS_REPORT_VERSION = "0.2.0" as const;

/** Pre-sanitize multi-axis report contract (raw def.id projection). */
export const LEGACY_MULTI_AXIS_REPORT_VERSION = "0.1.0" as const;

export type AxisGate = "pass" | "fail" | "info";

export type AxisValueType = "number" | "boolean" | "string";

export type AxisReportEntry = {
  /**
   * Sanitized measurement / gate id for report surfaces only.
   * Producer/manifest lookup still uses the raw def.id internally.
   */
  id: string;
  valueType: AxisValueType;
  /** Numeric projection when available (booleans → 0/1). */
  numericValue?: number;
  /**
   * Why numericValue is absent (string axes always omit raw values —
   * never copy producer string preimage into the report).
   */
  omittedReason?: string;
  gate: AxisGate;
};

export type MultiAxisBindings = {
  bundleDigest: string;
  evidenceDigest: string;
  manifestDigest: string;
  resultDigest: string;
  verifierDigest: string;
};

export type MultiAxisReport = {
  reportVersion: typeof MULTI_AXIS_REPORT_VERSION;
  catalogVersion: typeof HARD_GATE_CATALOG_VERSION;
  /** Bound verifier version that produced this report (must not be legacy 0.1.0). */
  verifierVersion: string;
  status: VerificationResult["status"];
  /** Catalog-aligned disqualification codes (stable order). */
  disqualifications: HardGateCode[];
  axes: AxisReportEntry[];
  bindings: MultiAxisBindings;
  /** Sanitized scenario id (never secret/control-char raw). */
  scenarioId: string;
  /** Sanitized decision label. */
  decision: string;
  hardFailure: boolean;
  /** True when a producer code was present; raw string is never exported. */
  producerCodePresent: boolean;
  /** Diagnostic signal labels only — fixed allowlisted tokens. */
  hardGateSignals: string[];
};

export type HardFailureReport = {
  reportVersion: typeof MULTI_AXIS_REPORT_VERSION;
  catalogVersion: typeof HARD_GATE_CATALOG_VERSION;
  verifierVersion: string;
  status: "rejected";
  disqualifications: HardGateCode[];
  bindings: MultiAxisBindings;
  scenarioId: string;
  decision: string;
  producerCodePresent: boolean;
  hardGateSignals: string[];
  /** One-line human summary (catalog codes + sanitized labels only). */
  summary: string;
  /** Axes that gated fail (hard_failure measurement and/or catalog gates). */
  failedAxes: AxisReportEntry[];
};

function projectAxisNumeric(
  valueType: AxisValueType,
  raw: unknown,
): { numericValue?: number; omittedReason?: string } {
  if (raw === undefined) {
    return { omittedReason: "missing" };
  }
  if (valueType === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return { numericValue: raw };
    }
    return { omittedReason: "non_numeric" };
  }
  if (valueType === "boolean") {
    if (typeof raw === "boolean") {
      return { numericValue: raw ? 1 : 0 };
    }
    if (raw === 0 || raw === 1) {
      return { numericValue: raw };
    }
    return { omittedReason: "non_boolean" };
  }
  // string — never project raw producer string into the report
  return { omittedReason: "string_value_omitted" };
}

function axisGateForMeasurement(
  id: string,
  valueType: AxisValueType,
  raw: unknown,
  hardFailure: boolean,
): AxisGate {
  if (id === "hard_failure") {
    if (raw === true || raw === 1 || hardFailure) return "fail";
    return "pass";
  }
  if (id === "hard_failure_code" && hardFailure) {
    return "fail";
  }
  if (valueType === "string") return "info";
  if (raw === undefined) return "info";
  return "pass";
}

/**
 * Build per-axis inventory from manifest.measurements + evidence bag,
 * then append catalog hard-gate rows (pass|fail).
 * String axes expose id/type/omission only — no raw values.
 * Report `id` is always sanitizeReportLabel(def.id) — bag lookup and gate
 * evaluation still use the raw producer/manifest id (R-1 consumer-side only).
 *
 * Internal-only (not exported from package index — F-005). Call only from the
 * validated multi-axis / full-verifier path.
 */
export function buildAxisInventory(
  manifest: BenchmarkManifest,
  evidence: EvidenceEnvelope,
  hardFailure: boolean,
  disqualifications: readonly HardGateCode[],
): AxisReportEntry[] {
  const bag = evidence.measurements ?? {};
  const axes: AxisReportEntry[] = [];

  for (const def of manifest.measurements) {
    const valueType = def.valueType as AxisValueType;
    // Raw id for bag lookup + hard-gate measurement matching only.
    const rawId = def.id;
    const has = Object.prototype.hasOwnProperty.call(bag, rawId);
    const raw = has ? bag[rawId] : undefined;
    const projected = projectAxisNumeric(valueType, raw);
    const gate = axisGateForMeasurement(rawId, valueType, raw, hardFailure);
    axes.push({
      id: sanitizeReportLabel(rawId),
      valueType,
      ...projected,
      gate,
    });
  }

  const dq = new Set(disqualifications);
  for (const code of HARD_GATE_CODES) {
    axes.push({
      id: sanitizeReportLabel(`gate:${code}`),
      valueType: "boolean",
      numericValue: dq.has(code) ? 1 : 0,
      gate: dq.has(code) ? "fail" : "pass",
    });
  }

  return axes;
}

export type BuildMultiAxisInput = {
  body: OfflineEvalBundleBody;
  bundleDigest: string;
  result: VerificationResult;
  evaluation: HardGateEvaluation;
};

/**
 * Pure builder: multi-axis report bound to the same digests as VerificationResult.
 *
 * Internal-only (not exported from package index — F-005). Call only from the
 * validated full-verifier path after hard-gate evaluation.
 */
export function buildMultiAxisReport(input: BuildMultiAxisInput): MultiAxisReport {
  const { body, bundleDigest, result, evaluation } = input;
  const axes = buildAxisInventory(
    body.manifest,
    body.evidence,
    evaluation.hardFailure,
    evaluation.disqualifications,
  );

  return {
    reportVersion: MULTI_AXIS_REPORT_VERSION,
    catalogVersion: HARD_GATE_CATALOG_VERSION,
    verifierVersion: result.verifierVersion,
    status: result.status,
    disqualifications: [...evaluation.disqualifications],
    axes,
    bindings: {
      bundleDigest,
      evidenceDigest: result.evidenceDigest,
      manifestDigest: result.manifestDigest,
      resultDigest: result.resultDigest,
      verifierDigest: result.verifierDigest,
    },
    scenarioId: sanitizeReportLabel(body.scenario.scenarioId),
    decision: sanitizeReportLabel(body.decision),
    hardFailure: evaluation.hardFailure,
    producerCodePresent: evaluation.producerCodePresent,
    hardGateSignals: [...evaluation.signals],
  };
}

/**
 * Fail closed: only stamp current report/catalog/verifier identity when the
 * incoming multi-axis report already claims that exact contract.
 * Refuses legacy (0.1.0), pre-sanitize verifier (0.2.0), and any contradictory
 * tuple rather than upgrading it to the post-sanitize identity.
 *
 * Runtime strings are widened for the checks so callers who forge identity via
 * casts (public boundary) are still rejected; TypeScript-narrowed literals alone
 * must not make legacy/pre-sanitize refuse paths appear dead.
 */
function assertCurrentHardFailureInputIdentity(multi: MultiAxisReport): void {
  const reportVersion = multi.reportVersion as string;
  const catalogVersion = multi.catalogVersion as string;
  const verifierVersion = multi.verifierVersion as string;

  // Explicit refuse of known pre-remediation identities (no silent upgrade).
  if (
    reportVersion === LEGACY_MULTI_AXIS_REPORT_VERSION ||
    verifierVersion === LEGACY_VERIFIER_VERSION ||
    verifierVersion === PRE_SANITIZE_VERIFIER_VERSION
  ) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "hard-failure builder refuses legacy or pre-sanitize report identity",
    );
  }

  if (reportVersion !== MULTI_AXIS_REPORT_VERSION) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      `hard-failure builder refuses reportVersion ${JSON.stringify(reportVersion)}; expected ${MULTI_AXIS_REPORT_VERSION}`,
    );
  }
  if (catalogVersion !== HARD_GATE_CATALOG_VERSION) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      `hard-failure builder refuses catalogVersion ${JSON.stringify(catalogVersion)}; expected ${HARD_GATE_CATALOG_VERSION}`,
    );
  }
  if (verifierVersion !== VERIFIER_VERSION) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      `hard-failure builder refuses verifierVersion ${JSON.stringify(verifierVersion)}; expected ${VERIFIER_VERSION}`,
    );
  }
}

/** Clone a failed axis and re-sanitize id at the hard-failure boundary (F-003). */
function projectFailedAxis(axis: AxisReportEntry): AxisReportEntry {
  const projected: AxisReportEntry = {
    id: sanitizeReportLabel(axis.id),
    valueType: axis.valueType,
    gate: axis.gate,
  };
  if (typeof axis.numericValue === "number" && Number.isFinite(axis.numericValue)) {
    projected.numericValue = axis.numericValue;
  }
  if (typeof axis.omittedReason === "string") {
    projected.omittedReason = axis.omittedReason;
  }
  return projected;
}

/**
 * Hard-failure report when status is rejected; null when verified.
 *
 * Internal-only (not exported from package index — F-004). Call only from the
 * validated multi-axis / full-verifier path after `buildMultiAxisReport`.
 *
 * Boundary is fail-closed (F-003):
 * - re-sanitizes every outgoing failedAxes[].id (never reuses caller axis objects)
 * - refuses legacy / pre-sanitize / contradictory report·catalog·verifier tuples
 * - stamps MULTI_AXIS_REPORT_VERSION + VERIFIER_VERSION only after identity check
 */
export function buildHardFailureReport(
  multi: MultiAxisReport,
): HardFailureReport | null {
  if (multi.status !== "rejected" && !multi.hardFailure) {
    return null;
  }
  if (multi.disqualifications.length === 0 && !multi.hardFailure) {
    return null;
  }

  assertCurrentHardFailureInputIdentity(multi);

  const disqualifications =
    multi.disqualifications.length > 0
      ? ([...multi.disqualifications] as HardGateCode[])
      : (["hard_failure"] as HardGateCode[]);

  // Project failed axes: clone + sanitize id at this boundary (do not trust caller).
  const failedAxes = multi.axes
    .filter((a) => a.gate === "fail")
    .map(projectFailedAxis);

  const scenarioId = sanitizeReportLabel(multi.scenarioId);
  const decision = sanitizeReportLabel(multi.decision);
  const hardGateSignals = multi.hardGateSignals.map((s) =>
    sanitizeReportLabel(s),
  );

  const codes = disqualifications.join(",");
  const summary = [
    `hard_failure status=rejected`,
    `disqualifications=${codes}`,
    `scenario=${scenarioId}`,
    `decision=${decision}`,
    multi.producerCodePresent
      ? "producerCode=present"
      : "producerCode=absent",
    `verifier=${VERIFIER_VERSION}`,
    `catalog=${HARD_GATE_CATALOG_VERSION}`,
  ].join(" ");

  return {
    reportVersion: MULTI_AXIS_REPORT_VERSION,
    catalogVersion: HARD_GATE_CATALOG_VERSION,
    // Stamp current verifier identity only after input identity check above.
    verifierVersion: VERIFIER_VERSION,
    status: "rejected",
    disqualifications,
    bindings: { ...multi.bindings },
    scenarioId,
    decision,
    producerCodePresent: multi.producerCodePresent,
    hardGateSignals,
    summary,
    failedAxes,
  };
}

/**
 * Human-readable one-line summary for CLI stderr (no raw producer strings).
 * Internal-only (not exported from package index — F-005). CLI imports module-local.
 */
export function formatHardFailureReportHuman(
  report: HardFailureReport | null,
  multi: MultiAxisReport,
): string {
  if (report) {
    return report.summary;
  }
  return [
    `status=${multi.status}`,
    `disqualifications=${multi.disqualifications.join(",") || "(none)"}`,
    `scenario=${multi.scenarioId}`,
    `decision=${multi.decision}`,
    `axes=${multi.axes.length}`,
    `verifier=${multi.verifierVersion}`,
    `catalog=${multi.catalogVersion}`,
  ].join(" ");
}

/**
 * Project numeric measurements for protocol VerificationResult (same policy as run.ts).
 */
export function declaredNumericMeasurements(
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
  }
  return out;
}
