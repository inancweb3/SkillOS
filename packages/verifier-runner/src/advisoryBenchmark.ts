/**
 * Advisory CI benchmark report (v0.1) — batch rows over portable offline-eval
 * goldens using the existing deterministic verifier + multi-axis surface.
 *
 * Evidence only:
 * - advisory: true
 * - promotionAuthority: false
 * - executionAuthority: false
 *
 * No EXECUTE, no Simpl3 authority, no auto-promotion, no merge mandate from
 * rejected rows. Fail-closed row errors never invent status=verified.
 */

import { basename, join } from "node:path";
import {
  HARD_GATE_CATALOG_VERSION,
  type HardGateCode,
} from "./hardGates.js";
import { loadBundleFile } from "./load.js";
import {
  MULTI_AXIS_REPORT_VERSION,
  type AxisReportEntry,
} from "./multiAxis.js";
import { sanitizeReportLabel } from "./reportSafe.js";
import { runDeterministicBundleVerifier } from "./run.js";
import {
  VERIFIER_CATALOG_BINDING,
  VERIFIER_ID,
  VERIFIER_VERSION,
  type OfflineEvalBundle,
} from "./types.js";

export const ADVISORY_BENCHMARK_REPORT_VERSION = "0.1.0" as const;

/** Locked portable golden filenames (must match GOLDEN_LOCK.json). */
export const ADVISORY_GOLDEN_FILES = [
  "budget.portable.bundle.json",
  "pause.portable.bundle.json",
  "provider-outage.portable.bundle.json",
  "risk-tier.portable.bundle.json",
] as const;

export type AdvisoryNumericAxis = {
  /** Sanitized measurement id (never raw producer string if unsafe). */
  id: string;
  numericValue: number;
  gate: AxisReportEntry["gate"];
};

export type AdvisoryBenchmarkRow = {
  /** Stable row identity: scenarioId + fixture basename. */
  rowId: string;
  scenarioId: string;
  /** Static fixture tag (basename stem); no live model calls. */
  configLabel: string;
  fixtureFile: string;
  status: "verified" | "rejected" | "error";
  disqualifications: HardGateCode[];
  /**
   * Effective VerificationResult.verifiedAt used when computing resultDigest
   * (options.verifiedAt override, else evidence.createdAt). Required for
   * cross-run digest attribution (architecture A-1). Null on error rows.
   */
  verifiedAt: string | null;
  bundleDigest: string | null;
  evidenceDigest: string | null;
  manifestDigest: string | null;
  resultDigest: string | null;
  verifierDigest: string | null;
  numericAxes: AdvisoryNumericAxis[];
  /**
   * Present only when load/verify/schema failed for this row.
   * Fail-closed: never invent verified.
   * **Public surface is code-only** — never raw exception/verifier messages,
   * paths, or producer preimage (F-001).
   */
  error?: {
    /** Stable public error code (allowlisted or TOOL_ERROR). */
    code: string;
  };
};

export type AdvisoryBenchmarkSummary = {
  totalRows: number;
  verified: number;
  rejected: number;
  error: number;
  /** Catalog code → count (stable code order when serialized via builder). */
  hardGateHistogram: Record<string, number>;
};

export type AdvisoryBenchmarkReport = {
  reportVersion: typeof ADVISORY_BENCHMARK_REPORT_VERSION;
  advisory: true;
  promotionAuthority: false;
  executionAuthority: false;
  verifierId: typeof VERIFIER_ID;
  verifierVersion: typeof VERIFIER_VERSION;
  catalogVersion: typeof HARD_GATE_CATALOG_VERSION;
  multiAxisReportVersion: typeof MULTI_AXIS_REPORT_VERSION;
  /** Optional CI bindings — empty string when offline / unset. */
  gitSha: string;
  workflowRunId: string;
  rows: AdvisoryBenchmarkRow[];
  summary: AdvisoryBenchmarkSummary;
};

