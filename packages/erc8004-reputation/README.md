# @skillos/erc8004-reputation

ERC-8004–style **reputation projection** adapter for SkillOS (ADR 0010 · Faz 3 plan #10).

## What it is

- Projects **digest + summary only** shapes suitable for public-chain reputation
- **One-way:** reputation never authorizes promote / EXECUTE / policy / pause
- **Dry-run / fixture** modes only; live broadcast always denied
- Zero chain/wallet runtime dependencies

## What it is not

- Not a live ERC-8004 mint/broadcast client
- Not a bidirectional trust import into SkillOS decisions
- Not a promotion or execution authority

## Usage

```ts
import {
  createReputationConfig,
  projectReputation,
  authorizePromotionFromReputation,
} from "@skillos/erc8004-reputation";

const cfg = createReputationConfig({ mode: "dry_run" });
const r = projectReputation(
  {
    subjectDigest: "a".repeat(64),
    evidenceDigest: "b".repeat(64),
    summaryCode: "verified_pass",
  },
  cfg,
);
// r.ok → dry-run projection receipt; never broadcasts

authorizePromotionFromReputation(r); // always deny
```

## Tests

```bash
npm test --workspace=@skillos/erc8004-reputation
npm run typecheck --workspace=@skillos/erc8004-reputation
```
