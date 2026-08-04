/**
 * Fail-closed runner admission (ADR 0006 D2 / D3).
 *
 * Security:
 * - F-001: private enforcement matrix + exhaustive forbidden switch; public
 *   ACTION_MIN_TRUST is inspection-only and never consulted by the gate
 * - F-002: re-validates registry trust tier; absent ranks fail closed
 * - F-003: freshness uses registry trusted clock only (caller nowMs ignored)
 * - P2-01: gate accepts WeakSet-minted AdmissionRegistryPort only (not forgeable symbols)
 * - P2-02: private per-action isolation mode matrix → ISOLATION_VIOLATION
 * - P3-01: maxStalenessMs re-capped by MAX_STALENESS_CEILING_MS at decision time
 * - P3-02: registryEpoch bound into decisions; invalid epoch fails closed
 * - A1: control_plane records and over-ceiling maxStaleness denied at the gate
 *   (structural against any genuine port, not only InMemoryRunnerRegistry)
 */

import { isGenuineAdmissionPort } from "./registry.js";
import {
  ISOLATION_CONTRACT_VERSION,
  MAX_STALENESS_CEILING_MS,
  TRUST_TIER_RANK,
  isActionClass,
  isIsolationMode,
  isTrustTier,
  type ActionClass,
  type AdmissionDecision,
  type AdmissionInput,
  type AdmissionRegistryPort,
  type IsolationMode,
  type TrustTier,
} from "./types.js";

/**
 * Private enforcement matrix — not exported. The gate reads only this object.
 * Deep-frozen at module init so in-process mutation cannot reopen EXECUTE.
 */
const ENFORCEMENT_MIN_TRUST: Readonly<
  Record<ActionClass, TrustTier | null>
> = Object.freeze({
  observe_health: "ephemeral",
  verify_digest: "standard",
  mutate_private_workspace: "trusted",
  issue_promotion_authorization: null,
  request_execute: null,
});

/**
 * Private per-action isolation mode allowlist (P2-02 / ADR D2).
 * Not exported — public ACTION_ALLOWED_MODES is inspection-only.
 */
const ENFORCEMENT_ALLOWED_MODES: Readonly<
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

/** Always-forbidden action classes — by construction, no trust elevates them. */
function isAlwaysForbidden(action: ActionClass): boolean {
  switch (action) {
    case "request_execute":
    case "issue_promotion_authorization":
      return true;
    case "observe_health":
    case "verify_digest":
    case "mutate_private_workspace":
      return false;
    default: {
      // Exhaustiveness + fail closed for any future unhandled class.
      const _never: never = action;
      void _never;
      return true;
    }
  }
}

function modeAllowedForAction(
  action: ActionClass,
  mode: IsolationMode,
): boolean {
  const allowed = ENFORCEMENT_ALLOWED_MODES[action];
  if (!allowed) return false;
  return (allowed as readonly string[]).includes(mode);
}

function deny(
  input: AdmissionInput,
  denyCode: AdmissionDecision["denyCode"],
  reason: string,
  registryTrustTier: TrustTier | null,
  selfClaimIgnored: boolean,
  callerClockIgnored: boolean,
  registryEpoch: number | null = null,
): AdmissionDecision {
  return Object.freeze({
    contractVersion: ISOLATION_CONTRACT_VERSION,
    admit: false,
    runnerId: input.runnerId,
    actionClass: input.actionClass,
    registryTrustTier,
    registryEpoch,
    denyCode,
    reason,
    selfClaimIgnored,
    callerClockIgnored,
  });
}

function admitOk(
  input: AdmissionInput,
  registryTrustTier: TrustTier,
  selfClaimIgnored: boolean,
  callerClockIgnored: boolean,
  registryEpoch: number,
): AdmissionDecision {
  return Object.freeze({
    contractVersion: ISOLATION_CONTRACT_VERSION,
    admit: true,
    runnerId: input.runnerId,
    actionClass: input.actionClass,
    registryTrustTier,
    registryEpoch,
    denyCode: null,
    reason: "admitted",
    selfClaimIgnored,
    callerClockIgnored,
  });
}

