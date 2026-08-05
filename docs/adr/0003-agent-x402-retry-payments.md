# ADR 0003 — Agent x402 Retry Payments

**Status:** Accepted — 2026-05-15
**Sprint:** X15 (Phase 2 mainnet critical path)
**Deciders:** Founder + X20 marathon agent session (post-marathon morning review)
**Related:** `docs/sprints/X15-agent-x402-retry-payments.md`, ADR 0002 (dual-profile pipeline split, audit reproducibility prerequisite); **see also ADR 0009** (SkillOS rail-neutral testnet billing adapter — dry-run only; do not config-flip funded settle into SkillOS core).

## Context

X20 (2026-05-14/15) shipped the solo agent spectator MVP. During end-to-end demo recording verification, the second `submitSoloScore` call from the same agent against `X20_DEMO_TOURNAMENT_ID` reverted with `InsufficientFeePaid` at `TournamentPool.sol:486`. The contract enforces *"first solo submission per (tournament, player) is free; N-th (N≥2) requires (N-1)·ENTRY_FEE paid via chargeEntryFee"*. This is correct economic enforcement, not a bug — but it blocks multi-take demo recording without rotating tournaments, and it blocks the agent-economy primitive that Phase 2 mainnet depends on.

The X20 marathon mitigated by rotating `X20_DEMO_TOURNAMENT_ID` per take (5 USDC + ~10 min ops overhead per take). That works for one-off recordings but is not a class-agnostic primitive. SkillOS's locked architecture treats agents and humans as the same submission class — they must pay the same fees through the same primitive. The native payment primitive is x402 (HTTP 402 Payment Required), already in use at `/v1/data/*` paid data tier from Sprint X5.

This ADR locks the architectural decisions for **extending the existing x402 wire to gate `/v1/agents/matches/start-solo` retries** so that the second + N-th run against one tournament settles on-chain without external ops intervention.

The scope doc (`docs/sprints/X15-agent-x402-retry-payments.md`) carries the full architectural rationale, the nine sub-task plan (X15.1–X15.9), and seven open questions O1–O7 with recommended defaults. Founder reviewed 2026-05-15 morning and locked all defaults. This ADR crystallizes the resulting decisions.

## Decision

The following are accepted as binding for sprint X15:

### D1 — Agent self-pays via AGENT_PRIVATE_KEY (Option α)

The agent's own private key (`AGENT_PRIVATE_KEY`) signs both the off-chain EIP-3009 `transferWithAuthorization` for the x402 API fee AND the on-chain `chargeEntryFee(id, agentAddress)` transaction. Studio-wallet-broker pattern (Option β) is **rejected** — `TournamentPool.sol:525` enforces `msg.sender == player` on `chargeEntryFee`, which makes a relayer impossible without contract modification.

The agent wallet must hold ENTRY_FEE worth of USDC per retry. Operator pre-funds (see D6).

### D2 — Extend existing apps/api/src/lib/x402.ts, do not introduce new infra

Sprint X5 already ships `paymentMiddleware` from `@x402/hono` gating `/v1/data/match-replay/:id` and `/v1/data/cohort-snapshot`. X15 adds `/v1/agents/matches/start-solo` to the same `paymentMiddleware` route map. No new middleware, no new dependency, no new facilitator client.

### D3 — x402 API fee and on-chain entry fee are the same dollar (O1)

The 1.0 USDC the agent pays via x402 is the **same dollar** that funds the subsequent `chargeEntryFee` call to the contract. The agent does not pay twice. UX framing: *"$1.00 entry fee per retry, settled via x402 + on-chain"*, not *"$1.00 API fee + $1.00 entry fee"*.

Implementation: x402 settles agent → `X402_RECEIVER_ADDRESS`. The receiver wallet (or a derivation thereof, see D6 follow-up) is the agent wallet itself, OR the agent wallet maintains a separate USDC float for `chargeEntryFee` that the x402 fee replenishes. Final mechanism to be detailed in X15.1 ADR follow-up if needed.

