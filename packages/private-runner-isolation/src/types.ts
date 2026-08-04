/**
 * Isolation contract types — ADR 0006.
 * Registry-held fields are authoritative; runner self-claims are not.
 *
 * Public tables are frozen inspection snapshots. The admission gate keeps a
 * separate private enforcement matrix (see admit.ts) so mutating any export
 * cannot reopen EXECUTE / promotion (security F-001).
 */

/** Contract version pin (package surface). */
export const ISOLATION_CONTRACT_VERSION = "0.1.0" as const;

/**
 * Upper bound for registrant-supplied maxStalenessMs (P3-01).
 * Values above this are rejected at register — prevents "never-stale" records.
 */
export const MAX_STALENESS_CEILING_MS = 86_400_000 as const; // 24h

/**
 * Trust tiers — total order by rank.
 *
 * `control_plane` is a **reserved unreachable ceiling** in the type surface at
 * v0.1.0: no action class requires it, private runners cannot be registered at
 * it, and the admission gate denies any record that carries it. It does **not**
 * model Simpl3 Control Plane authority and is not an executable SkillOS rank.
 */
export const TRUST_TIERS = Object.freeze([
  "ephemeral",
  "standard",
  "trusted",
  "control_plane",
] as const);

export type TrustTier = (typeof TRUST_TIERS)[number];

/** Numeric rank for comparison (higher = more trust). Frozen inspection table. */
export const TRUST_TIER_RANK: Readonly<Record<TrustTier, number>> = Object.freeze({
  ephemeral: 1,
  standard: 2,
  trusted: 3,
  control_plane: 4,
});

/**
 * Action classes gated by the isolation contract.
 * Higher-authority classes are ungrantable to private runners by construction.
 */
export const ACTION_CLASSES = Object.freeze([
  "observe_health",
  "verify_digest",
  "mutate_private_workspace",
  "issue_promotion_authorization",
  "request_execute",
] as const);

export type ActionClass = (typeof ACTION_CLASSES)[number];

/**
 * Inspection-only min-trust table (frozen). Admission does **not** read this
 * object — it uses a private enforcement matrix inside admit.ts (F-001).
 * Mutating this export must not change gate outcomes.
 */
export const ACTION_MIN_TRUST: Readonly<
  Record<ActionClass, TrustTier | null>
> = Object.freeze({
  observe_health: "ephemeral",
  verify_digest: "standard",
  mutate_private_workspace: "trusted",
  // Private runners cannot authorize promotion (Control Plane only; ADR 0008 later).
  issue_promotion_authorization: null,
  // EXECUTE remains hard-off for SkillOS private runners (always forbidden).
  request_execute: null,
});

/** Isolation mode recorded in the registry (not self-claimed at admit time). */
export const ISOLATION_MODES = Object.freeze([
  "process",
  "fixture",
  "hosted_stub",
] as const);

export type IsolationMode = (typeof ISOLATION_MODES)[number];

/**
 * Modes that may appear in the registry (global allowlist for registration).
 * Frozen array — not a live Set (Set.add still works under Object.freeze).
 * Per-action admission uses a private matrix in admit.ts (P2-02 / ADR D2).
 */
export const ADMITTABLE_ISOLATION_MODES: ReadonlyArray<IsolationMode> =
  Object.freeze(["process", "fixture", "hosted_stub"] as IsolationMode[]);

/**
 * Inspection-only per-action isolation mode allowlist (frozen).
 * Gate enforcement uses a private copy in admit.ts — mutating this export
 * must not change gate outcomes (same pattern as ACTION_MIN_TRUST / F-001).
 *
 * Foundations policy:
 * - observe / verify: all registered modes
 * - mutate_private_workspace: process isolation only
 * - EXECUTE / promotion: empty (also ACTION_CLASS_FORBIDDEN)
 */
export const ACTION_ALLOWED_MODES: Readonly<
  Record<ActionClass, ReadonlyArray<IsolationMode>>
> = Object.freeze({
  observe_health: Object.freeze([
    "process",
    "fixture",
    "hosted_stub",
  ] as IsolationMode[]),
  verify_digest: Object.freeze([
    "process",
    "fixture",
    "hosted_stub",
  ] as IsolationMode[]),
  mutate_private_workspace: Object.freeze(["process"] as IsolationMode[]),
  issue_promotion_authorization: Object.freeze([] as IsolationMode[]),
  request_execute: Object.freeze([] as IsolationMode[]),
});

export type AdmissionDenyCode =
  | "RUNNER_ABSENT"
  | "RUNNER_STALE"
  | "REGISTRY_UNAVAILABLE"
  | "TRUST_TIER_INSUFFICIENT"
  | "ACTION_CLASS_FORBIDDEN"
  | "ISOLATION_VIOLATION"
  | "INVALID_INPUT"
  | "CLOCK_UNTRUSTED";

