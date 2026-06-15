# SkillOS Base plugin — v1 (sponsor-pool)

v1 of the SkillOS plugin for the Base agent ecosystem: it lets **any** Base-MCP
agent (Claude Desktop / ChatGPT / coding harness) perform one SkillOS on-chain
action — **permissionlessly sponsoring a tournament prize pool with USDC** — via
its Base wallet's `send_calls`, with no SkillOS-specific MCP install.

## The two pieces

| Piece | Where | What |
|---|---|---|
| **Prepare endpoint** | [`apps/api/src/routes/prepare.ts`](../../apps/api/src/routes/prepare.ts) → `GET /v1/prepare/sponsor-pool` on `api.skillos.network` | Auth-less, read-only. ABI-encodes the `[USDC.approve, SponsorshipModule.sponsorPool]` batch and returns it as `{ calls, chainId, … }` — the exact shape `send_calls` consumes. Signs nothing, holds no key. |
| **Skill** | [`SKILL.md`](./SKILL.md) | The portable plugin: STOP onboarding gate → discover tournament → call the prepare endpoint → `send_calls(chain="base-sepolia")` → confirm. |

The encode logic mirrors `packages/mcp/src/tools/fund_pool.ts` (the existing
`@skillos/mcp` `prepare_fund_pool` tool) so the HTTP surface and the MCP surface
stay byte-for-byte identical. The HTTP form exists so external agents that have
base-mcp but will not install `@skillos/mcp` can still use SkillOS.

## Why sponsor-pool (and why HTTP), v1

Picked for **least new-build × real external usage × consumer-app usable**:

- **Complete, self-contained action.** Sponsor → pool funded + soulbound
  `SponsorReceiptSBT`. No follow-on signing/auth needed (unlike `register`,
  which leaves the agent at a wall, or `compete`, whose score submit is
  server-signed and maps poorly to `send_calls`).
- **Cleanest `send_calls` map.** A single atomic 2-call batch (approve → sponsor).
  No personal_sign, no SIWA, no server-mediated submit.
- **On-narrative.** Permissionless sponsorship is a locked architectural
  invariant (CLAUDE.md #1/#2): segregated prize-pool slot, sanctions oracle the
  only gate.
- **Drift-safe.** Goes through `SponsorshipModule.sponsorPool` (identical across
  the deployed TournamentPool v2.1 and the v2.2 source), so it is unaffected by
  the on-disk-source-vs-deployed-bytecode drift that the entry/retry path has.
- **HTTP shape, not MCP-reuse.** The goal is *any* Base-MCP agent. An HTTP GET +
  `send_calls` reaches agents that have base-mcp but no `@skillos/mcp`; reusing
  the MCP tool would gate adoption behind an extra install.

## Where this lives / ships

- **Now (this PR):** drafted in-repo for review. The endpoint ships with the
  monorepo (`apps/api`); the skill is drafted here under `docs/base-plugin/`.
- **Next:** extract [`SKILL.md`](./SKILL.md) into our own skill-pack repo
  `youngstar-eth/skillos-skill-pack` (control is ours), then submit a follow-up
  PR to the upstream `base/skills` registry (format may need light adaptation to
  the upstream schema).

## Verification (this PR)

- `apps/api` typecheck + lint: clean.
- `apps/api/test/prepare.test.ts` (registered in CI `test-ts`): pure-helper unit
  tests decode the emitted calldata and assert exact selectors + args.
- In-process HTTP smoke: `GET /v1/prepare/sponsor-pool` → 200 with the correct
  batch; malformed id / zero amount → 422 envelope.

> Note: the `api` Vercel project is prod-only manual deploy (no preview), so the
> live `api.skillos.network/v1/prepare/sponsor-pool` after-proof (a real curl)
> is founder-gated post-merge — see the PR checklist.

## Future actions (not v1)

- `register` (ERC-8004 identity) — top-of-funnel onboarding; `prepare_register`
  already returns `send_calls`-shaped calldata. Natural v2.
- `compete` (pay retry + submit) — strongest value story, heaviest build: needs
  a new prepare path, mixes `send_calls` + personal_sign + server-signed submit,
  and is exposed to the v2.1/v2.2 selector drift.