### D4 — API fee price: $1.05 USDC (O2)

`X402_AGENT_RETRY_PRICE = "$1.05"`. The $0.05 surplus over `ENTRY_FEE` (1.0 USDC) covers Base Sepolia gas for the chargeEntryFee tx + facilitator fee margin + observability budget. Atomic units: `1_050_000`.

### D5 — Visible payment moment in apex spectator UI (O3)

The `/watch` route StartMatchButton (and downstream `/watch/[runId]` hydration) shows the x402 settlement moment as visible UX state: *"Authorizing payment via x402… settling on Base Sepolia…"*. The payment moment is the differentiator vs closed gaming platforms and a key element of the Phase 2 pitch deck cut — do not hide it.

### D6 — Operator manual pre-fund for X15 (O4)

For sprint X15, agent wallet USDC top-up is operator-managed (manual transfer from studio wallet). Sponsor-pool-stream and earn-from-payouts mechanisms are deferred to X16. Monitoring: alert when studio wallet USDC < 5.0; alert when agent wallet USDC < 2.0 (covers ≥1 immediate retry + buffer).

### D7 — 2048 only for X15 (O5)

X15 wires paid retry on the 2048 agent runner path only. Multi-game agent runners are X18 scope. Game-slug → tournament-id map is single-entry for X15.

### D8 — x402.org testnet facilitator for Phase 2 (O6, partial)

Sprint X15 ships against `https://x402.org/facilitator` (current `X402_FACILITATOR_URL` default; no CDP signup required). CDP facilitator (`https://api.cdp.coinbase.com/platform/v2/x402`) migration is its own sub-sprint coupled with X12 audit + CDP API key provisioning + observability check.

### D9 — Reconciliation ledger + manual review for failure edge case (O7)

If x402 settles but `chargeEntryFee` reverts (e.g., insufficient agent USDC allowance), record the (runId, x402TxHash, debit) triple in `x15_payment_attempts` (X15.8) and surface for manual operator review. **No auto-refund logic** — refund mechanics are non-trivial (separate USDC transfer, signature, audit trail) and out of scope. Manual reconciliation is acceptable given the small expected failure rate on testnet.

### D10 — Mainnet CDP migration gated by X12 audit

Mainnet flip of X15 (real-USDC paid retries on Base mainnet) **requires** X12 audit firm sign-off on the x402 facilitator trust boundary, the AGENT_PRIVATE_KEY signing surface concentration, and the reconciliation ledger (X15.8). The audit firm receives the full payment-path trace; until they sign off, x402 stays on testnet.

### D11 — TrustedSigner pattern unchanged for submitSoloScore (X10 wire preserved)

X15 only touches the **fee payment** path. The `submitSoloScore` attestation pipeline (server signs digest with `STUDIO_PRIVATE_KEY` / `trustedSigner`, viem broadcasts with `dataSuffix` Builder Code attribution, agent receives credit on-chain) is preserved exactly as shipped in X10. The agent's x402 EIP-3009 signature is *not* the trustedSigner signature — these are independent cryptographic operations on different digests.