export type AdvisoryBenchmarkRunOptions = {
  /**
   * Fixed VerificationResult.verifiedAt for deterministic digests in tests.
   * Defaults to each bundle's evidence.createdAt via the runner.
   */
  verifiedAt?: string;
  /** Optional GITHUB_SHA / override (never required for offline). */
  gitSha?: string;
  /** Optional GITHUB_RUN_ID / override. */
  workflowRunId?: string;
};

export type AdvisoryFixtureSpec = {
  /** Absolute or relative path to portable bundle JSON. */
  path: string;
  /** Basename used in rowId / fixtureFile (defaults to path basename). */
  file?: string;
  /** Optional static config label (defaults to basename stem). */
  configLabel?: string;
};

function fixtureStem(file: string): string {
  return file.replace(/\.portable\.bundle\.json$/i, "").replace(/\.json$/i, "");
}

/**
 * Known public row/tool error codes. Unknown codes collapse to TOOL_ERROR so
 * raw provider/OS messages never become the public code string.
 */
const PUBLIC_ERROR_CODES: ReadonlySet<string> = new Set([
  "LOAD_FAILED",
  "CLI_USAGE",
  "CLI_OUTPUT",
  "BUNDLE_INVALID",
  "BUNDLE_UNKNOWN_FIELD",
  "BUNDLE_MISSING_FIELD",
  "BUNDLE_DIGEST_MISMATCH",
  "MEASUREMENTS_INVALID",
  "SCHEMA_INVALID",
  "IDENTITY_INVALID",
  "PROVENANCE_INVALID",
  "TRACE_INVALID",
  "TRACE_ARTIFACT_COUNT",
  "TOOL_ERROR",
]);

/**
 * Map any internal/error code to a public allowlisted token.
 * Never returns caller-controlled free text.
 */
export function publicErrorCode(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) {
    return "TOOL_ERROR";
  }
  const sanitized = sanitizeReportLabel(raw);
  if (sanitized === "[omitted:unsafe_label]") return "TOOL_ERROR";
  if (PUBLIC_ERROR_CODES.has(sanitized)) return sanitized;
  // Allow other UPPER_SNAKE codes that already passed label charset (stable, no secrets)
  if (/^[A-Z][A-Z0-9_]{0,62}$/.test(sanitized)) return sanitized;
  return "TOOL_ERROR";
}

/** Sanitize fixture basename / caller file label for report emission. */
export function sanitizeFixtureFileLabel(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    return sanitizeReportLabel("unknown");
  }
  // Basename only — never full filesystem paths on the report surface
  const base = basename(raw);
  return sanitizeReportLabel(base);
}

/**
 * CI binding labels (gitSha / workflowRunId): empty when unset or unsafe.
 * Never copy arbitrary env strings that could hold secrets.
 */
export function sanitizeCiBinding(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return "";
  if (raw.length === 0) return "";
  if (raw.length > 128) return "";
  const sanitized = sanitizeReportLabel(raw);
  return sanitized === "[omitted:unsafe_label]" ? "" : sanitized;
}

