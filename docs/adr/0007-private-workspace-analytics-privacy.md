# ADR 0007 — Private workspace + analytics privacy placement

**Status:** Accepted — 2026-08-04
**Date:** 2026-08-04
**Deciders:** Product owner (İnanç Ayvaz); architecture (Claude standing gate); implementation (Grok Build)
**Primary repo:** `youngstar-eth/SkillOS`
**Package:** `@skillos/private-workspace-analytics`
**Related:** Faz-3 task `SKILLOS-FAZ3-PRIVATE-WORKSPACE-ANALYTICS`; `docs/adr/0006-private-runner-isolation-contract.md` (isolation admit gate); phase plan Faz 3 Continuous evaluation ve Cloud

## Status

**Accepted.** This ADR freezes the **privacy placement** for private workspace and analytics foundations that may feed SkillOS. It does **not** authorize live multi-tenant storage, cloud dashboards, funded rails, EXECUTE, promotion, or Simpl3 execution authority.

## Context

Faz 3 task #2 requires private workspace + analytics surfaces with an explicit redaction boundary for SkillOS ingress. Without a placement decision:

- raw private fields could be exported “for convenience”;
- unclassified or secret-shaped material could succeed an export path;
- analytics aggregates could be mistaken for execution, promotion, or spend authority.

SkillOS remains an evaluation/evidence substrate: digests and redacted evidence only. Private workspaces may hold richer local material, but **only** allowlisted, classified, and projected values may leave toward SkillOS.

## Goals

1. Name **what may enter SkillOS** from a private workspace (allow/deny + classification).
2. Define **fail-closed export**: missing policy, unclassified field, private classification, or secret-shaped value → no successful SkillOS-bound export.
3. Ensure **analytics cannot become authority** (EXECUTE, promotion, wallet/spend).
4. Ship pure, offline-testable types and export logic with leak-class tests.
5. Leave multi-tenant storage, UI, and network out of scope.

## Non-goals

| Out of scope | Why |
|--------------|-----|
| Live hosted workspace storage / multi-tenant DB | Later control-plane / product work |
| Real cloud dashboards or billing | Separate tasks (x402, trust dashboard) |
| Simpl3 monorepo changes | SkillOS-only foundations |
| Config promotion authorization | ADR 0008 later; SkillOS never owns promotion |
| Re-litigating ADR 0006 admit matrix | Import isolation only if composition is needed; not required for pure export foundations |
| Protocol schema changes to `@skillos/protocol` v0.1 | Separate protocol ADR if needed |

## Decision

### D1 — Explicit allowlist + field classification (privacy placement)

- Material that may leave a private workspace toward SkillOS is defined by an **export policy**: a versioned map of field name → classification.
- Classifications (v0.1.0):

| Class | Effect on SkillOS-bound export |
|-------|--------------------------------|
| `public` | May export as a validated non-secret scalar/object projection |
| `digest` | Must be replaced by a SHA-256 hex digest of a canonical encoding |
| `aggregate` | May appear only as a finite number in analytics summaries |
| `private` | Must never appear in any SkillOS-bound export |

- **Unclassified fields fail closed** (`UNCLASSIFIED_FIELD`). There is no default “pass through.”
- Missing or invalid policy fails closed (`MISSING_POLICY` / `INVALID_INPUT`).
- A **private enforcement denylist** of always-private key names (e.g. portfolio, privateKey, mnemonic, wallet secret shapes) is enforced **inside** the export gate and is **not** overridable by a public policy map mutation (same inspection-vs-enforcement split pattern as ADR 0006 F-001).

### D2 — Fail-closed export (SkillOS ingress)

- Sole export gate for foundations: pure function
  `exportForSkillOSIngress(workspace, policy) → ExportDecision`.
- `admit=true` only when every field is classified, no `private` field is present in the source for export, no always-private key appears, and no secret-shaped string remains after projection.
- Leak-class inputs (raw private payload attempt, secret-like strings, portfolio/raw traces when modeled as private fields) **must not** yield `admit=true`.
- Denied decisions return a structured `denyCode` + operator `reason`. Reasons may interpolate field names for diagnostics; **normative on successors:** decisions and reasons must not enter public evidence, digests, or onchain surfaces without an explicit redaction projection.

### D3 — Analytics are digests + aggregates only; never authority

