# AgentKit / Agent Skill adapter (SkillOS)

**Package:** `@skillos/agentkit-skill-adapter` · **version:** 0.1.0  
**Task:** `SKILLOS-FAZ3-AGENTKIT-SKILL-ADAPTER` (Faz 3 plan #9)

## Purpose

Provide a **versioned, rail-neutral** surface for registering Agent Skill–shaped tools that SkillOS (or host agents) can dry-run without coupling core verify / promotion / runner logic to Coinbase AgentKit, CDP wallets, or funded rails.

## Modes

| Mode | Meaning |
|------|---------|
| `dry_run` | Simulated invoke; default offline success path |
| `fixture` | Same as dry-run for test fixtures |

`live`, `funded`, `mainnet`, and `production` **cannot** succeed in this package.

## Non-grants

Adapter success never authorizes: EXECUTE, config promotion, wallet/CDP spend, `x402_funded_spend`, control-plane unpause, or policy bypass.

## Relationship to product AgentKit

Coinbase AgentKit remains an external reference (`docs/architecture/developer-surface.md`). Live integration is **out of scope** here; a future package or escalated CRITICAL task would be required for runtime SDK use.
