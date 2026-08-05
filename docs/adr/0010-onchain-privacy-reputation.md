# ADR 0010 — Onchain privacy placement (ERC-8004 reputation one-way)

**Status:** Accepted — 2026-08-06  
**Date:** 2026-08-06  
**Deciders:** Product owner (İnanç Ayvaz); architecture (Claude standing gate); implementation (Grok Build)  
**Primary repo:** `youngstar-eth/SkillOS`  
**Package:** `@skillos/erc8004-reputation`  
**Related:** Faz-3 task `SKILLOS-FAZ3-ERC8004-REPUTATION` · plan #10 · ADR 0005 (arena evidence) · ADR 0007 (workspace privacy) · ADR 0009 (rail-neutral billing)

## Status

**Accepted.** Freezes what SkillOS may project **toward** an ERC-8004-style reputation / identity surface, and the **one-way** rule that reputation outputs never authorize promotion or EXECUTE.

## Context

SkillOS verifies redacted evidence and digests. Public-chain reputation (including ERC-8004 agent identity and related trust signals) is a **hostile/public** surface: anything written onchain is permanent and world-readable. Without an explicit privacy placement:

- raw evidence, PII, portfolio, or secrets could leak into “reputation” payloads;
- a high reputation score could be mistaken for promotion or EXECUTE authority;
- live broadcast clients could pull wallet/chain SDK authority into default CI.

## Goals

1. Name **what may leave** SkillOS toward onchain reputation (digest / summary only).  
2. Name **what must never leave** (raw evidence, secrets, portfolio, private traces).  
3. Make reputation → promote / EXECUTE **unrepresentable as success** in the adapter.  
4. Ship a versioned dry-run adapter with offline tests and no funded chain client.

## Non-goals

| Out of scope | Why |
|--------------|-----|
| Live ERC-8004 mint/broadcast in default CI | Funded/live chain out of package |
| AgentKit residual A-1 / x402 X-1 fixes | Separate residuals |
| Trust dashboard (#11), phase exit | Later plan items |
| Simpl3 monorepo promotion engine | Control Plane / monorepo |

## Decision

### D1 — Projection allowlist (outbound)

Only these classes may appear in reputation projection outputs:

| Field class | Example | Notes |
|-------------|---------|--------|
| Subject digest | code commit / agent subject id (hex digest) | Public identifier |
| Evidence / measurement digest | JCS digest of redacted envelope | Not the envelope body |
| Summary code | short allowlisted status enum | e.g. `verified_pass`, `verified_fail`, `not_ready` |
| Schema / contract version | `0.1.0` | Adapter pin |
| Simulated onchain ref | dry-run receipt id | Never a real tx in this package |

### D2 — Projection denylist (must never leave)

| Class | Enforcement |
|-------|-------------|
| Raw evidence / traces | Reject input keys containing `evidence`, `trace`, `rationale`, `portfolio` |
| Secrets / keys | Reject `privateKey`, `apiKey`, `mnemonic`, `secret` |
| PII free-text blobs | Reject unbounded free-text fields beyond short summary codes |
| Unredacted SkillOS internals | Not accepted as projection inputs |

### D3 — One-way by construction

- Reputation projection success **never** authorizes config promotion, EXECUTE, Policy Engine bypass, or pause override.  
- Dedicated functions (`authorizePromotionFromReputation`, `authorizeExecuteFromReputation`, …) always return deny.  
- Projection receipts carry hard-false `promoteAuthorized` / `executeEnabled` / `funded` / `broadcast` flags.  
- There is **no** import path from reputation score into SkillOS decision/promotion modules in this package.

### D4 — Dry-run only broadcast path

- Modes: `dry_run` \| `fixture` only.  
- `broadcastReputationLive` always denies (`LIVE_PATH_UNREACHABLE`).  
- No third-party chain/wallet SDK runtime dependency for default green.

### D5 — Owner package

`@skillos/erc8004-reputation` is the single owner for SkillOS-side reputation projection shapes. Product ERC-8004 registry usage in `apps/api` / agent-runner remains historical product surface and is not widened by this ADR.

## Alternatives rejected

| Alternative | Why rejected |
|-------------|--------------|
| Bidirectional reputation → admission | Would feed public-chain signal into authority |
| Full evidence blob onchain | Privacy violation; permanent leak |
| Live broadcast in default package path | Funded/network surface in CI |

## Privacy / threat notes

- **Threat:** Adapter accepts raw evidence “for convenience.” **Mitigation:** denylist + digest-only fields.  
- **Threat:** Consumer treats reputation receipt as promote grant. **Mitigation:** hard-false flags + always-deny authority helpers.  
- **Threat:** Live broadcast via env flip. **Mitigation:** no live success mode in type union; live entry always denies.

## Rollout / rollback

Land package + ADR + CI path; dual CRITICAL review. Rollback = revert pin; absence of package does not open reputation authority.

## References

- `packages/erc8004-reputation/`  
- PREFLIGHT: `…_ERC8004_REPUTATION_PREFLIGHT.md`  
