# @skillos/x402-testnet-billing

Rail-neutral **testnet / dry-run** billing adapter for SkillOS (ADR 0009).

## What it is

- Pure TypeScript quote / authorize / settle interface
- Allowed modes: `dry_run`, `fixture` only
- Offline-safe: no network, facilitator, or USDC required
- Funded / mainnet / live settle **unreachable by construction**

## What it is not

- Not a live x402 facilitator client
- Not a promotion or EXECUTE authority
- Not an expansion of `apps/api` `paymentMiddleware` (see ADR 0003)

## Usage

```ts
import {
  createBillingConfig,
  quoteBilling,
  authorizeBilling,
  settleBilling,
  billingAuthorityFlags,
} from "@skillos/x402-testnet-billing";

const config = createBillingConfig({ mode: "dry_run" });
const quote = quoteBilling(
  { requestId: "req_1", amountAtomic: 1_050_000n, asset: "USDC" },
  config,
);
const auth = authorizeBilling(quote, config);
const settled = settleBilling(auth, config);
// settled.ok === true only for dry_run/fixture; never funds a rail

// Always hard-false:
billingAuthorityFlags();
// { promoteAuthorized: false, executeEnabled: false, x402FundedSpend: false, ... }
```

## Tests

```bash
npm test --workspace=@skillos/x402-testnet-billing
npm run typecheck --workspace=@skillos/x402-testnet-billing
```
