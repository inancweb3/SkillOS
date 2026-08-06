# ADR 0009 — Rail-neutral testnet billing adapter

**Status:** Accepted — 2026-08-05  
**Date:** 2026-08-05  
**Deciders:** Product owner (İnanç Ayvaz); architecture (Claude standing gate); implementation (Grok Build)  
**Primary repo:** `youngstar-eth/SkillOS`  
**Package:** `@skillos/x402-testnet-billing`  
**Related:** Faz-3 task `SKILLOS-FAZ3-X402-TESTNET-BILLING` · plan #8 · `docs/adr/0003-agent-x402-retry-payments.md` (historical funded middleware path) · ADR 0006/0007 SkillOS authority boundaries

## Status

**Accepted.** This ADR freezes the **rail-neutral billing adapter** surface for SkillOS **testnet / dry-run billing only**. It does **not** authorize live facilitator settle, mainnet spend, wallet/CDP funding, Simpl3 EXECUTE, or promotion authority.

## Context

Faz 3 requires a versioned x402 **testnet-billing adapter** so later work can quote and dry-run billing without coupling SkillOS verify/promotion/runner logic to a single facilitator, chain, or funded middleware.

ADR 0003 already documents the historical **live** path: extend `apps/api/src/lib/x402.ts` `paymentMiddleware` for agent retry payments on Base Sepolia. That path is product history and a **sharp edge**: a config-only flip must never make funded spend reachable from SkillOS evaluation surfaces.

Without a separate adapter boundary:

- billing success could be mistaken for promote / EXECUTE / decision authority;
- mainnet or funded modes could be “enabled” by env alone;
- SkillOS core packages could import facilitator clients and secrets.

## Goals

1. Name the **owner** of the billing adapter surface (`@skillos/x402-testnet-billing`).
2. Define a **rail-neutral** quote / authorize / settle / dry-run interface.
3. Make **funded / mainnet / live settle unreachable by construction** in this package (type + gate), not merely unconfigured.
4. Ensure billing outcomes **never** grant promotion, EXECUTE, pause, or policy authority.
5. Ship pure offline tests (no network, facilitator, or real USDC).

## Non-goals

| Out of scope | Why |
|--------------|-----|
| Live facilitator settle / mainnet USDC | Funded path forbidden in this package |
| Expanding `apps/api` `paymentMiddleware` route map | ADR-0003 sharp edge; separate product task if ever needed |
| Simpl3 wallet/CDP/x402 spend | SkillOS digests-only boundary |
| Promotion or decision-path injection | Control Plane / monorepo only (ADR 0008) |
| CI-ORD-1, AgentKit, ERC-8004, trust dashboard | Other plan items |

## Decision

### D1 — Single owner package

- **Owner module package:** `@skillos/x402-testnet-billing` under `packages/x402-testnet-billing/`.
- SkillOS verify, isolation, analytics, protocol, and monorepo promotion modules **must not** embed facilitator or funded settle logic.
- Billing is an **adapter**: consumers may call quote / authorize / settle through this package only for **testnet simulation / dry-run**.

### D2 — Rail-neutral interface

Public operations (pure, offline-safe):

| Op | Meaning |
|----|---------|
| `quoteBilling` | Produce a price quote from a request + config (no network); mints into package WeakSet |
| `authorizeBilling` | Accept **only** mint-registry quotes; produce auth mint for settle |
| `settleBilling` | Accept **only** mint-registry authorizations; record simulated receipt mint |
| `settleLiveFundedBilling` | Structural non-grant for any live/funded attempt (always deny) |
| `isBillingQuote` / `isBillingAuthorization` / `isBillingReceipt` | Identity guards — shape-only forgeries fail closed |

Chain integrity (X-1): quote → authorize → settle is bound by object identity. Hand-built quote/auth bags cannot produce a registry-backed receipt.

Interface types do **not** name a required facilitator URL, CDP key, or chain-specific client. A future live rail would be a **different package or explicit later ADR**, not a mode flip here.

### D3 — Allowed modes only (funded unreachable by construction)

- Allowed modes: **`dry_run`**, **`fixture`** only (frozen union).
- There is **no** first-class `mainnet`, `funded`, `live`, or `production` mode that can succeed settle.
- Config objects that set production/mainnet/funded flags are **invalid** → no settle attempt.
- Missing or invalid config → fail closed (`CONFIG_MISSING` / `CONFIG_INVALID`).
- A function named for live settle always returns deny; it never opens a network path.

### D4 — Hard non-grants (billing ≠ authority)

Billing success **must not**:

- authorize config promotion (ADR 0008 / monorepo Control Plane);
- arm EXECUTE or always-on execute;
- unpause agents or override Policy Engine;
- grant `x402_funded_spend`, `wallet_spend`, or CDP spend to consumers.

`billingAuthorityFlags()` always returns hard-false for those labels (align with private-workspace-analytics deny set).

### D5 — Relationship to ADR 0003

| ADR 0003 | ADR 0009 |
|----------|----------|
| Historical product API `paymentMiddleware` for agent retries | SkillOS **adapter** for testnet/dry-run billing only |
| May involve facilitator + USDC on Sepolia in **apps/api** product path | **No** live facilitator in this package |
| Do not config-flip funded reachability into SkillOS core | Funded path unrepresentable as success here |

ADR 0003 remains valid for its product surface. This ADR does **not** rewrite 0003; it **seals** SkillOS evaluation/adapter space against funded settle.

## Consequences

### Positive

- One audit surface for SkillOS billing adapter  
- Offline CI green without secrets or network  
- Funded mode cannot succeed by env typo  

### Negative / residual

- Live testnet settle still lives only in product `apps/api` (ADR 0003) if operators use it — not in this package  
- Cross-package consumers must not reimplement settle  

## Rollout / rollback

1. Land package + ADR + CI path list; dual CRITICAL review.  
2. Rollback = revert pin; no funded path is opened by absence of this package.  

## Non-goals recap

- No secrets in fixtures (dummy digests/ids only)  
- No Simpl3 monorepo edits  
- No phase exit / deploy / EXECUTE  

## References

- `packages/x402-testnet-billing/`  
- `docs/adr/0003-agent-x402-retry-payments.md`  
- PREFLIGHT: `…_SKILLOS_FAZ3_X402_TESTNET_BILLING_PREFLIGHT.md`  
