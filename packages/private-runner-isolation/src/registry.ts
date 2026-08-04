/**
 * In-process / fixture-backed runner registry — SkillOS source of truth
 * for isolation state (ADR 0006 D1). Not a cloud control plane.
 *
 * Security:
 * - F-002: stored/returned records are frozen snapshots; trustTier validated
 * - F-003: trusted clock lives on the registry; admission must not take caller time
 * - P2-01 / P2-01R: asAdmissionPort() is the **only** WeakSet adder (no exported mint)
 * - P2-01S: port closures bind only to non-virtual `#` private lookup + clock
 *   over base registry state — subclass overrides of public methods cannot
 *   redefine authoritative admission callbacks
 * - P3-01: maxStalenessMs capped by MAX_STALENESS_CEILING_MS
 */

import {
  MAX_STALENESS_CEILING_MS,
  freezeRunnerRecord,
  isIsolationMode,
  isTrustTier,
  type AdmissionLookupResult,
  type AdmissionRegistryPort,
  type IsolationMode,
  type RunnerIsolationRecord,
  type TrustTier,
} from "./types.js";
import { TRUST_TIER_RANK } from "./types.js";

export type RegistryClock = () => number;

/**
 * Module-private genuine-port set (P2-01R).
 * Only {@link InMemoryRunnerRegistry.asAdmissionPort} may add.
 * Not exported. Deep-import cannot obtain an adder.
 */
const GENUINE_ADMISSION_PORTS = new WeakSet<object>();

/**
 * Read-only predicate: object was minted by asAdmissionPort().
 * Shape alone is not authority. Safe to export — does not grant membership.
 */
export function isGenuineAdmissionPort(
  v: unknown,
): v is AdmissionRegistryPort {
  if (v === null || typeof v !== "object") return false;
  if (!GENUINE_ADMISSION_PORTS.has(v)) return false;
  const port = v as Partial<AdmissionRegistryPort>;
  return (
    typeof port.nowMs === "function" &&
    typeof port.lookupForAdmission === "function"
  );
}

export class IsolationRegistryError extends Error {
  readonly code:
    | "REGISTRY_UNAVAILABLE"
    | "INVALID_INPUT"
    | "CONTROL_PLANE_RESERVED";

  constructor(
    code: IsolationRegistryError["code"],
    message: string,
  ) {
    super(message);
    this.name = "IsolationRegistryError";
    this.code = code;
  }
}

export interface RegisterRunnerInput {
  readonly runnerId: string;
  readonly trustTier: TrustTier;
  readonly isolationMode: IsolationMode;
  readonly lastHeartbeatAtMs: number;
  readonly maxStalenessMs: number;
}

function assertSafeNonNegInt(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new IsolationRegistryError(
      "INVALID_INPUT",
      `${label} must be a non-negative safe integer`,
    );
  }
}

function assertSafeInt(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new IsolationRegistryError(
      "INVALID_INPUT",
      `${label} must be a safe integer`,
    );
  }
}

/**
 * Mutable in-memory registry stub for CI and local foundations.
 * Production control-plane backends must preserve the same fail-closed semantics.
 *
 * Admission consumers must use {@link asAdmissionPort} — never pass this
 * mutable instance into {@link evaluateRunnerAdmission}.
 */
export class InMemoryRunnerRegistry {
  /** Base registry state — true private; not visible/overridable by subclasses. */
  #records = new Map<string, RunnerIsolationRecord>();
  #epoch = 0;
  #available = true;
  /** Trusted wall clock for admission freshness (F-003). Default: Date.now. */
  #clock: RegistryClock = () => Date.now();

  constructor(options?: { clock?: RegistryClock }) {
    if (options?.clock) {
      this.#clock = options.clock;
    }
  }

