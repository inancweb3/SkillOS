# SkillOS Product Roadmap

> Status: proposed execution plan
>
> Updated: August 1, 2026
>
> Canonical strategy: [`docs/SkillOS-Strategic-Memory-v1_12.md`](./docs/SkillOS-Strategic-Memory-v1_12.md)
>
> GitHub execution tracker: [issue #210](https://github.com/youngstar-eth/SkillOS/issues/210)

## Product direction

SkillOS is proof-of-skill infrastructure: permissionless arenas where humans and AI agents complete bounded tasks, submit evidence, receive a verifiable result, build a portable skill record, and can earn rewards.

Games remain useful reference implementations because they are bounded and objectively measurable. They are not the product boundary. The same substrate should support coding, benchmarks, math, research, design, and other capabilities through domain-specific adapters and verifier modules.

The first non-game wedge will be **verifiable AI capability benchmarking**, beginning with coding tasks and deterministic verification. Existing benchmark suites should be importable as arena adapters instead of rebuilt inside SkillOS. SkillOS adds reproducible run provenance, participant-owned evidence, permissionless sponsorship, portable skill records, and auditable settlement. Coding matches the architecture already in the repository, is naturally useful to AI agents, can be verified with reproducible tests, and avoids making the unbuilt staked-resolution system a launch dependency.

## Current baseline

| Surface | Current reality |
|---|---|
| Protocol | Base Sepolia contracts, tournament settlement, sponsor pools, and on-chain receipts exist. |
| Reference adapters | Six games demonstrate bounded tasks, scoring, leaderboards, and tournament flows. |
| Developer surface | API, SDK, CLI, MCP, skill pack, and an agent runner exist at different maturity levels. |
| Verification | Deterministic replay has a game scaffold; generalized evidence verification is not yet a stable public interface. Judgment-based staked resolution is design-only. |
| Security | Hardening is prepared in [PR #200](https://github.com/youngstar-eth/SkillOS/pull/200); it must land before reopening agent-funded execution. |
| Operations | Production API and game-domain deployment/DNS health must be restored and proven before the product is called live. |

## North-star outcome

An external developer can import or define a deterministic benchmark arena without modifying SkillOS core, an agent can discover and enter it through SDK/CLI/MCP, SkillOS can independently reproduce the result from submitted evidence, and a sponsor-funded reward can settle with an auditable on-chain trail.

The first proof point is complete when all of the following are true:

- one non-game benchmark arena is imported or created from configuration and an adapter;
- at least 10 distinct human or agent participants complete 250 verified runs;
- at least 95% of valid submissions reproduce deterministically;
- invalid or tampered evidence never settles a reward;
- one external sponsor funds a testnet challenge;
- every reward has an API record, verifier result, transaction receipt, and explorer link;
- a new developer reaches a first verified run in under 30 minutes from public documentation.

## Execution roadmap

Dates below are target windows, not launch promises. A phase advances only when its exit gate is met.

### Phase 0 — Restore a trusted baseline ([#208](https://github.com/youngstar-eth/SkillOS/issues/208))

**Target:** August 1–7, 2026

**Goal:** make the existing system safe, deployable, and observable again.

- Merge the approved security and dependency-hardening PRs after review.
- Restore `api.skillos.network`, OpenAPI, and all reference-app DNS/deployments.
- Run production smoke tests for health, auth, arena discovery, score submission, x402 settlement, and scheduled agent execution.
- Confirm deployed commits match the intended Git SHAs and capture Base Sepolia transaction evidence.
- Publish a simple service-status/runbook document and identify owners for API, signer, database, DNS, and contract incidents.
- Keep T1–T3 claims disabled until their corresponding verifier path exists.

**Exit gate:** CI is green, production endpoints are healthy for seven consecutive days, scheduled runs succeed, and no unauthenticated or mismatched wallet can trigger platform spending.

### Phase 1 — Make the arena primitive genuinely domain-neutral ([#209](https://github.com/youngstar-eth/SkillOS/issues/209))

**Target:** August 8–28, 2026

**Goal:** turn the existing game-oriented implementation into a configurable proof-of-skill core without rewriting the working protocol.

- Lock an ADR for `ArenaDefinition`: category, entry, prize source, format, verifier, resolution, capability axes, data tier, and data rights.
- Define a versioned `BenchmarkManifest` that pins suite, dataset, task, evaluator, environment, resource policy, and scoring configuration.
- Define a versioned `EvidenceEnvelope` and a verifier interface with deterministic, staked, and hybrid capability flags.
- Introduce backward-compatible arena endpoints while keeping tournament/score clients working during migration.
- Make verification status explicit: submitted, verifying, verified, rejected, disputed, or settled.
- Move game-specific behavior behind adapters; migrate the six games as compatibility fixtures.
- Expose arena create/list/get, attempt start/submit/status, and evidence verification through SDK, CLI, and MCP.
- Add end-to-end fixtures proving that a new deterministic adapter does not require a core schema or contract change.

**Exit gate:** a repository fixture can import or register a new deterministic benchmark arena, run it locally, verify evidence, and appear on a leaderboard without copying or modifying a game app.

### Phase 2 — Ship verifiable AI benchmarking, coding first ([#207](https://github.com/youngstar-eth/SkillOS/issues/207))

**Target:** August 29–September 18, 2026

**Goal:** prove that SkillOS can run reproducible AI capability evaluations, not only games, while reusing rather than replacing existing benchmark suites.

- Define an import adapter for versioned benchmark suites and a coding challenge manifest: suite and dataset revision, task, constraints, public tests, hidden tests, timeout, resources, and scoring function.
- Run submissions in an isolated, network-restricted sandbox with pinned toolchains and deterministic fixtures.
- Store reproducible run provenance: benchmark and evaluator revision, model and agent version, source and patch hash, environment digest, tool policy, test results, token/cost/latency metrics, resource usage, score, and verifier signature.
- Add contamination controls: signed private task packages, public/private splits, evaluator versioning, disclosure rules, and no secret test content in public traces.
- Support agent participation through SDK, CLI, MCP, and the SkillOS skill pack.
- Add benchmark leaderboards filterable by suite, model, agent framework, and version, plus a watchable verification trace with sensitive content redacted.
- Run repeated trials for a fixed subset and report score variance instead of presenting one run as a universal capability claim.
- Dogfood with at least three challenge types: bug fix, test completion, and optimization.
- Fund and settle a Base Sepolia sponsor pool for the best verified result.

**Exit gate:** 100 internal runs across at least three agent configurations and three coding task families complete with reproducible scoring, repeated-run variance is reported, tamper and contamination tests fail closed, and a sponsor-funded benchmark reward settles end to end.

### Phase 3 — Run a closed proof-of-skill beta ([#204](https://github.com/youngstar-eth/SkillOS/issues/204))

**Target:** September 19–October 9, 2026

**Goal:** validate demand, usability, and economics with real participants before expanding scope.

- Recruit one design partner that needs agent capability evaluation or developer challenges.
- Run three to five benchmark campaigns, initially coding-focused, with explicit acceptance criteria and disclosed data rights.
- Onboard at least 10 participants and complete the 250-run north-star proof point.
- Measure arena setup time, first-run time, verification latency, failure reasons, sponsor cost, participant retention, and settlement accuracy.
- Interview sponsors and participants; document which results they trust, pay for, and reuse.
- Publish a testnet case study with reproducible evidence and transaction links.

**Exit gate:** the north-star proof point is met and at least one partner asks to run or fund a second arena.

### Phase 4 — Clear the mainnet gate ([#205](https://github.com/youngstar-eth/SkillOS/issues/205))

**Target:** parallel work during August–October 2026; launch date is audit- and legal-gated.

**Goal:** make a deliberate go/no-go decision instead of treating deployment as the milestone.

- Finalize the smallest contract scope needed for arena creation, sponsor pools, arena-creator fees, and settlement.
- Complete external contract review/audit and resolve every critical or high finding.
- Obtain legal review for skill contests, sponsor-funded rewards, agent participation, disputes, and target geographies.
- Rotate testnet keys; implement the documented role-separated wallet topology and multisig ownership.
- Add durable rate limiting, structured logs, alerting, backup/restore drills, signer monitoring, incident response, and a public status surface.
- Publish versioned SDK/CLI/MCP packages and migration documentation.
- Complete a seven-day testnet soak with no unexplained settlement, verification, or accounting mismatch.

**Exit gate:** audit, legal, operational, wallet, and soak-test checklists are all signed off. Any failed gate means remain on testnet.

### Phase 5 — Expand only after deterministic traction ([#206](https://github.com/youngstar-eth/SkillOS/issues/206))

**Target:** achievement-gated

**Goal:** broaden capability coverage without diluting the reliable core.

1. Add deterministic domains next: math, data transformation, and reproducible tool-use tasks; grow the benchmark-adapter registry from demonstrated demand.
2. Design staked resolution separately for research, negotiation, design, and other judgment-heavy skills.
3. Pilot hybrid arenas only after dispute incentives, resolver independence, and appeal mechanics survive adversarial testing.
4. Add per-axis skill credentials and the opt-in data marketplace only where pilot behavior demonstrates real demand.

## What is deliberately not on the critical path

- a governance or utility token;
- a broad marketplace before one repeatable arena workflow works;
- a foundation model trained on participant data;
- multiple judgment-based verticals before staked resolution is designed and tested;
- a rewrite of the six games;
- mainnet deployment before audit, legal, operations, and wallet gates are complete.

## Decision rules

- **Evidence before payout:** no verifier result, no settlement.
- **Adapters over forks:** a new skill adds an adapter and verifier, not a new copy of the platform.
- **Backward compatibility during migration:** existing games remain continuous fixtures for the generalized core.
- **One hard wedge first:** AI benchmarking, with coding as its first deterministic suite family, proves the non-game thesis before broader category expansion.
- **Gates over dates:** missed evidence moves the date; it does not weaken the gate.
- **Testnet is a product stage:** mainnet follows demonstrated repeatability, not narrative urgency.

## Immediate next actions

1. Review and merge the four open hardening PRs.
2. Restore and verify the production/testnet deployment surface.
3. Approve the arena/evidence ADR before implementing generalized endpoints.
4. Build the benchmark import interface and coding adapter as the first consumers of that interface.
5. Recruit one design partner while the AI benchmarking vertical slice is being built.
