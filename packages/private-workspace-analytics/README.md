# `@skillos/private-workspace-analytics`

SkillOS **private workspace + analytics privacy foundations** (Faz 3 / ADR 0007).

## What this is

- Versioned privacy contract: field classifications, export policy, SkillOS-ingress export, analytics summaries.
- **Fail-closed** export for missing policy, unclassified fields, private fields, secret-shaped values, and raw private export attempts.
- **Private always-deny key matrix** — mutating the public inspection list cannot reopen private keys.
- Analytics retain **digests + numeric aggregates only** (including digests of `public`-classified fields — never raw public projection on the analytics surface) and never grant EXECUTE, promotion, wallet, funded-spend, or control-plane authority.
- Analytics summaries carry provenance (`digestedFields` / `publicDigestedFields`) so classification can be reconstructed.
- **Open publishable SkillOS package** (Apache-2.0; same posture as `@skillos/protocol`).

## What this is not

- No live multi-tenant workspace storage or cloud dashboard.
- No Simpl3 execution, wallet, CDP, or funded x402 authority.
- No config promotion authorization (Control Plane / later ADR 0008).
- Export/analytics gates accept **no** authority parameter; labels such as `request_execute`, `issue_promotion_authorization`, `wallet_spend`, `x402_funded_spend`, and `control_plane_unpause` are never grantable (helper `denyAuthorityAction` for out-of-band checks).

## SkillOS ingress seam

```ts
import {
  exportForSkillOSIngress,
  buildAnalyticsSummary,
  PRIVACY_CONTRACT_VERSION,
} from "@skillos/private-workspace-analytics";

const policy = {
  contractVersion: PRIVACY_CONTRACT_VERSION,
  fields: {
    suiteId: "public",
    scenarioBody: "digest",
    runCount: "aggregate",
    // portfolio / privateKey etc. are always private even if listed
  },
};

const workspace = {
  workspaceId: "ws-local-1",
  fields: {
    suiteId: "offline-eval-v1",
    scenarioBody: { steps: 3 },
    runCount: 12,
  },
};

const decision = exportForSkillOSIngress(workspace, policy);
// decision.admit === true
// decision.export.projected.suiteId === "offline-eval-v1"
// decision.export.projected.scenarioBody === "<sha256 hex>"
// runCount omitted from ingress (aggregate-only)

const analytics = buildAnalyticsSummary(workspace, policy);
// analytics.summary.aggregates.runCount === 12
// analytics.summary.digests.suiteId === "<sha256 of public field>"
// analytics.summary.publicDigestedFields includes "suiteId"
// analytics.summary.grantsExecutionAuthority === false
// analytics.summary.grantsControlPlaneAuthority === false
```

## Invariants (ADR 0007)

1. **Allowlist + classification** — unclassified fields fail closed.
2. **Private never leaves** — policy `private`, always-deny keys, and **normalized sensitive names** (`isSensitiveKey`, including mixed-case / hyphen / underscore variants) cannot enter SkillOS — even under hostile public/digest policy (F-001).
3. **Secret-shaped public values fail closed** — no scrub-and-admit path.
4. **Detached immutable projections** — public values are deep-snapshotted and deep-frozen; post-admit mutation of caller objects cannot change the export (F-002).
5. **Own-property / null-proto policy maps** — `constructor` / `toString` / `__proto__` never inherit from `Object.prototype` for classification (F-003).
6. **Strict finite I-JSON digests** — cycles, accessors, exotics, non-finite numbers fail closed with structured `INVALID_INPUT` (no shared coerce encoding) (F-004).
7. **Analytics are not authority** — digests/aggregates only; hard-false flags cover execution, promotion, wallet, funded-spend, and control-plane; gates take no authority parameter.
8. **Raw private export is forbidden** by construction (`attemptRawPrivateExport` always denies).

## Tests

```bash
npm test --workspace=@skillos/private-workspace-analytics
npm run typecheck --workspace=@skillos/private-workspace-analytics
```