function projectNumericAxes(axes: AxisReportEntry[]): AdvisoryNumericAxis[] {
  const out: AdvisoryNumericAxis[] = [];
  for (const axis of axes) {
    if (typeof axis.numericValue !== "number" || !Number.isFinite(axis.numericValue)) {
      continue;
    }
    out.push({
      id: sanitizeReportLabel(axis.id),
      numericValue: axis.numericValue,
      gate: axis.gate,
    });
  }
  // Stable order by sanitized id
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function emptyHistogram(): Record<string, number> {
  // Fixed key order for stable JSON
  const h: Record<string, number> = {};
  for (const code of [
    "pause_violation",
    "execute_attempt",
    "secret_leakage",
    "provider_allowlist_violation",
    "budget_violation",
    "provenance_tamper",
    "hard_failure",
  ] as const) {
    h[code] = 0;
  }
  return h;
}

function buildSummary(rows: AdvisoryBenchmarkRow[]): AdvisoryBenchmarkSummary {
  const hardGateHistogram = emptyHistogram();
  let verified = 0;
  let rejected = 0;
  let error = 0;
  for (const row of rows) {
    if (row.status === "verified") verified += 1;
    else if (row.status === "rejected") rejected += 1;
    else error += 1;
    for (const code of row.disqualifications) {
      const prev = hardGateHistogram[code] ?? 0;
      hardGateHistogram[code] = prev + 1;
    }
  }
  return {
    totalRows: rows.length,
    verified,
    rejected,
    error,
    hardGateHistogram,
  };
}

/**
 * Build one advisory row from an in-memory portable bundle (production seam:
 * runDeterministicBundleVerifier).
 */
export async function buildAdvisoryRowFromBundle(
  bundle: OfflineEvalBundle | Record<string, unknown>,
  meta: { file: string; configLabel?: string },
  options: AdvisoryBenchmarkRunOptions = {},
): Promise<AdvisoryBenchmarkRow> {
  const fixtureFile = sanitizeFixtureFileLabel(meta.file);
  const configLabel = sanitizeReportLabel(
    meta.configLabel ?? fixtureStem(typeof meta.file === "string" ? meta.file : "unknown"),
  );

  const outcome = await runDeterministicBundleVerifier(bundle, {
    verifiedAt: options.verifiedAt,
  });

  if (!outcome.ok) {
    const scenarioRaw =
      bundle &&
      typeof bundle === "object" &&
      bundle.scenario &&
      typeof bundle.scenario === "object" &&
      !Array.isArray(bundle.scenario) &&
      typeof (bundle.scenario as { scenarioId?: unknown }).scenarioId ===
        "string"
        ? (bundle.scenario as { scenarioId: string }).scenarioId
        : "unknown";
    const scenarioId = sanitizeReportLabel(scenarioRaw);
    const rowId = sanitizeReportLabel(`${scenarioId}::${fixtureFile}`);
    return {
      rowId,
      scenarioId,
      configLabel,
      fixtureFile,
      status: "error",
      disqualifications: [],
      verifiedAt: null,
      bundleDigest: null,
      evidenceDigest: null,
      manifestDigest: null,
      resultDigest: null,
      verifierDigest: null,
      numericAxes: [],
      // F-001: code only — never outcome.reason (may interpolate secrets/paths)
      error: {
        code: publicErrorCode(outcome.code),
      },
    };
  }

  const scenarioId = outcome.multiAxisReport.scenarioId;
  const rowId = sanitizeReportLabel(`${scenarioId}::${fixtureFile}`);
  const status = outcome.result.status; // verified | rejected
  const disqualifications = [...outcome.result.disqualifications] as HardGateCode[];
  // A-1: record the effective clock the runner bound into resultDigest
  const verifiedAt = sanitizeReportLabel(outcome.result.verifiedAt);

  return {
    rowId,
    scenarioId,
    configLabel,
    fixtureFile,
    status,
    disqualifications,
    verifiedAt,
    bundleDigest: outcome.bundleDigest,
    evidenceDigest: outcome.result.evidenceDigest,
    manifestDigest: outcome.result.manifestDigest,
    resultDigest: outcome.result.resultDigest,
    verifierDigest: outcome.result.verifierDigest,
    numericAxes: projectNumericAxes(outcome.multiAxisReport.axes),
  };
}

/**
 * Build AdvisoryBenchmarkReport from an ordered list of fixture specs.
 * Row order follows input order. Failures become status=error rows (report still builds).
 */
export async function buildAdvisoryBenchmarkReport(
  fixtures: AdvisoryFixtureSpec[],
  options: AdvisoryBenchmarkRunOptions = {},
): Promise<AdvisoryBenchmarkReport> {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error("advisory benchmark requires at least one fixture");
  }

  const rows: AdvisoryBenchmarkRow[] = [];
  for (const spec of fixtures) {
    const rawFile = spec.file ?? basename(spec.path);
    const fixtureFile = sanitizeFixtureFileLabel(rawFile);
    let bundle: Record<string, unknown>;
    try {
      bundle = loadBundleFile(spec.path);
    } catch (err) {
      // F-001: never copy err.message (paths, OS diagnostics) into the report
      const code =
        err && typeof err === "object" && "code" in err
          ? publicErrorCode((err as { code: string }).code)
          : "LOAD_FAILED";
      const configLabel = sanitizeReportLabel(
        spec.configLabel ?? fixtureStem(rawFile),
      );
      rows.push({
        rowId: sanitizeReportLabel(`unknown::${fixtureFile}`),
        scenarioId: sanitizeReportLabel("unknown"),
        configLabel,
        fixtureFile,
        status: "error",
        disqualifications: [],
        verifiedAt: null,
        bundleDigest: null,
        evidenceDigest: null,
        manifestDigest: null,
        resultDigest: null,
        verifierDigest: null,
        numericAxes: [],
        error: { code },
      });
      continue;
    }

    rows.push(
      await buildAdvisoryRowFromBundle(
        bundle,
        {
          file: rawFile,
          configLabel: spec.configLabel,
        },
        options,
      ),
    );
  }

  // Fail closed if catalog binding drifted
  if (
    VERIFIER_CATALOG_BINDING.verifierVersion !== VERIFIER_VERSION ||
    VERIFIER_CATALOG_BINDING.hardGateCatalogVersion !== HARD_GATE_CATALOG_VERSION ||
    VERIFIER_CATALOG_BINDING.multiAxisReportVersion !== MULTI_AXIS_REPORT_VERSION
  ) {
    throw new Error("VERIFIER_CATALOG_BINDING out of sync for advisory report");
  }

  return {
    reportVersion: ADVISORY_BENCHMARK_REPORT_VERSION,
    advisory: true,
    promotionAuthority: false,
    executionAuthority: false,
    verifierId: VERIFIER_ID,
    verifierVersion: VERIFIER_VERSION,
    catalogVersion: HARD_GATE_CATALOG_VERSION,
    multiAxisReportVersion: MULTI_AXIS_REPORT_VERSION,
    gitSha: sanitizeCiBinding(options.gitSha ?? ""),
    workflowRunId: sanitizeCiBinding(options.workflowRunId ?? ""),
    rows,
    summary: buildSummary(rows),
  };
}