  /**
   * Mint a genuine read-only admission port (P2-01 / P2-01R / P2-01S).
   * **Sole** WeakSet adder in this package — no exported mint/mark/add helper.
   * Closures bind only to non-virtual `#nowMs` / `#lookupForAdmission` over
   * this instance’s base state — not overridable public methods, and not
   * caller-supplied callbacks.
   * Exposes only nowMs + lookupForAdmission — no register/setClock/setAvailable.
   */
  asAdmissionPort(): AdmissionRegistryPort {
    const port = Object.freeze({
      nowMs: (): number => this.#nowMs(),
      lookupForAdmission: (runnerId: string): AdmissionLookupResult =>
        this.#lookupForAdmission(runnerId),
    }) as AdmissionRegistryPort;
    GENUINE_ADMISSION_PORTS.add(port);
    return port;
  }

  /**
   * Replace trusted clock (tests / controlled harness only).
   * Production hosts should inject at construction and not expose elevation.
   * Not present on {@link AdmissionRegistryPort}.
   */
  setClock(clock: RegistryClock): void {
    if (typeof clock !== "function") {
      throw new IsolationRegistryError("INVALID_INPUT", "clock must be a function");
    }
    this.#clock = clock;
  }

  /** Trusted now for admission and heartbeat bounds (public API). */
  nowMs(): number {
    return this.#nowMs();
  }