This separation matters for audit: the trustedSigner role retains its scoped responsibility (score attestation only). x402 introduces an *additional* signing surface (agent's EIP-3009 on USDC), not a replacement.

> **NOTE — Selector vs source naming dual-state (discovered X15.4):**
> Local Solidity source at `contracts/src/TournamentPool.sol` renames the function to `chargeEntryFee` (per v2.2 WIP PR #49). Deployed v2.1 bytecode on Base Sepolia continues to expose the `chargeRetryFee` selector. Foundry tests use the X15 lexicon (`chargeRetryFee`) for naming parity in `test_*` names, but test bodies call `pool.chargeEntryFee` since Foundry runs against local source. Phase 2 mainnet deploy of v2.2 resolves the drift: new bytecode selector becomes `chargeEntryFee`, and X15.3 backend wire (`charge-retry-fee.ts`) requires selector rename as part of mainnet cutover sprint (X19b.1 + X11).

## Verified end-state (May 15, 2026)

X15.7 closed the loop on production verification. Canonical demo run `0c1b0e88-39c2-42a4-930b-fdc6da52795f` (final score 96, 24 moves) anchored cleanly against tournament `0xe7f14e22…1922e2` on Base Sepolia:

- **x402 EIP-3009 settle** — $1.05 USDC, x402.org testnet facilitator. Authorization signed by the agent (AGENT_PRIVATE_KEY); the facilitator pays gas and submits the on-chain `transferWithAuthorization`. Tx: `0x4e57d7fe…`.
- **`chargeRetryFee` on-chain** — $1.00 USDC, agent self-pays (`msg.sender == player` constraint preserved). Tx: `0x5d6918ba…`, block 41551888.
- **`submitSoloScore` on-chain** — trustedSigner via X10 wire (D11 preserved). Tx: `0xf649727b…`, calldata 734 hex with trailing `bc_o6szuvg1` ASCII dataSuffix (matches X10 baseline per [`project_api_server_side_datasuffix_attribution_gap`](../../.claude/memory/) auto-memory).
- **Per-paid-retry economic drain:** $2.05 ($1.05 x402 to receiver float + $1.00 on-chain to TournamentPool fee accumulator).
- **Free-first-slot drain:** $1.05 (x402 only; `chargeRetryFee` skipped per the contract's `priorSolo == 0` branch). Empirically reproduced by the founder pre-test run `0e7652d2-…`.

Lifecycle states empirically observed (3 X15.7 retries + 1 pre-test):

| Path | Transitions | Frequency |
|---|---|---|
| Paid retry happy path | `pending → x402_settled → anchored` | 2 / 4 |
| Free-first slot | `pending → x402_settled → skipped` (`reason='free_first_slot'`) | 1 / 4 |
| Settled-but-not-anchored | `pending → x402_settled → failed` (`needs_manual_review=true`, `error_code='CHARGE_RETRY_FEE_FAILED'`) | 1 / 4 (Run 1; cross-RPC race — see Pattern #21) |
| x402-failed-pre-settle | `pending → failed` (`error_code='X402_SETTLE_FAILED'`) | 0 successful; 1 transient first-attempt recovered on retry (Pattern #22) |

**`needs_manual_review` ledger pattern proven.** Run 1 produced exactly the failure mode D9 was designed to capture: x402 USDC pulled from the agent, `chargeRetryFee` never broadcast, audit row preserved with both tx context and `error_code`. The operator reconciliation path is the documented `chargeEntryFee`-via-script follow-up; no auto-refund per D9 design.

**End-state validity for mainnet readiness.** Observed lifecycle transitions match ADR predictions exactly — no state transition appeared that was not enumerated in D9. The settled-but-not-anchored failure is operator-recoverable via the ledger; the x402-failed-pre-settle failure is a clean no-op (no USDC moves until the facilitator returns `success=true`). Both modes are auditable end-to-end through the `x15_payment_attempts` Realtime stream.

## Consequences

### Positive

- **Multi-take demo recording.** N takes against one tournament. Recording duration drops from "rotate tournament per take" (10+ min/take) to "agent pays $1 per take" (~30 sec/take).
- **Agent-economy pitch material.** *"Agents pay programmatically via x402 for retry access"* is no longer aspirational — it ships as the same primitive that already gates `/v1/data/*`.
- **Class-agnostic invariant honored.** Agents and humans pay the same `chargeEntryFee` through the same contract path. SP-tier classification flows uniformly across classes (locked architecture pillar preserved).
- **Flywheel proof in one sprint.** AI lab data licensing (Sprint X5) and agent retry payments (X15) use the same x402 substrate. Both flows demonstrable side-by-side without architectural divergence.
- **Phase 2 mainnet pre-work compressed.** X12 audit gate has a single x402 path to review across both data tier + agent tier.

### Negative

- **Agent wallet refill operational overhead.** Each retry consumes 1 USDC from the agent wallet. At ~50 USDC float, ~50 retries per refill cycle. Manual pre-fund (D6) is operator burden until X16 introduces stream/payout-fund mechanisms.
- **x402.org single-vendor testnet dependency.** No SLA on x402.org facilitator. If it goes down mid-recording or mid-demo, sprint deliverable blocks. Mitigated by CDP migration plan (D8/D10) but adds Phase 2 sub-sprint scope.
- **Demo recording deferred ~2 working days.** Cannot record polished cut until X15.7 verification passes. The X20 single-take demo (`https://skillos.network/watch/693b61b1-…`) remains as interim asset.
- **AGENT_PRIVATE_KEY signing surface concentrated.** Same key now signs (a) submitSoloScore digests (no — that's STUDIO/trustedSigner, see D11), (b) EIP-3009 USDC authorizations, (c) chargeEntryFee + submitSoloScore broadcast transactions. Wallet hygiene memo for X12 audit: AGENT_PRIVATE_KEY is now load-bearing for both payment and execution paths.

### Neutral

- **submitSoloScore path unchanged.** Existing X10 wire (digest signing, viem writeContract, dataSuffix builder code) preserved verbatim.
- **TournamentPool contract requires no changes.** Free-first-paid-subsequent invariant remains; x402 is purely an off-chain orchestration layer that ensures `chargeEntryFee` lands before the next `submitSoloScore`.
- **Foundry test suite extends, not refactors.** Existing `test_submitSolo_*` patterns in `TournamentPool.t.sol:756-855` are the foundation for X15.4 paid-retry tests.

### Reversibility

Cheap. To unwind X15 if x402 testnet facilitator proves unreliable or if a better primitive emerges:

1. Remove `/v1/agents/matches/start-solo` from `apps/api/src/lib/x402.ts` route config (single delete in route map).
2. Revert apex StartMatchButton 402 handling to single-POST X20 behavior.
3. Drop `x15_payment_attempts` table (data migration; not destructive — history can stay archived).
4. Existing tournaments + on-chain state are untouched.

ADR Status flips to Superseded with a pointer to the replacement decision. No on-chain rollback required.

## Alternatives Considered

**Option β — Studio-wallet-broker pre-charge.** Server-side studio wallet calls `chargeEntryFee(id, agentAddress)` on behalf of the agent before `submitSoloScore`. **Rejected** — `TournamentPool.sol:525` enforces `if (msg.sender != player) revert PlayerMismatch();`. Broker pattern requires either contract modification (adds audit surface; rejected) or relayer ABI (not on the v2.1 contract). Option α (D1) is the only path that respects the existing contract.

**Phase 1 manual workaround — agent manually calls chargeEntryFee outside x402.** Could work, but is not x402-native, does not exercise the AI-lab-data-licensing-shared substrate, and breaks the class-agnostic primitive (humans use x402 for the same retry; agents would be on a divergent path). **Rejected** as architecturally inconsistent.

**Indefinite recording deferral — wait for X16+ stream-funding to ship before any paid-retry work.** **Rejected** — sprint X15 is bounded (~2 working days), and the demo asset has near-term Phase 2 pitch leverage. Deferring further is not justified by the avoided complexity.

**CDP facilitator immediately in X15.** **Rejected for X15** — CDP API key provisioning + observability + auth-key rotation is its own sub-sprint scope. Testnet `x402.org` is functionally adequate for X15.7 verification. CDP migration is D8 follow-up gated by D10.

## Implementation Plan

Critical path summary (full plan in scope doc §3):

| Subtask | Effort | Key artifact |
|---|---|---|
| X15.1 | 2 pomodoros | Audit + this ADR (done) |
| X15.2 | 3 pomodoros | Add route to `paymentMiddleware` route map |
| X15.3 | 4 pomodoros | Server-side `chargeEntryFee` orchestration via AGENT_PRIVATE_KEY (D1) |
| X15.4 | 3 pomodoros | Foundry tests in `contracts/test/X15-paid-retry.t.sol` |
| X15.5 | 4 pomodoros | Apex `StartMatchButton.tsx` 402 + payment-visible UX (D5) |
| X15.6 | 2 pomodoros | Agent-side x402 client helper |
| X15.7 | 3 pomodoros | E2E verification (3 sequential retries; SC1–SC7 pass) |
| X15.8 | 3 pomodoros | `x15_payment_attempts` ledger + reconciliation (D9) |
| X15.9 | 2 pomodoros | ADR follow-up / env.example / README |

Critical path total ~15 pomodoros (~6 focused hours / ~2 working days with review cycles).

## Mainnet Readiness Dependencies

- **X12 audit** must cover:
  - x402 facilitator trust boundary (facilitator's USDC settlement surface vs SkillOS server's downstream `chargeEntryFee` write)
  - AGENT_PRIVATE_KEY signing-surface concentration (per D11 + per Negative consequence #4)
  - `x15_payment_attempts` ledger reconciliation procedure (D9)
  - Settle-guard tripwire test coverage extension (X15.4)
- **X13 Cayman counsel review** must clear:
  - x402 facilitator regulatory framing — protocol vs service / money transmitter classification
  - ENTRY_FEE classification at mainnet (sweepstakes entry vs platform access fee)
  - Agent wallet KYC question — does the agent qualify as a "user" (KYC required) or "platform infrastructure" (KYC at studio level)?
- **X19b.1 key rotation expansion** must add AGENT_PRIVATE_KEY mainnet rotation procedure. The X19b separation of fee-vault role from trustedSigner role (PR #86) already documents the role-segregation pattern; X15 introduces a new role (agent payment signer) that must follow the same wallet-hygiene discipline.

## References

- Scope doc: `docs/sprints/X15-agent-x402-retry-payments.md`
- ADR 0002: dual-profile pipeline split (audit reproducibility prerequisite)
- Existing x402 wire: `apps/api/src/lib/x402.ts` (Sprint X5)
- Existing x402 dependencies: `apps/api/package.json` (`@x402/hono` `@x402/core` `@x402/evm` ≥ 2.11.0)
- Existing solo runner: `apps/api/src/lib/duel/runner.ts` (X20)
- Existing solo route: `apps/api/src/routes/agents-matches.ts` (X20)
- Existing agent score route (canonical TrustedSigner pattern, D11): `apps/api/src/routes/agents.ts`
- Contract: `contracts/src/TournamentPool.sol` — `submitSoloScore` line 463, `chargeEntryFee` line 524, `msg.sender == player` constraint line 525, `InsufficientFeePaid` revert line 487
- Contract tests: `contracts/test/TournamentPool.t.sol` lines 756–855 (free-first-paid-Nth coverage)
- Coinbase x402 protocol: <https://docs.cdp.coinbase.com/x402/welcome>
- Coinbase x402 sellers quickstart: <https://docs.cdp.coinbase.com/x402/quickstart-for-sellers>
- Coinbase x402 buyers quickstart: <https://docs.cdp.coinbase.com/x402/quickstart-for-buyers>
- EIP-3009 (transferWithAuthorization): <https://eips.ethereum.org/EIPS/eip-3009>
- USDC Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- TournamentPool Base Sepolia v2.1: `0x52049b812780134d2F69D6c20C2ef881D49702da`
- ChallengeEscrow Base Sepolia: `0x52e5E45456DeC882048b430a968Cda6061575be0`

## Sign-off

- **Founder:** 2026-05-15 — O1–O7 + R-MITIGATE-1 Option α approved at morning review; this ADR crystallizes the decisions.
- **Audit gate:** pending X12. Mainnet flip blocked until audit firm signs off on D10 dependencies.
- **Legal gate:** pending X13 Cayman counsel review of D8 + D10 + agent-KYC classification. Recommended before X15.2 kickoff.
