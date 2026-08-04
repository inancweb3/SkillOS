/**
 * @skillos/private-runner-isolation — hosted private-runner isolation foundations.
 *
 * ADR 0006:
 * - SkillOS registry owns isolation/trust state (not runner self-claim).
 * - Absent / stale / unavailable registry → fail closed.
 * - Lower-trust runners cannot cause higher-authority actions by construction.
 * - No cloud provision, no Simpl3 import, no EXECUTE / promotion authority.
 *
 * Security rebuild (auditor F-001…F-005 + ClaudeSec P2/P3 + ChatGPT P2-01 forge fix):
 * - Private enforcement matrix + frozen inspection exports (F-001)
 * - Frozen registry record snapshots + runtime trust validation (F-002)
 * - Trusted registry clock for freshness; caller nowMs ignored (F-003)
 * - Genuine read-only AdmissionRegistryPort via module-private WeakSet (P2-01/R)
 *   Sole adder: InMemoryRunnerRegistry.asAdmissionPort() — no exported mint
 * - P2-01S: port binds non-virtual #private lookup+clock (subclass cannot elevate)
 * - Per-action isolation mode matrix → ISOLATION_VIOLATION (P2-02)
 * - maxStalenessMs ceiling at register + gate (P3-01/A1); registryEpoch (P3-02)
 * - control_plane records denied at the gate (A1 defense in depth)
 */

export {
  ISOLATION_CONTRACT_VERSION,
  MAX_STALENESS_CEILING_MS,
  TRUST_TIERS,
  TRUST_TIER_RANK,
  ACTION_CLASSES,
  ACTION_MIN_TRUST,
  ACTION_ALLOWED_MODES,
  ISOLATION_MODES,
  ADMITTABLE_ISOLATION_MODES,
  isTrustTier,
  isIsolationMode,
  isActionClass,
  freezeRunnerRecord,
  type TrustTier,
  type ActionClass,
  type IsolationMode,
  type AdmissionDenyCode,
  type RunnerIsolationRecord,
  type RunnerSelfClaim,
  type AdmissionInput,
  type AdmissionDecision,
  type AdmissionLookupResult,
  type AdmissionRegistryPort,
} from "./types.js";

export {
  InMemoryRunnerRegistry,
  IsolationRegistryError,
  trustRank,
  isGenuineAdmissionPort as isAdmissionRegistryPort,
  type RegisterRunnerInput,
  type RegistryClock,
} from "./registry.js";

export { evaluateRunnerAdmission } from "./admit.js";
