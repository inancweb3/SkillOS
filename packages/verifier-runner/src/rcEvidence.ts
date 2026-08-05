/**
 * SkillOS RC benchmark evidence consumer/verify (v0.1).
 *
 * Consumes Simpl3 producer artifacts of kind `simpl3.rc.benchmark.evidence`
 * version `0.2.0` without importing Simpl3 runtime or monorepo paths.
 *
 * Invariants:
 * - verified ≠ promote / EXECUTE / wallet / CDP / x402 spend authority
 * - missing, invalid, tampered, fixture-only, stale, subject-mismatch,
 *   or promote/EXECUTE-true evidence must not yield verified-ready
 * - **RC-02 (consumer):** `expectedCodeCommit` is **mandatory** for
 *   verified-ready. Omitting the subject bind is non-success by construction
 *   (producer residual: optional bind; SkillOS closes it here)
 * - SkillOS result is evidence/digest input only — never promotion authorization
 */

/** Producer kind pin (cross-repo contract). */
export const RC_EVIDENCE_KIND = "simpl3.rc.benchmark.evidence" as const;

/** Producer schema version pin. */
export const RC_EVIDENCE_VERSION = "0.2.0" as const;

/** Provenance modes from producer. */
export const RC_MODES = Object.freeze(["measured", "fixture"] as const);
export type RcMode = (typeof RC_MODES)[number];

/** Gate ids that must all pass for qualityPass (producer contract). */
export const RC_GATE_IDS = Object.freeze([
  "noEnvTracked",
  "typecheck",
  "unitTests",
  "executeHardOff",
] as const);
export type RcGateId = (typeof RC_GATE_IDS)[number];

/** Required top-level fields for a valid evidence object. */
export const RC_EVIDENCE_REQUIRED_KEYS = Object.freeze([
  "kind",
  "version",
  "mode",
  "codeCommit",
  "createdAt",
  "benchmarkEqualsPromote",
  "executeEnabled",
  "promoteAuthorized",
  "gates",
  "qualityPass",
  "rcBenchmarkSatisfied",
] as const);

/** Default max age for createdAt (fail-closed on stale self-consistent forgeries). */
export const RC_DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h
/** Allow small clock skew into the future. */
export const RC_DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5m

/**
 * SkillOS consumer identity for this verify surface (evidence input only;
 * not a multi-axis report seam; not promotion authority).
 */
export const RC_EVIDENCE_VERIFIER_ID =
  "skillos.rc.benchmark.evidence-verifier" as const;
export const RC_EVIDENCE_VERIFIER_VERSION = "0.1.0" as const;

export type RcGateResult = {
  ok: boolean;
  detail?: string;
};

export type RcGateMap = Record<string, RcGateResult>;

/**
 * Canonical validated RC evidence shape (producer allowlist fields).
 * Unknown extra keys may exist on wire objects; consumers must not trust them
 * for readiness. Structural checks use the required set only.
 */
export type RcBenchmarkEvidence = {
  kind: typeof RC_EVIDENCE_KIND;
  version: typeof RC_EVIDENCE_VERSION;
  mode: RcMode;
  codeCommit: string;
  createdAt: string;
  benchmarkEqualsPromote: false;
  executeEnabled: false;
  promoteAuthorized: false;
  gates: RcGateMap;
  qualityPass: boolean;
  rcBenchmarkSatisfied: boolean;
  note?: string;
};

/**
 * Bind / freshness options for structural validate.
 * `expectedCodeCommit` is optional here so fixtures can be shape-checked;
 * verified-ready always requires it (RC-02).
 */
export type RcValidateOptions = {
  expectedCodeCommit?: string;
  now?: number | Date | string;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
};

/**
 * Options for verified-ready. `expectedCodeCommit` is **required** (RC-02).
 * Empty/whitespace is rejected as subject-bind missing.
 */
export type RcVerifiedReadyOptions = {
  expectedCodeCommit: string;
  now?: number | Date | string;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
};

export type RcValidateOk = {
  ok: true;
  evidence: RcBenchmarkEvidence;
};

export type RcValidateFail = {
  ok: false;
  reason: string;
};

export type RcValidateResult = RcValidateOk | RcValidateFail;

export type RcReadyOk = {
  ready: true;
  reason: "RC_BENCHMARK_SATISFIED";
  evidence: RcBenchmarkEvidence;
};

