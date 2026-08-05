# ERC-8004 reputation adapter (SkillOS)

**Package:** `@skillos/erc8004-reputation` · **version:** 0.1.0  
**ADR:** [0010-onchain-privacy-reputation.md](./adr/0010-onchain-privacy-reputation.md)  
**Task:** `SKILLOS-FAZ3-ERC8004-REPUTATION` (plan #10)

## Purpose

Project **digest + summary** shapes suitable for ERC-8004–style public reputation **without** leaking raw evidence and **without** feeding reputation into promote/EXECUTE.

## One-way rule

```
SkillOS digests  →  reputation projection  →  (optional future onchain)
                         ✗ never  →  promote / EXECUTE / policy / spend
```

## Modes

`dry_run` | `fixture` only. Live broadcast always denied offline.
