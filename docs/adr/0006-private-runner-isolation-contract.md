# ADR 0006 — Private-runner isolation contract (foundations)

**Status:** Accepted — 2026-08-04
**Date:** 2026-08-04
**Deciders:** Product owner (İnanç Ayvaz); architecture (Claude standing gate); implementation (Grok Build)
**Primary repo:** `youngstar-eth/SkillOS`
**Package:** `@skillos/private-runner-isolation`
**Related:** Faz-3 task `SKILLOS-FAZ3-PRIVATE-RUNNER-ISOLATION`; `docs/adr/0005-arena-evidence-protocol-v0.1.md` (private runners deferred from protocol v0.1); phase plan Faz 3 Continuous evaluation ve Cloud

## Status

**Accepted.** This ADR freezes the **in-repo isolation contract** for hosted private-runner **foundations**. It does **not** authorize live cloud provisioning, deploy, funded rails, SkillOS control of Simpl3 execution, or promotion authority.

## Context

Faz 3 requires hosted private-runner foundations and an isolation contract so later workspace, billing, and adapter work have a single fail-closed authority boundary. Without an explicit contract:

- runners could self-claim trust and escalate capability;
- absent or stale runners could be treated as healthy by convention;
- lower-trust surfaces could accidentally gate higher-authority actions.

SkillOS remains an evaluation/evidence substrate: digests and redacted evidence only. Private runners must never receive Simpl3 EXECUTE, wallet, CDP, or promotion authority.

## Goals

1. Name the **source of truth** for isolation/trust state.
2. Define **fail-closed** behavior when a runner is absent or stale.
3. Ensure a **lower-trust runner cannot cause a higher-authority action** by construction.
4. Ship pure, offline-testable types and admission logic (fixture / in-process registry stub).
5. Leave cloud provision, networking, and host mutation out of scope.

## Non-goals

| Out of scope | Why |
|--------------|-----|
| Real host/cloud runner provisioning | Owner EXTERNAL_ACTION later if ever required |
| Funded x402 / wallet / EXECUTE paths | Hard boundary; separate ADRs for adapters |
| Simpl3 monorepo changes | SkillOS-only foundations |
| Config promotion authorization | ADR 0008 (later); SkillOS never owns promotion |
| Protocol schema changes to `@skillos/protocol` v0.1 | Separate protocol ADR if needed |

## Decision

### D1 — Source of truth for isolation state

- **SkillOS owns isolation state** via a **runner registry** in the SkillOS control surface (in foundations: an in-process / fixture-backed registry module).
- A runner **self-report** (claimed trust, claimed health) is **never** authoritative. Admission uses **only** registry-held fields loaded through a **read-only admission port**: identity, trust tier, isolation mode, heartbeat timestamp, max staleness.
- **Registry epoch** is a monotonic generation stamped on each record and **bound into the admission decision** for provenance / future cache invalidation. Foundations use live registry lookup; epoch is not a separate cache-staleness input yet, but invalid epoch values fail closed.
- Local or cached runner state **must not** unpause, upgrade trust, or admit higher action classes than the registry currently records.
- Future hosted control-plane services must preserve this invariant: registry beats runner.

### D2 — Absent and stale runners fail closed

Admission evaluation for any non-observational **action class** MUST fail closed when:

| Condition | Code (normative name) | Effect |
|-----------|----------------------|--------|
| Runner id not present in registry | `RUNNER_ABSENT` | Deny |
| Registry unavailable / invalid | `REGISTRY_UNAVAILABLE` | Deny |
| Heartbeat older than `maxStalenessMs` (or missing heartbeat when required) | `RUNNER_STALE` | Deny |
| Isolation mode not in the **per-action** allowlist for the requested action | `ISOLATION_VIOLATION` | Deny |

There is **no** “best effort” admit path. Missing, stale, or invalid inputs never yield `admit=true`.

**Per-action isolation modes (foundations):** the gate consults a private action→modes matrix (not the public inspection export). At v0.1.0:

| Action class | Allowed isolation modes |
|--------------|-------------------------|
| `observe_health` | `process`, `fixture`, `hosted_stub` |
| `verify_digest` | `process`, `fixture`, `hosted_stub` |
| `mutate_private_workspace` | `process` only |
| `request_execute` / `issue_promotion_authorization` | none (also `ACTION_CLASS_FORBIDDEN`) |