/**
 * Evaluate whether a private runner may perform an action class.
 * Never enables EXECUTE or promotion authorization for private runners.
 * Freshness is bound to the registry trusted clock (not caller nowMs).
 *
 * @param registry — genuine read-only {@link AdmissionRegistryPort} only.
 *   Pass `registry.asAdmissionPort()` from {@link InMemoryRunnerRegistry}.
 *   Full mutable registry and forged shape-compatible objects are rejected (P2-01).
 */
export function evaluateRunnerAdmission(
  registry: AdmissionRegistryPort,
  input: AdmissionInput,
): AdmissionDecision {
  const selfClaimIgnored = Boolean(
    input.selfClaim &&
      (input.selfClaim.claimedTrustTier !== undefined ||
        input.selfClaim.claimedHealthy !== undefined),
  );
  // Caller-supplied clock is never authoritative (F-003).
  const callerClockIgnored = input.nowMs !== undefined;

  // P2-01: authority is module-private WeakSet membership, not exported symbols.
  if (!isGenuineAdmissionPort(registry)) {
    return deny(
      input,
      "INVALID_INPUT",
      "admission requires genuine read-only AdmissionRegistryPort (use asAdmissionPort())",
      null,
      selfClaimIgnored,
      callerClockIgnored,
    );
  }

  if (!input.runnerId || typeof input.runnerId !== "string") {
    return deny(
      input,
      "INVALID_INPUT",
      "runnerId required",
      null,
      selfClaimIgnored,
      callerClockIgnored,
    );
  }
  if (!isActionClass(input.actionClass)) {
    return deny(
      input,
      "INVALID_INPUT",
      "unknown actionClass",
      null,
      selfClaimIgnored,
      callerClockIgnored,
    );
  }

  // Hard deny before matrix lookup — ungrantable by construction (F-001).
  if (isAlwaysForbidden(input.actionClass)) {
    return deny(
      input,
      "ACTION_CLASS_FORBIDDEN",
      `action class ${input.actionClass} is not grantable to private runners`,
      null,
      selfClaimIgnored,
      callerClockIgnored,
    );
  }

  // Private matrix only — never ACTION_MIN_TRUST export (F-001).
  const minTrust = ENFORCEMENT_MIN_TRUST[input.actionClass];
  if (minTrust === null) {
    return deny(
      input,
      "ACTION_CLASS_FORBIDDEN",
      `action class ${input.actionClass} is not grantable to private runners`,
      null,
      selfClaimIgnored,
      callerClockIgnored,
    );
  }
  if (!isTrustTier(minTrust)) {
    return deny(
      input,
      "INVALID_INPUT",
      "action min-trust table corrupted",
      null,
      selfClaimIgnored,
      callerClockIgnored,
    );
  }

  let nowMs: number;
  try {
    nowMs = registry.nowMs();
  } catch {
    return deny(
      input,
      "CLOCK_UNTRUSTED",
      "registry trusted clock unavailable",
      null,
      selfClaimIgnored,
      callerClockIgnored,
    );
  }
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(nowMs)) {
    return deny(
      input,
      "CLOCK_UNTRUSTED",
      "registry trusted clock returned non-safe integer time",
      null,
      selfClaimIgnored,
      callerClockIgnored,
    );
  }

  const lookup = registry.lookupForAdmission(input.runnerId);
  if (!lookup.ok) {
    if (lookup.code === "REGISTRY_UNAVAILABLE") {
      return deny(
        input,
        "REGISTRY_UNAVAILABLE",
        "isolation registry unavailable",
        null,
        selfClaimIgnored,
        callerClockIgnored,
      );
    }
    if (lookup.code === "INVALID_INPUT") {
      return deny(
        input,
        "INVALID_INPUT",
        "registry record invalid (trust/mode)",
        null,
        selfClaimIgnored,
        callerClockIgnored,
      );
    }
    return deny(
      input,
      "RUNNER_ABSENT",
      `runner not registered: ${input.runnerId}`,
      null,
      selfClaimIgnored,
      callerClockIgnored,
    );
  }

  const record = lookup.record;
  const epoch = record.registryEpoch;

  // P3-02: epoch must be a positive safe integer when a record is present.
  if (
    typeof epoch !== "number" ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1
  ) {
    return deny(
      input,
      "INVALID_INPUT",
      "registryEpoch invalid at decision time",
      isTrustTier(record.trustTier) ? record.trustTier : null,
      selfClaimIgnored,
      callerClockIgnored,
      null,
    );
  }

  // Re-validate trust at decision time (F-002).
  if (!isTrustTier(record.trustTier)) {
    return deny(
      input,
      "INVALID_INPUT",
      "registry trustTier invalid at decision time",
      null,
      selfClaimIgnored,
      callerClockIgnored,
      epoch,
    );
  }

  // A1 / ADR D3: control_plane is a reserved unreachable ceiling — never
  // grantable to private runners. Enforced at the gate against *any* port so
  // successor backends cannot mint control_plane records past InMemory register.
  if (record.trustTier === "control_plane") {
    return deny(
      input,
      "INVALID_INPUT",
      "control_plane trust is not grantable to private runners",
      record.trustTier,
      selfClaimIgnored,
      callerClockIgnored,
      epoch,
    );
  }

  // Staleness against trusted clock only (F-003). Future heartbeat → stale.
  // A1 / P3-01: re-apply MAX_STALENESS_CEILING_MS at the gate (not only register).
  if (
    !Number.isSafeInteger(record.lastHeartbeatAtMs) ||
    !Number.isSafeInteger(record.maxStalenessMs) ||
    record.maxStalenessMs < 0 ||
    record.maxStalenessMs > MAX_STALENESS_CEILING_MS
  ) {
    return deny(
      input,
      "INVALID_INPUT",
      "registry heartbeat fields invalid",
      record.trustTier,
      selfClaimIgnored,
      callerClockIgnored,
      epoch,
    );
  }

  const age = nowMs - record.lastHeartbeatAtMs;
  if (age < 0) {
    return deny(
      input,
      "RUNNER_STALE",
      `heartbeat is after trusted clock (age ${age}ms)`,
      record.trustTier,
      selfClaimIgnored,
      callerClockIgnored,
      epoch,
    );
  }
  if (age > record.maxStalenessMs) {
    return deny(
      input,
      "RUNNER_STALE",
      `heartbeat age ${age}ms exceeds maxStalenessMs ${record.maxStalenessMs}`,
      record.trustTier,
      selfClaimIgnored,
      callerClockIgnored,
      epoch,
    );
  }

  // P2-02 / D2: per-action isolation mode allowlist (before trust compare).
  if (!isIsolationMode(record.isolationMode)) {
    return deny(
      input,
      "ISOLATION_VIOLATION",
      `isolation mode ${String(record.isolationMode)} not admitted`,
      record.trustTier,
      selfClaimIgnored,
      callerClockIgnored,
      epoch,
    );
  }
  if (!modeAllowedForAction(input.actionClass, record.isolationMode)) {
    return deny(
      input,
      "ISOLATION_VIOLATION",
      `isolation mode ${record.isolationMode} not allowed for action ${input.actionClass}`,
      record.trustTier,
      selfClaimIgnored,
      callerClockIgnored,
      epoch,
    );
  }

  // Trust compare — both ranks must be present finite numbers (F-002 fail closed).
  const have = TRUST_TIER_RANK[record.trustTier];
  const need = TRUST_TIER_RANK[minTrust];
  if (
    typeof have !== "number" ||
    typeof need !== "number" ||
    !Number.isFinite(have) ||
    !Number.isFinite(need)
  ) {
    return deny(
      input,
      "INVALID_INPUT",
      "trust rank missing for registry or required tier",
      record.trustTier,
      selfClaimIgnored,
      callerClockIgnored,
      epoch,
    );
  }
  if (have < need) {
    return deny(
      input,
      "TRUST_TIER_INSUFFICIENT",
      `registry trust ${record.trustTier} (rank ${have}) < required ${minTrust} (rank ${need})`,
      record.trustTier,
      selfClaimIgnored,
      callerClockIgnored,
      epoch,
    );
  }

  return admitOk(
    input,
    record.trustTier,
    selfClaimIgnored,
    callerClockIgnored,
    epoch,
  );
}