export type RcReadyFail = {
  ready: false;
  reason: string;
};

export type RcReadyResult = RcReadyOk | RcReadyFail;

/**
 * Full consumer verify outcome: structural validate + measured readiness +
 * mandatory subject bind. `verifiedReady` is never true without subject bind.
 * `promoteAuthorized` is always false on this surface.
 */
export type RcVerifyOutcome =
  | {
      ok: true;
      verifiedReady: true;
      reason: "RC_BENCHMARK_SATISFIED";
      evidence: RcBenchmarkEvidence;
      promoteAuthorized: false;
      verifierId: typeof RC_EVIDENCE_VERIFIER_ID;
      verifierVersion: typeof RC_EVIDENCE_VERIFIER_VERSION;
    }
  | {
      ok: true;
      verifiedReady: false;
      reason: string;
      evidence: RcBenchmarkEvidence;
      promoteAuthorized: false;
      verifierId: typeof RC_EVIDENCE_VERIFIER_ID;
      verifierVersion: typeof RC_EVIDENCE_VERIFIER_VERSION;
    }
  | {
      ok: false;
      verifiedReady: false;
      reason: string;
      promoteAuthorized: false;
      verifierId: typeof RC_EVIDENCE_VERIFIER_ID;
      verifierVersion: typeof RC_EVIDENCE_VERIFIER_VERSION;
    };

/** Normalize commit ids for equality (trim; lowercase hex). */
export function normalizeCodeCommit(sha: string): string {
  return String(sha || "")
    .trim()
    .toLowerCase();
}

function isPlausibleCodeCommit(codeCommit: unknown): codeCommit is string {
  if (typeof codeCommit !== "string") return false;
  const s = codeCommit.trim();
  if (s.length < 7) return false;
  return /^[0-9a-fA-F]{7,64}$/.test(s);
}

function parseCreatedAtMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length < 10) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function resolveNowMs(options: RcValidateOptions | undefined): number {
  if (options?.now == null) return Date.now();
  if (typeof options.now === "number" && Number.isFinite(options.now)) {
    return options.now;
  }
  if (options.now instanceof Date) return options.now.getTime();
  if (typeof options.now === "string") {
    const ms = Date.parse(options.now);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

function isNonEmptySubjectBind(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Structural + freshness (+ optional subject) validation.
 * Does not grant readiness or promotion. Tampered quality/satisfied flags fail closed.
 */
export function validateRcBenchmarkEvidence(
  value: unknown,
  options: RcValidateOptions = {},
): RcValidateResult {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "RC_BENCHMARK_INVALID_TYPE" };
  }
  const e = value as Record<string, unknown>;

  for (const k of RC_EVIDENCE_REQUIRED_KEYS) {
    if (!(k in e)) {
      return { ok: false, reason: `RC_BENCHMARK_MISSING_FIELD:${k}` };
    }
  }
  if (e.kind !== RC_EVIDENCE_KIND) {
    return { ok: false, reason: "RC_BENCHMARK_KIND_MISMATCH" };
  }
  if (e.version !== RC_EVIDENCE_VERSION) {
    return { ok: false, reason: "RC_BENCHMARK_VERSION_MISMATCH" };
  }
  if (e.mode !== "measured" && e.mode !== "fixture") {
    return { ok: false, reason: "RC_BENCHMARK_MODE_INVALID" };
  }
  if (!isPlausibleCodeCommit(e.codeCommit)) {
    return { ok: false, reason: "RC_BENCHMARK_CODE_COMMIT_INVALID" };
  }
  const createdMs = parseCreatedAtMs(e.createdAt);
  if (createdMs == null) {
    return { ok: false, reason: "RC_BENCHMARK_CREATED_AT_INVALID" };
  }
  // Structural anti-promote flags — must be hard false
  if (e.benchmarkEqualsPromote !== false) {
    return { ok: false, reason: "RC_BENCHMARK_PROMOTE_FLAG_NOT_FALSE" };
  }
  if (e.executeEnabled !== false) {
    return { ok: false, reason: "RC_BENCHMARK_EXECUTE_ENABLED_NOT_FALSE" };
  }
  if (e.promoteAuthorized !== false) {
    return { ok: false, reason: "RC_BENCHMARK_PROMOTE_AUTHORIZED_NOT_FALSE" };
  }
  if (typeof e.qualityPass !== "boolean") {
    return { ok: false, reason: "RC_BENCHMARK_QUALITY_PASS_INVALID" };
  }
  if (typeof e.rcBenchmarkSatisfied !== "boolean") {
    return { ok: false, reason: "RC_BENCHMARK_SATISFIED_INVALID" };
  }
  if (!e.gates || typeof e.gates !== "object" || Array.isArray(e.gates)) {
    return { ok: false, reason: "RC_BENCHMARK_GATES_INVALID" };
  }
  const gates = e.gates as Record<string, unknown>;
  const normalizedGates: RcGateMap = {};
  for (const id of RC_GATE_IDS) {
    const g = gates[id];
    if (!g || typeof g !== "object" || Array.isArray(g)) {
      return { ok: false, reason: `RC_BENCHMARK_GATE_MISSING:${id}` };
    }
    const rec = g as Record<string, unknown>;
    if (typeof rec.ok !== "boolean") {
      return { ok: false, reason: `RC_BENCHMARK_GATE_OK_INVALID:${id}` };
    }
    normalizedGates[id] = {
      ok: rec.ok === true,
      ...(typeof rec.detail === "string" ? { detail: rec.detail } : {}),
    };
  }

  // Recompute qualityPass / satisfied from gates — reject tampered booleans
  const recomputedQuality = RC_GATE_IDS.every(
    (id) => normalizedGates[id]?.ok === true,
  );
  if (e.qualityPass !== recomputedQuality) {
    return { ok: false, reason: "RC_BENCHMARK_QUALITY_PASS_TAMPER" };
  }
  const recomputedSatisfied =
    recomputedQuality &&
    e.benchmarkEqualsPromote === false &&
    e.executeEnabled === false &&
    e.promoteAuthorized === false;
  if (e.rcBenchmarkSatisfied !== recomputedSatisfied) {
    return { ok: false, reason: "RC_BENCHMARK_SATISFIED_TAMPER" };
  }

  // Freshness (always)
  const nowMs = resolveNowMs(options);
  const maxAgeMs =
    typeof options.maxAgeMs === "number" && options.maxAgeMs >= 0
      ? options.maxAgeMs
      : RC_DEFAULT_MAX_AGE_MS;
  const maxFutureSkewMs =
    typeof options.maxFutureSkewMs === "number" && options.maxFutureSkewMs >= 0
      ? options.maxFutureSkewMs
      : RC_DEFAULT_MAX_FUTURE_SKEW_MS;
  if (createdMs > nowMs + maxFutureSkewMs) {
    return { ok: false, reason: "RC_BENCHMARK_CREATED_AT_FUTURE" };
  }
  if (nowMs - createdMs > maxAgeMs) {
    return { ok: false, reason: "RC_BENCHMARK_CREATED_AT_STALE" };
  }

  // Optional subject bind on validate (when provided)
  if (isNonEmptySubjectBind(options.expectedCodeCommit)) {
    const expected = normalizeCodeCommit(options.expectedCodeCommit);
    const actual = normalizeCodeCommit(String(e.codeCommit));
    if (actual !== expected) {
      return { ok: false, reason: "RC_BENCHMARK_CODE_COMMIT_MISMATCH" };
    }
  }

  const evidence: RcBenchmarkEvidence = {
    kind: RC_EVIDENCE_KIND,
    version: RC_EVIDENCE_VERSION,
    mode: e.mode,
    codeCommit: String(e.codeCommit),
    createdAt: String(e.createdAt),
    benchmarkEqualsPromote: false,
    executeEnabled: false,
    promoteAuthorized: false,
    gates: normalizedGates,
    qualityPass: recomputedQuality,
    rcBenchmarkSatisfied: recomputedSatisfied,
    ...(typeof e.note === "string" ? { note: e.note } : {}),
  };

  return { ok: true, evidence };
}

/**
 * Fail-closed RC verified-ready with **mandatory subject bind (RC-02)**.
 *
 * Equivalent to producer `isRcReady` plus: omit/empty `expectedCodeCommit` →
 * non-success (`RC_BENCHMARK_SUBJECT_BIND_REQUIRED`). Fixture mode never ready.
 * Never grants promotion.
 */
export function isRcBenchmarkVerifiedReady(
  evidenceOrNull: unknown,
  options: RcVerifiedReadyOptions,
): RcReadyResult {
  if (evidenceOrNull == null) {
    return { ready: false, reason: "RC_BENCHMARK_MISSING" };
  }

  // RC-02: subject bind is mandatory for verified-ready (not opt-in).
  if (!isNonEmptySubjectBind(options?.expectedCodeCommit)) {
    return { ready: false, reason: "RC_BENCHMARK_SUBJECT_BIND_REQUIRED" };
  }

  const bind: RcValidateOptions = {
    expectedCodeCommit: options.expectedCodeCommit,
    now: options.now,
    maxAgeMs: options.maxAgeMs,
    maxFutureSkewMs: options.maxFutureSkewMs,
  };
  const v = validateRcBenchmarkEvidence(evidenceOrNull, bind);
  if (!v.ok) {
    return { ready: false, reason: v.reason };
  }
  const e = v.evidence;

  // Provenance: fixture (or any non-measured) never becomes ready
  if (e.mode !== "measured") {
    return { ready: false, reason: "RC_BENCHMARK_FIXTURE_NOT_MEASURED" };
  }
  if (e.rcBenchmarkSatisfied !== true) {
    return { ready: false, reason: "RC_BENCHMARK_NOT_SATISFIED" };
  }
  // promoteAuthorized / executeEnabled / benchmarkEqualsPromote are typed
  // hard-false on RcBenchmarkEvidence after validateRcBenchmarkEvidence.
  // Defense-in-depth against future type widening: reject non-false on wire.
  const wire = evidenceOrNull as Record<string, unknown>;
  if (
    wire.promoteAuthorized === true ||
    wire.benchmarkEqualsPromote === true ||
    wire.executeEnabled === true
  ) {
    return { ready: false, reason: "RC_BENCHMARK_PROMOTE_REJECTED" };
  }

  return {
    ready: true,
    reason: "RC_BENCHMARK_SATISFIED",
    evidence: e,
  };
}

/**
 * Full consumer verify: structural + readiness under mandatory subject bind.
 * Use this as the primary SkillOS entry point for RC evidence input.
 *
 * `verifiedReady === true` only when measured + satisfied + subject bind +
 * freshness all hold. Always `promoteAuthorized: false`.
 */
export function verifyRcBenchmarkEvidence(
  value: unknown,
  options: RcVerifiedReadyOptions,
): RcVerifyOutcome {
  const base = {
    promoteAuthorized: false as const,
    verifierId: RC_EVIDENCE_VERIFIER_ID,
    verifierVersion: RC_EVIDENCE_VERIFIER_VERSION,
  };

  if (value == null) {
    return {
      ok: false,
      verifiedReady: false,
      reason: "RC_BENCHMARK_MISSING",
      ...base,
    };
  }

  if (!isNonEmptySubjectBind(options?.expectedCodeCommit)) {
    return {
      ok: false,
      verifiedReady: false,
      reason: "RC_BENCHMARK_SUBJECT_BIND_REQUIRED",
      ...base,
    };
  }

  const bind: RcValidateOptions = {
    expectedCodeCommit: options.expectedCodeCommit,
    now: options.now,
    maxAgeMs: options.maxAgeMs,
    maxFutureSkewMs: options.maxFutureSkewMs,
  };
  const v = validateRcBenchmarkEvidence(value, bind);
  if (!v.ok) {
    return {
      ok: false,
      verifiedReady: false,
      reason: v.reason,
      ...base,
    };
  }

  const ready = isRcBenchmarkVerifiedReady(value, options);
  if (ready.ready) {
    return {
      ok: true,
      verifiedReady: true,
      reason: "RC_BENCHMARK_SATISFIED",
      evidence: ready.evidence,
      ...base,
    };
  }

  return {
    ok: true,
    verifiedReady: false,
    reason: ready.reason,
    evidence: v.evidence,
    ...base,
  };
}

/**
 * Promotion authority is never granted by RC benchmark evidence on SkillOS.
 * Structural non-authority: always false regardless of evidence content.
 */
export function isPromotionAuthorizedByRcBenchmarkEvidence(
  _evidenceOrNull?: unknown,
): false {
  void _evidenceOrNull;
  return false;
}