Observational read of the **decision object itself** (why denied) is allowed without side effects. That is not a higher-authority action.

### D3 — Lower trust cannot cause higher-authority action (by construction)

- Trust tiers are a **total order** (numeric rank). Action classes declare a **minimum required trust rank**.
- Admission compares **registry trust rank** to the action’s minimum. Self-attested or caller-supplied trust is ignored for the decision.
- The admit gate accepts only a **genuine read-only admission port** (`nowMs` + `lookupForAdmission`) minted by `InMemoryRunnerRegistry.asAdmissionPort()`. Runtime authority is a **module-private WeakSet** inside the registry module; **`asAdmissionPort` is the sole adder** — no exported mint/mark/add helper may place arbitrary callbacks into the set. A read-only membership predicate may be exported. Consumers **must not** pass the full mutable registry or a hand-built shape-compatible object into the gate. Register / setClock / setAvailable remain on the mutable registry only and are excluded from the port by construction.
- **P2-01S:** port closures bind only to **non-virtual ECMAScript `#` private** lookup and clock methods over the base registry state. Subclass overrides of the public `lookupForAdmission` / `nowMs` methods **must not** redefine the authoritative callbacks on a minted port (a hostile override that returns a fabricated trusted/process record for an unregistered id must yield `RUNNER_ABSENT` / fail closed, never `admit=true`).
- Action classes that represent **promotion, EXECUTE, wallet spend, or Control Plane pause override** are **not grantable** to any private-runner trust tier at v0.1.0 (`request_execute`, `issue_promotion_authorization` → always `ACTION_CLASS_FORBIDDEN`).
- **`control_plane` tier at v0.1.0:** no action class requires `control_plane`. The name is a **reserved unreachable ceiling** in the type surface (rank 4 above `trusted`). Private runners **cannot** be registered at `control_plane`, and `evaluateRunnerAdmission` **denies** any record that carries `control_plane` (`INVALID_INPUT`) so the invariant holds against *any* genuine port, not only the in-memory registry. This tier does **not** model Simpl3 Control Plane authority and is not an executable SkillOS rank.
- Therefore a lower-trust runner **cannot**, by construction, cause a higher-authority action: the admit matrix rejects the pair before any side-effect hook runs.
- SkillOS foundations never implement an EXECUTE side-effect hook; `request_execute` always denies with `ACTION_CLASS_FORBIDDEN`.

### D4 — Versioned contract surface

- Package `@skillos/private-runner-isolation` exports version constant `ISOLATION_CONTRACT_VERSION = "0.1.0"`.
- Types: trust tier, action class, isolation mode, runner record, admission decision, read-only admission port.
- Pure function `evaluateRunnerAdmission(port, input) → decision` is the sole admit gate for foundations consumers. `port` is obtained via `registry.asAdmissionPort()`.
- Consumers (workspace, adapters) must call this gate; they must not reimplement trust comparison.
- Registrant `maxStalenessMs` is capped by `MAX_STALENESS_CEILING_MS` (24h). Larger values are rejected at **register** and re-denied at the **gate** (`INVALID_INPUT`) so successor registry backends cannot bypass the ceiling by returning an over-cap record through a genuine port.

### D5 — Hosted foundations are offline-first; registry owns the trusted clock

- The registry stub is in-memory / fixture-backed for CI.
- No network calls, cloud SDK imports, or credential reads in this package.
- Dry-run only: admission is a pure function of **registry state + the registry’s trusted clock**.
- **Clock authority:** the registry owns the wall clock (injectable at registry construction / test `setClock` on the **mutable** registry only). Freshness and staleness bind exclusively to `port.nowMs()` / `registry.nowMs()`.
- `AdmissionInput.nowMs` is **non-authoritative**: accepted for deprecation telemetry only, deliberately ignored for the decision, and reported as `callerClockIgnored: true` when present. Callers must not treat injected `nowMs` as governing staleness.

### D6 — Publication posture (open SkillOS package)