- Analytics surfaces (`buildAnalyticsSummary`) may retain:
  - contract version,
  - workspace identity **digest** (never a requirement to retain raw workspace ids in SkillOS),
  - finite numeric aggregates from fields classified `aggregate`,
  - digests of fields classified `digest`,
  - digests of fields classified `public` (one-way only — **never** raw-projected on the analytics surface; secret-scanned before digest).
- Provenance on the summary must allow reconstructing the classification decision for each digest entry (e.g. `digestedFields` for `digest` class, `publicDigestedFields` for `public` class), mirroring the export body's `digestedFields` / `publicFields` split.
- Analytics **must not**:
  - grant EXECUTE, promotion, wallet, funded-spend (x402), CDP, or control-plane unpause / trust-upgrade authority;
  - re-export raw private fields;
  - act as a control-plane unpause or trust upgrade signal.
- Authority completeness is asserted at the type layer: every label in the forbidden-authority deny set has a corresponding hard-false flag on `AnalyticsSummary` (`grantsExecutionAuthority`, `grantsPromotionAuthority`, `grantsWalletAuthority`, `grantsFundedSpendAuthority`, `grantsControlPlaneAuthority`).
- **No authority parameter** exists on `exportForSkillOSIngress` or `buildAnalyticsSummary` — stronger than deny-by-parameter. Optional helper `denyAuthorityAction` may reject action labels for inspection/tests when a label is presented outside those gates; gates themselves cannot admit authority because no action label can be supplied.

### D4 — Secret-shaped defense-in-depth

- Even for `public` fields, values that match secret-shaped patterns (Bearer/Basic tokens, PEM private keys, JWT-shaped strings, 64-hex key material, oversize untrusted strings) fail closed (`SECRET_SHAPED_VALUE`).
- Redaction of private material for local display is a separate concern; **SkillOS ingress never relies on best-effort string scrubbing alone** — classification + denylist + secret scan all apply.

### D5 — Versioned contract; offline-first foundations

- Package `@skillos/private-workspace-analytics` exports
  `PRIVACY_CONTRACT_VERSION = "0.1.0"`.
- No network calls, cloud SDK imports, credential reads, or Simpl3 execution imports in this package.
- Open publishable SkillOS package posture (Apache-2.0 full LICENSE, SkillOS attribution, not `"private": true`) matching `@skillos/protocol` / `@skillos/private-runner-isolation`.

### D6 — Relationship to ADR 0006

- Isolation admission (who may `mutate_private_workspace`) remains ADR 0006.
- This ADR owns **what may leave** the workspace toward SkillOS after/at export time.
- Foundations do **not** require a live runner registry backend; optional future composition with `evaluateRunnerAdmission` is allowed but not mandated for v0.1.0 export purity.

## Consequences

### Positive

- Single fail-closed SkillOS-ingress seam for workspace/analytics.
- Explicit privacy placement (allowlist + classes + private denylist).
- Analytics cannot be confused with execution/promotion authority by construction.
- Leak-class tests pin the contract in CI.

### Negative / residual

- Live multi-tenant storage and dashboards still require later services behind this contract.
- CI must list package tests explicitly (monorepo property; same as ADR 0006 R1).
- Operator `reason` strings remain diagnostic-only (same residual class as ADR 0006 R2).
- Deterministic digests use a foundations-local canonical encoding; if a future protocol digest must bind, a separate ADR/binding task should pin cross-package digest equality.

## Compliance tests (normative)

The package test suite MUST include:

1. Happy-path SkillOS export of allowlisted `public` + `digest` fields only.
2. Happy-path analytics summary with numeric aggregates and digests only.
3. Fail-closed when policy is missing/invalid.
4. Fail-closed on unclassified field.
5. Fail-closed on `private` field present in workspace export attempt.
6. Fail-closed on always-private denylist keys even if public policy map is hostile-mutated.
7. Fail-closed on secret-shaped values in otherwise `public` fields.
8. Fail-closed on direct raw private export attempt (no bypass path).
9. `EXPORT_AUTHORITY_FORBIDDEN` for execute/promotion/wallet action labels.
10. Package LICENSE full Apache-2.0 + SkillOS-only attribution.
11. CI path list includes this package’s test file.

## References

- Owner Faz-3 directive: RUN FAZ-3 TO PHASE EXIT
- Preflight: `grok-build/handoffs/2026-08-04_SKILLOS_FAZ3_PRIVATE_WORKSPACE_ANALYTICS_PREFLIGHT.md`
- Phase plan: `handoffs/2026-08-04_PHASE_3_PLAN.md` task #2
- ADR 0006 private-runner isolation contract