/**
 * Registry record — sole source of truth for isolation/trust (ADR 0006 D1).
 * Instances returned from the registry are frozen snapshots (F-002).
 * `registryEpoch` is a monotonic generation recorded on the decision for
 * binding / future cache invalidation (P3-02).
 */
export interface RunnerIsolationRecord {
  readonly runnerId: string;
  readonly trustTier: TrustTier;
  readonly isolationMode: IsolationMode;
  /** Unix epoch ms of last successful registry heartbeat. */
  readonly lastHeartbeatAtMs: number;
  /** Max age of heartbeat before RUNNER_STALE. */
  readonly maxStalenessMs: number;
  /** Monotonic registry generation for the record. */
  readonly registryEpoch: number;
}

/** Optional non-authoritative claims a runner or caller may present (ignored for admit). */
export interface RunnerSelfClaim {
  readonly claimedTrustTier?: TrustTier;
  readonly claimedHealthy?: boolean;
}

export interface AdmissionInput {
  readonly runnerId: string;
  readonly actionClass: ActionClass;
  /**
   * Non-authoritative self-claim. Present so tests can prove elevation via
   * claim is ignored (ADR 0006 D3).
   */
  readonly selfClaim?: RunnerSelfClaim;
  /**
   * @deprecated Admission uses the registry's trusted clock only (F-003 / D5).
   * If provided, it is ignored for the decision (recorded as callerClockIgnored).
   */
  readonly nowMs?: number;
}

export interface AdmissionDecision {
  readonly contractVersion: typeof ISOLATION_CONTRACT_VERSION;
  readonly admit: boolean;
  readonly runnerId: string;
  readonly actionClass: ActionClass;
  readonly registryTrustTier: TrustTier | null;
  /**
   * Registry generation bound into the decision (P3-02). Null when no record
   * was loaded (absent / invalid / pre-lookup deny).
   */
  readonly registryEpoch: number | null;
  readonly denyCode: AdmissionDenyCode | null;
  readonly reason: string;
  /** True when a self-claim was present and deliberately ignored. */
  readonly selfClaimIgnored: boolean;
  /** True when a caller-supplied nowMs was present and deliberately ignored. */
  readonly callerClockIgnored: boolean;
}

/**
 * Result of a read-only registry lookup for admission (P2-01).
 * Mutating registry methods are not part of this surface.
 */
export type AdmissionLookupResult =
  | { readonly ok: true; readonly record: RunnerIsolationRecord }
  | {
      readonly ok: false;
      readonly code: "REGISTRY_UNAVAILABLE" | "RUNNER_ABSENT" | "INVALID_INPUT";
    };

/**
 * Read-only registry port for admission (ADR 0006 D3 / P2-01).
 * Consumers must pass a port from `registry.asAdmissionPort()` — not the full
 * mutable registry, and not a hand-built object that merely matches this shape.
 *
 * Runtime authority is a **module-private WeakSet** inside registry.ts,
 * populated **only** by `InMemoryRunnerRegistry.asAdmissionPort()` (no exported
 * mint/mark/add). Port methods bind non-virtual `#` private lookup/clock over
 * base registry state (P2-01S) — subclass overrides of public methods are not
 * authoritative. Exported symbols / `Symbol.for` / shape alone are **not**
 * authority and must not be treated as such by consumers.
 */
export interface AdmissionRegistryPort {
  /** Trusted wall clock owned by the registry (D5 / F-003). */
  nowMs(): number;
  /** Frozen snapshot lookup; re-validates trust/mode/heartbeat fields. */
  lookupForAdmission(runnerId: string): AdmissionLookupResult;
}

export function isTrustTier(v: unknown): v is TrustTier {
  return (
    typeof v === "string" &&
    (TRUST_TIERS as readonly string[]).includes(v)
  );
}

export function isIsolationMode(v: unknown): v is IsolationMode {
  return (
    typeof v === "string" &&
    (ISOLATION_MODES as readonly string[]).includes(v)
  );
}

export function isActionClass(v: unknown): v is ActionClass {
  return (
    typeof v === "string" &&
    (ACTION_CLASSES as readonly string[]).includes(v)
  );
}

/** Deep-freeze a registry record snapshot (F-002). */
export function freezeRunnerRecord(
  record: RunnerIsolationRecord,
): RunnerIsolationRecord {
  return Object.freeze({
    runnerId: record.runnerId,
    trustTier: record.trustTier,
    isolationMode: record.isolationMode,
    lastHeartbeatAtMs: record.lastHeartbeatAtMs,
    maxStalenessMs: record.maxStalenessMs,
    registryEpoch: record.registryEpoch,
  });
}