  /** Non-virtual trusted clock (P2-01S) — sole path used by admission ports. */
  #nowMs(): number {
    const n = this.#clock();
    if (typeof n !== "number" || !Number.isSafeInteger(n)) {
      throw new IsolationRegistryError(
        "INVALID_INPUT",
        "trusted clock returned non-safe-integer time",
      );
    }
    return n;
  }

  /** Test/ops hook: mark registry unavailable → all admits fail closed. */
  setAvailable(available: boolean): void {
    this.#available = available;
  }

  isAvailable(): boolean {
    return this.#available;
  }

  clear(): void {
    this.#records.clear();
  }

  register(input: RegisterRunnerInput): RunnerIsolationRecord {
    if (!this.#available) {
      throw new IsolationRegistryError(
        "REGISTRY_UNAVAILABLE",
        "registry is unavailable",
      );
    }
    if (!input.runnerId || typeof input.runnerId !== "string") {
      throw new IsolationRegistryError("INVALID_INPUT", "runnerId required");
    }
    // Runtime validation — TypeScript types are not a security boundary (F-002).
    if (!isTrustTier(input.trustTier)) {
      throw new IsolationRegistryError(
        "INVALID_INPUT",
        `invalid trustTier: ${String(input.trustTier)}`,
      );
    }
    if (!isIsolationMode(input.isolationMode)) {
      throw new IsolationRegistryError(
        "INVALID_INPUT",
        `invalid isolationMode: ${String(input.isolationMode)}`,
      );
    }
    assertSafeInt(input.lastHeartbeatAtMs, "lastHeartbeatAtMs");
    assertSafeNonNegInt(input.maxStalenessMs, "maxStalenessMs");
    // P3-01: reject absurd "never stale" ceilings.
    if (input.maxStalenessMs > MAX_STALENESS_CEILING_MS) {
      throw new IsolationRegistryError(
        "INVALID_INPUT",
        `maxStalenessMs exceeds ceiling ${MAX_STALENESS_CEILING_MS}`,
      );
    }

    // Private runners cannot hold control_plane trust (ADR 0006 D3).
    if (input.trustTier === "control_plane") {
      throw new IsolationRegistryError(
        "CONTROL_PLANE_RESERVED",
        "private runners cannot be registered at control_plane trust",
      );
    }

    // Heartbeat must not be in the future relative to trusted clock (F-003).
    const now = this.#nowMs();
    if (input.lastHeartbeatAtMs > now) {
      throw new IsolationRegistryError(
        "INVALID_INPUT",
        "lastHeartbeatAtMs must not be after trusted clock now",
      );
    }

    this.#epoch += 1;
    const record = freezeRunnerRecord({
      runnerId: input.runnerId,
      trustTier: input.trustTier,
      isolationMode: input.isolationMode,
      lastHeartbeatAtMs: input.lastHeartbeatAtMs,
      maxStalenessMs: input.maxStalenessMs,
      registryEpoch: this.#epoch,
    });
    this.#records.set(input.runnerId, record);
    // Return a defensive frozen copy — not the map-held reference (F-002).
    return freezeRunnerRecord(record);
  }

  /** Refresh heartbeat only — cannot raise trust via heartbeat. */
  heartbeat(runnerId: string, atMs?: number): RunnerIsolationRecord {
    if (!this.#available) {
      throw new IsolationRegistryError(
        "REGISTRY_UNAVAILABLE",
        "registry is unavailable",
      );
    }
    const existing = this.#records.get(runnerId);
    if (!existing) {
      throw new IsolationRegistryError(
        "INVALID_INPUT",
        `runner not registered: ${runnerId}`,
      );
    }
    const ts = atMs === undefined ? this.#nowMs() : atMs;
    assertSafeInt(ts, "atMs");
    const now = this.#nowMs();
    if (ts > now) {
      throw new IsolationRegistryError(
        "INVALID_INPUT",
        "heartbeat must not be after trusted clock now",
      );
    }
    // Monotonic heartbeat — backwards time fails closed (F-003).
    if (ts < existing.lastHeartbeatAtMs) {
      throw new IsolationRegistryError(
        "INVALID_INPUT",
        "heartbeat must not go backwards",
      );
    }
    // Re-validate stored tier (defense in depth if map were ever corrupted).
    if (!isTrustTier(existing.trustTier)) {
      throw new IsolationRegistryError(
        "INVALID_INPUT",
        "stored trustTier is invalid",
      );
    }
    if (!isIsolationMode(existing.isolationMode)) {
      throw new IsolationRegistryError(
        "INVALID_INPUT",
        "stored isolationMode is invalid",
      );
    }
    const next = freezeRunnerRecord({
      runnerId: existing.runnerId,
      trustTier: existing.trustTier,
      isolationMode: existing.isolationMode,
      lastHeartbeatAtMs: ts,
      maxStalenessMs: existing.maxStalenessMs,
      registryEpoch: existing.registryEpoch,
    });
    this.#records.set(runnerId, next);
    return freezeRunnerRecord(next);
  }

  get(runnerId: string): RunnerIsolationRecord | undefined {
    const record = this.#records.get(runnerId);
    // Fresh freeze snapshot so callers never receive a live alias (F-002).
    return record ? freezeRunnerRecord(record) : undefined;
  }

  /**
   * Snapshot for admission — public API. Subclass overrides are **not**
   * used by ports minted via {@link asAdmissionPort} (P2-01S).
   */
  lookupForAdmission(runnerId: string): AdmissionLookupResult {
    return this.#lookupForAdmission(runnerId);
  }

  /**
   * Non-virtual admission lookup (P2-01S) — sole path used by admission ports.
   * Always a frozen copy; re-validates trust/mode/heartbeat/epoch.
   */
  #lookupForAdmission(runnerId: string): AdmissionLookupResult {
    if (!this.#available) {
      return { ok: false, code: "REGISTRY_UNAVAILABLE" };
    }
    const record = this.#records.get(runnerId);
    if (!record) {
      return { ok: false, code: "RUNNER_ABSENT" };
    }
    if (!isTrustTier(record.trustTier) || !isIsolationMode(record.isolationMode)) {
      return { ok: false, code: "INVALID_INPUT" };
    }
    if (
      !Number.isSafeInteger(record.lastHeartbeatAtMs) ||
      !Number.isSafeInteger(record.maxStalenessMs) ||
      record.maxStalenessMs < 0 ||
      record.maxStalenessMs > MAX_STALENESS_CEILING_MS
    ) {
      return { ok: false, code: "INVALID_INPUT" };
    }
    if (
      !Number.isSafeInteger(record.registryEpoch) ||
      record.registryEpoch < 1
    ) {
      return { ok: false, code: "INVALID_INPUT" };
    }
    return { ok: true, record: freezeRunnerRecord(record) };
  }
}

export function trustRank(tier: TrustTier): number {
  if (!isTrustTier(tier)) {
    throw new IsolationRegistryError("INVALID_INPUT", `invalid trustTier: ${tier}`);
  }
  const rank = TRUST_TIER_RANK[tier];
  if (typeof rank !== "number" || !Number.isFinite(rank)) {
    throw new IsolationRegistryError(
      "INVALID_INPUT",
      `trust rank missing for tier: ${tier}`,
    );
  }
  return rank;
}
