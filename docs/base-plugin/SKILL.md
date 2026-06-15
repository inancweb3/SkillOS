---
name: skillos-sponsor-pool
description: >-
  Use when a Base-MCP agent (Claude Desktop / ChatGPT / coding harness) with a
  connected Base wallet wants to permissionlessly sponsor a SkillOS tournament
  prize pool with USDC on Base Sepolia. Discovers a tournament, prepares the
  [USDC.approve, SponsorshipModule.sponsorPool] calldata from the SkillOS API,
  and submits it via the Base wallet's send_calls. Requires only a Base wallet
  MCP + HTTP fetch — no SkillOS-specific MCP install.
homepage: https://skillos.network
metadata:
  version: 0.1.0
  network: base-sepolia
  chainId: 84532
---

# SkillOS · Sponsor a tournament prize pool

Permissionlessly fund a SkillOS skill-tournament prize pool with USDC, straight
from your Base wallet. Anyone can sponsor any open tournament — there is no
allowlist; the only on-chain gate is a sanctions screen. When the sponsorship
lands, the prize pool grows and your wallet receives a soulbound
`SponsorReceiptSBT`.

This skill needs only two capabilities your agent already has:

1. **A Base wallet MCP** that exposes `send_calls` (e.g. base-mcp / Base Account).
2. **HTTP fetch** (to read the SkillOS API).

You do **not** need to install any SkillOS MCP server. SkillOS hands you ready
calldata over a plain HTTP GET; your wallet does the signing and broadcast.

---

## STOP — onboarding gate (do this before sending anything)

Do not proceed to `send_calls` until ALL of these are true. If any is unmet,
stop and tell the user what's missing.

- [ ] **Network is Base Sepolia (testnet, chainId 84532).** This is Phase 1 —
      mainnet is not live. Never send these calls on any other chain.
- [ ] **The wallet holds Base Sepolia USDC** ≥ the amount to sponsor. USDC is
      `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals). Testnet USDC
      is available from the Circle faucet (https://faucet.circle.com, select
      Base Sepolia). The wallet also needs a little Base Sepolia ETH for gas.
- [ ] **The user has confirmed the spend.** Sponsoring *moves real (testnet)
      USDC out of the wallet into the prize pool*. It is not refundable by this
      flow. Confirm the tournament, the amount, and that the user wants to fund
      it.
- [ ] **The wallet is not sanctions-listed.** `sponsorPool` reverts on-chain for
      sanctioned senders (this is the protocol's only gate). If the call reverts
      with a sanctions error, do not retry.

State explicitly to the user: *"This will spend `<amount>` test-USDC from your
Base wallet to sponsor tournament `<id>`. Proceed?"* — and wait for a yes.

---

## Orchestration

```
discover tournament  →  prepare calldata  →  send_calls  →  confirm
   (read API)            (read API)          (your wallet)   (read API/chain)
```

### Step 1 — Discover a tournament (read-only)

List open tournaments and pick one. Confirm it is **not settled** (you cannot
fund a settled pool).

```
GET https://api.skillos.network/v1/tournaments
GET https://api.skillos.network/v1/tournaments/{id}
```

Take the tournament's `id` (a `bytes32` hex string, e.g.
`0x400e6448…0da5b7e5`). If the user already gave you an id, just fetch
`/v1/tournaments/{id}` to validate it exists and is open.

### Step 2 — Prepare the calldata (read-only, auth-less)

Ask the SkillOS API to build the exact call batch. This endpoint signs nothing,
holds no key, and requires no auth — it only ABI-encodes calldata.

```
GET https://api.skillos.network/v1/prepare/sponsor-pool
      ?tournamentId=<bytes32 id>
      &amount=<decimal USDC, e.g. 5 or 2.5>
      &from=<your wallet address>        # optional; echoed into the hint
```

Response (HTTP 200):

```json
{
  "action": "sponsor-pool",
  "chainId": 84532,
  "network": "base-sepolia",
  "calls": [
    { "to": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "value": "0x0", "data": "0x095ea7b3…" },
    { "to": "0xD76670adB574A4C8D06dfF47127e7143d780ff87", "value": "0x0", "data": "0x78e0c649…" }
  ],
  "tournamentId": "0x400e6448…0da5b7e5",
  "amount": "2.5",
  "atoms": "2500000",
  "hint": "Submit via base-mcp send_calls(chain=\"base-sepolia\", calls=[...]) …"
}
```

- `calls[0]` is `USDC.approve(SponsorshipModule, amount)` — grants the module the
  pull.
- `calls[1]` is `SponsorshipModule.sponsorPool(tournamentId, amount)` — pulls the
  USDC into the segregated prize pool and mints your receipt.
- The two calls **must execute in order**. Pass them through verbatim — do not
  reorder, drop, or edit them.

Bad input returns HTTP **422** with `{ "error": { "code": "INVALID_PARAMS", … } }`.

### Step 3 — Send via your Base wallet (`send_calls`)

Hand the `calls` array straight to your wallet MCP. The batch executes
atomically; the user approves once in their Base Account.

```
send_calls(chain="base-sepolia", calls=<calls from step 2>)
```

This returns an `approvalUrl` (for the user to confirm) and a `requestId`.

### Step 4 — Confirm

- Poll your wallet MCP's `get_request_status(requestId)` until it completes and
  you have a transaction hash.
- Verify the result via SkillOS:
  - `GET /v1/sponsors/{wallet}/receipts` → your new `SponsorReceiptSBT` for this
    tournament.
  - `GET /v1/tournaments/{id}` → the prize pool reflects your contribution.

Report the tx hash and the updated prize pool to the user.

---

## Failure modes

| Symptom | Cause | What to do |
|---|---|---|
| Prepare returns 422 | Bad `tournamentId` (not 0x+64 hex) or `amount` (≤0 / >6 decimals) | Fix the params; re-read step 2. |
| `send_calls` reverts on call 2 with a sanctions error | Sender is sanctions-listed (the protocol gate) | Stop. Do not retry. Surface to the user. |
| Revert on call 2: insufficient balance | Wallet lacks the USDC | Top up Base Sepolia USDC (faucet) and retry. |
| `send_calls` rejected / no gas | No Base Sepolia ETH for gas | Fund the wallet with testnet ETH. |
| Wrong chain | Wallet not on Base Sepolia | Switch to `base-sepolia` (84532). Never send on another chain. |

---

## Reference (Base Sepolia · Phase 1)

| Thing | Value |
|---|---|
| API base | `https://api.skillos.network` |
| Prepare endpoint | `GET /v1/prepare/sponsor-pool` |
| Chain | Base Sepolia · chainId `84532` |
| USDC (6 dp) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| SponsorshipModule | `0xD76670adB574A4C8D06dfF47127e7143d780ff87` |
| `sponsorPool(bytes32,uint256)` selector | `0x78e0c649` |
| `approve(address,uint256)` selector | `0x095ea7b3` |

Permissionless by design: `sponsorPool` is callable by any non-sanctioned
wallet. SkillOS never custodies your funds — the approval and transfer are
authorized by your wallet, on your signature, in a single batch.
