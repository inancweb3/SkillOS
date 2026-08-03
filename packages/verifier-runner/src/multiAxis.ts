/**
 * Multi-axis verification report + hard-failure report (SkillOS consumer surface).
 *
 * Protocol VerificationResult.measurements remains numeric-only (schema).
 * This module builds a structured axis inventory + hard-gate report bound to the
 * same digests as the emitted VerificationResult — no private preimage recompute.
 *
 * F-003: never copies raw producer string measurement values, raw hardFailureCode,
 * or secret/control-character labels into reports or human summaries.
 */

import type {
  BenchmarkManifest,
  EvidenceEnvelope,
  VerificationResult,
} from "@skillos/protocol";
import {
  HARD_GATE_CATALOG_VERSION,
  HARD_GATE_CODES,
  type HardGateCode,
  type HardGateEvaluation,
} from "./hardGates.js";
import { sanitizeReportLabel } from "./reportSafe.js";
import type { OfflineEvalBundleBody } from "./types.js";

export const MULTI_AXIS_REPORT_VERSION = "0.1.0" as const;

export type AxisGate = "pass" | "fail" | "info";

export type AxisValueType = "number" | "boolean" | "string";

export type AxisReportEntry = {
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
    const has = Object.prototype.hasOwnProperty.call(bag, def.id);
    const raw = has ? bag[def.id] : undefined;
    const projected = projectAxisNumeric(valueType, raw);
    const gate = axisGateForMeasurement(def.id, valueType, raw, hardFailure);
    axes.push({
      id: def.id,
      valueType,
      ...projected,
      gate,
    });
  }

  const dq = new Set(disqualifications);
  for (const code of HARD_GATE_CODES) {
    axes.push({
      id: `gate:${code}`,
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
 * Hard-failure report when status is rejected; null when verified.
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
  const disqualifications =
    multi.disqualifications.length > 0
      ? multi.disqualifications
      : (["hard_failure"] as HardGateCode[]);

  const failedAxes = multi.axes.filter((a) => a.gate === "fail");
  const codes = disqualifications.join(",");
  const summary = [
    `hard_failure status=rejected`,
    `disqualifications=${codes}`,
    `scenario=${multi.scenarioId}`,
    `decision=${multi.decision}`,
    multi.producerCodePresent
      ? "producerCode=present"
      : "producerCode=absent",
    `verifier=${multi.verifierVersion}`,
    `catalog=${multi.catalogVersion}`,
  ].join(" ");

  return {
    reportVersion: MULTI_AXIS_REPORT_VERSION,
    catalogVersion: HARD_GATE_CATALOG_VERSION,
    verifierVersion: multi.verifierVersion,
    status: "rejected",
    disqualifications,
    bindings: multi.bindings,
    scenarioId: multi.scenarioId,
    decision: multi.decision,
    producerCodePresent: multi.producerCodePresent,
    hardGateSignals: multi.hardGateSignals,
    summary,
    failedAxes,
  };
}

/** Human-readable one-line summary for CLI stderr (no raw producer strings). */
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