- `@skillos/private-runner-isolation` is an **open, publishable SkillOS package** (same posture as `@skillos/protocol` and `@skillos/verifier-runner`): Apache-2.0, `LICENSE` + `files` packaging, **not** `"private": true`, `publishConfig.access = "public"`.
- `LICENSE` must be the **full canonical Apache-2.0 text** (Sections 1–9 + END OF TERMS AND CONDITIONS), not a short boilerplate stub. Copyright attribution is **"Copyright 2026 SkillOS contributors"** only — the closed product name (Simpl3) must not appear in package-level LICENSE attribution. Package tests assert these markers as a static pre-publish hygiene check.
- Publication posture is independent of admission authority: open packaging does not grant EXECUTE, wallet, CDP, promotion, or Simpl3 control-plane powers.

## Consequences

### Positive

- Single fail-closed admit seam for later Faz-3 SkillOS tasks.
- Architect gate (ownership / absent-stale / no lower→higher) is explicit and testable.
- Zero coupling to Simpl3 execution authority.
- Gate-level re-checks keep control_plane rejection and staleness ceiling structural against any port implementer.

### Negative / residual

- Live multi-tenant hosted runners still require a future control-plane service behind this contract; foundations alone do not run production isolation.
- CI must keep listing package tests explicitly (repo pattern); moving test files without updating `ci.yml` would drop coverage (pre-existing monorepo property).
- **R1 (CI coupling):** the package test suite asserts a line-continuation layout in `.github/workflows/ci.yml`. The guard is legitimate given monorepo explicit-path lists, but makes the suite non-portable. Prefer a repo-level CI-integrity check for successors; leave foundations suite as-is for now.
- **R2 (reason strings):** `AdmissionDecision.reason` may interpolate `runnerId` / isolation mode for operator diagnostics. **Normative on successors:** decisions must not enter public evidence, digests, or onchain surfaces without an explicit redaction projection. Reason strings are not a public evidence field.
- **R3 (day-one deprecation):** `AdmissionInput.nowMs` ships `@deprecated` in the initial v0.1.0 contract; `callerClockIgnored` exists only to report it. Removing `nowMs` later implies removing `callerClockIgnored` — a breaking change to a frozen decision surface, incurred for a telemetry-only field. Compatibility obligation is acknowledged and deferred.
- **R4 (lockfile hygiene):** monorepo `package-lock.json` may correct pre-existing main drift (e.g. verifier-runner bin entries) when the package is installed. Treat such corrections as scope-hygiene notes, not new coupling from this package.

## Compliance tests (normative)

The package test suite MUST include:

1. Happy-path admit for a fresh `standard` runner on `verify_digest`.
2. `RUNNER_ABSENT` when id missing.
3. `RUNNER_STALE` when heartbeat exceeds max staleness.
4. Lower-trust runner denied for higher action class (`TRUST_TIER_INSUFFICIENT`).
5. Private runner denied for `request_execute` and `issue_promotion_authorization` regardless of claimed trust.
6. Caller-supplied / self-attested elevated trust ignored when registry rank is lower.
7. `ISOLATION_VIOLATION` when registry mode is not allowed for the requested action (per-action matrix).
8. Gate rejects an unbranded / fully-mutable registry handle (`INVALID_INPUT`); branded port excludes `register` / `setClock` / `setAvailable`.
9. `maxStalenessMs` above `MAX_STALENESS_CEILING_MS` rejected at register; ceiling value still goes stale past it.
10. Admitted decisions bind a positive `registryEpoch`.
11. Gate re-checks deny `control_plane` records and over-ceiling `maxStalenessMs` when such a record reaches the gate (defense in depth; InMemory register + `#lookup` already refuse them).
12. **P2-01S:** subclass overriding public `lookupForAdmission` with a fabricated trusted/process record for an unregistered id — genuine port → `RUNNER_ABSENT`, never admit (including `mutate_private_workspace`).
13. **P3:** package `LICENSE` is full Apache-2.0 (Sections 1–9 + END OF TERMS) with SkillOS-only attribution.

## References

- Owner Faz-3 directive (channel): advance-phase + RUN FAZ-3 TO PHASE EXIT
- Claude ADR heads-up: private runners trip authority-boundary ADR preconditions
- Preflight: `grok-build/handoffs/2026-08-04_SKILLOS_FAZ3_PRIVATE_RUNNER_ISOLATION_PREFLIGHT.md`
- Architect CHANGES REQUIRED (A1–A3): `grok-build/handoffs/2026-08-04_SKILLOS_FAZ3_PRIVATE_RUNNER_ISOLATION_ARCHITECTURE_REVIEW_CHANGES_REQUIRED.md`