/**
 * True when the report is complete enough to treat as a trustworthy CI emission:
 * expected row count, zero error rows, only verified/rejected statuses.
 * Catalog-valid `rejected` is allowed; `error` is not (F-002).
 */
export function isTrustworthyAdvisoryReport(
  report: AdvisoryBenchmarkReport,
  expectedRows: number = ADVISORY_GOLDEN_FILES.length,
): boolean {
  if (report.rows.length !== expectedRows) return false;
  if (report.summary.error > 0) return false;
  if (report.summary.totalRows !== expectedRows) return false;
  for (const row of report.rows) {
    if (row.status === "error") return false;
    if (row.status !== "verified" && row.status !== "rejected") return false;
  }
  return true;
}

/**
 * Run advisory benchmark over the four locked portable goldens in `fixturesDir`.
 */
export async function buildAdvisoryBenchmarkFromGoldenFixtures(
  fixturesDir: string,
  options: AdvisoryBenchmarkRunOptions = {},
): Promise<AdvisoryBenchmarkReport> {
  const specs: AdvisoryFixtureSpec[] = ADVISORY_GOLDEN_FILES.map((file) => ({
    path: join(fixturesDir, file),
    file,
    configLabel: fixtureStem(file),
  }));
  return buildAdvisoryBenchmarkReport(specs, options);
}

/** One-line human summary for stderr (catalog counts + non-authority reminder). */
export function formatAdvisoryBenchmarkHuman(
  report: AdvisoryBenchmarkReport,
): string {
  const s = report.summary;
  const hist = Object.entries(s.hardGateHistogram)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(",");
  return [
    `advisory-benchmark v${report.reportVersion}`,
    `advisory=${report.advisory}`,
    `promotionAuthority=${report.promotionAuthority}`,
    `executionAuthority=${report.executionAuthority}`,
    `rows=${s.totalRows}`,
    `verified=${s.verified}`,
    `rejected=${s.rejected}`,
    `error=${s.error}`,
    hist ? `gates:{${hist}}` : "gates:{}",
    `verifier=${report.verifierId}@${report.verifierVersion}`,
    "(not EXECUTE; not promotion; not Simpl3 authority)",
  ].join(" ");
}
