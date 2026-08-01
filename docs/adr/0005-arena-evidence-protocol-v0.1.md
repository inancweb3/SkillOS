# ADR 0005 — Arena / Evidence Protocol v0.1 (Offchain-First)

**Status:** Proposed — awaiting architectural approval (Phase 1A)
**Date:** 2026-08-01
**Deciders:** Product owner (İnanç Ayvaz); technical lead/reviewer (Codex); implementation (Grok Build)
**Primary repo:** `youngstar-eth/SkillOS`
**Related:** `ROADMAP.md` Phase 1 (#209); kit `context/03_INTEGRATION_CONTRACT.md`; kit `prompts/03_SHARED_PROTOCOL.md`; security baseline PR #200 (`b160104`); roadmap PR #203 (`7e73939`)

## Status

**Proposed.** This ADR freezes the **offchain protocol contract** for `@skillos/protocol` **v0.1.0**. No package implementation ships in this decision record. Implementation is gated on Codex acceptance of this ADR (Phase 1B).

## Context

SkillOS main already contains game-centric tournament, score, SIWA, x402, and MCP surfaces. The product direction (ROADMAP) requires a **domain-neutral** proof-of-skill substrate that can represent:

1. **Legacy games** (e.g. 2048) as continuous fixtures without breaking existing API/tournament clients.
2. **Simpl3 Safety Arena / agent evaluations** as synthetic, offline, read/propose-only runs that never receive SkillOS execution authority over Simpl3 CDP/Act.

Phase 0 engineering baseline is complete: security/CI hardening is on `main` (#200); offline `npm ci` and gates are green. Production/ops soak (7-day endpoint health, scheduled runs, funded execution) remains a **parallel** track and **does not block** offchain protocol design or package work.

Without a frozen ADR:

- Game score schemas and future eval traces risk diverging.
- Simpl3 and SkillOS cannot share golden fixtures or contract tests.
- Onchain placement vs private data would be reinvented per feature.

## Goals (v0.1)

1. Define versioned, domain-neutral types and (in 1B) JSON Schemas for arena/manifest/evidence/verification.
2. Multi-axis **measurements**; a single scalar “score” is optional, not canonical.
3. Canonical serialization + content digests so tamper is detectable.
4. Clear **onchain vs offchain** placement (privacy-preserving).
5. Semver rules; reject unknown protocol major versions.
6. Allow a **compatibility adapter** from current game score submission → evidence without breaking public game APIs or renaming `TournamentPool`.
7. Allow Simpl3 to consume the protocol as a **pinned package or published schema**, never via relative monorepo path or SkillOS server imports.

## Non-goals (v0.1)

| Out of scope | Why |
|--------------|-----|
| ERC-8004 / x402 / onchain storage as required fields | Optional later adapters |
| SkillOS control of Simpl3 CDP/Act/execute | Hard security boundary |
| Real user portfolio or production secrets in evidence | Privacy / trust |
| Breaking or renaming `TournamentPool` | Backward compatibility |
| Staked/judgment resolution runtime | Design later; capability flags only |
| Hosted private runners / SkillOS Cloud | Phase 3+ |
| 3VAL or other product renames | Explicitly out of this task |

## Decision

### D1 — Package and version

- Ship `@skillos/protocol` as a **versioned offchain package** (Apache-2.0 intended for open core; exact license file in 1B).
- First release: **`0.1.0`**.
- Consumption: npm package pin or vendored JSON Schema + golden fixtures — **no** `file:../SkillOS` relative imports between repos.

#### D1.1 — Supported `protocolVersion` range (normative)

- Every protocol-owned top-level document MUST include `protocolVersion` as a **semver** string (`MAJOR.MINOR.PATCH`, optional pre-release not used in v0.1 fixtures).
- **v0.1 implementation accepts only major version `0` with minor `1`:** supported range is **`0.1.x`** (e.g. `0.1.0`, `0.1.1`).
- **Unsupported-version behavior:** parsers/validators MUST fail closed with a distinct error class/code (e.g. `UNSUPPORTED_PROTOCOL_VERSION`) when:
  - major ≠ `0`, or
  - major = `0` and minor ≠ `1`, or
  - the string is not a valid semver, or
  - the field is missing.
- Future `0.2.x` / `1.x` require a new protocol release; v0.1 clients MUST NOT silently accept them.
- Within `0.1.x`, optional fields may be added in later patches; required-field removal or renames are **not** allowed without a major bump beyond this ADR’s 0.1 line.

### D2 — Core document types (normative names)

Implement in 1B as TypeScript types + **JSON Schema Draft 2020-12** (see D2.0). Conceptual shape:

#### D2.0 — Schema standard and closed objects (normative)

- **Canonical schema language for all protocol-owned documents is JSON Schema Draft 2020-12** (`$schema` must identify 2020-12). No alternate meta-schema (Draft-07, OpenAPI-only, Zod-as-source-of-truth without JSON Schema emit) is normative for interchange.
- **Every protocol-owned object schema** (including nested objects in ArenaDefinition, BenchmarkManifest, EvidenceEnvelope, MeasurementDefinition, VerifierDescriptor, VerificationResult, artifact descriptors, subject, provenance, evaluator, etc.) MUST set **`additionalProperties: false`**.
- Arrays of objects use item schemas that likewise set `additionalProperties: false`.
- Unknown keys are a **hard validation failure**, not stripped-and-accepted.

#### `ArenaDefinition`

Configurable arena without game special-casing:

| Field group | Intent |
|-------------|--------|
| `protocolVersion` | Schema major.minor.patch |
| `arenaId` / `arenaVersion` | Stable ID + version |
| `category` | e.g. `game` \| `benchmark` \| `agent_eval` (extensible string) |
| `entry` | How participants enter (open, invite, agent-only, …) — **descriptor**, not payment rail |
| `prizeSource` | none \| sponsor_pool \| external — **no** required x402 |
| `format` | single_attempt \| multi_attempt \| tournament_compat |
| `verifier` | Reference to `VerifierDescriptor` id+version (+ digest) |
| `resolution` | deterministic \| staked \| hybrid (**capability**, not full staked engine) |
| `capabilityAxes` | Named axes the arena measures (strings) |
| `dataTier` | `public` \| `restricted` \| `private` |
| `dataRights` | Human-readable / structured rights for artifacts |
| `taskBinding` | Optional link to `benchmarkId` / adapter id |

#### `BenchmarkManifest`

Pins what is being evaluated:

| Field group | Intent |
|-------------|--------|
| `protocolVersion` | |
| `benchmarkId` / `benchmarkVersion` | |
| `taskType` | Domain-neutral string (e.g. `game.2048`, `simpl3.safety.offline`) |
| `inputSchemaHash` | Digest of accepted input schema |
| `evaluator` | `{ id, version, digest }` |
| `environment` | Resource/timeout/network policy **summary digests** (not secrets) |
| `measurements` | `MeasurementDefinition[]` |
| `hardFailureRules` | Rule IDs that force reject/disqualify |
| `dataset` / suite pins | Optional digests for external suite import |

#### `MeasurementDefinition`

```text
{ id, name?, unit?, higherIsBetter?, required?, valueType: "number" | "boolean" | "string" }
```

Multi-axis is required; aggregate scalar score is **optional** derived metric, not the sole representation.

#### `MeasurementValue` (normative shared type)

```text
type MeasurementValue = number | string | boolean
```

- Used for producer-side structured measurement **values** on evidence (`measurements` map or list aligned to definitions) and for any intermediate metric bags that are not verifier-normalized.
- `valueType` on `MeasurementDefinition` constrains which arm of `MeasurementValue` is legal for that axis.
- **VerificationResult.measurements** remains `Record<string, number>` (see D2.1): verifier-normalized **scores for ranking/gates** are numeric only; boolean/string axes must be mapped by the verifier into numeric codes or omitted from `VerificationResult.measurements` and reflected only in `disqualifications` / status. This is intentional: settlement-grade multi-axis outputs are comparable numbers; free-form strings belong in evidence, not in the result score vector.

#### D2.1 — Why VerificationResult measurements are numeric-only (normative rationale)

Verifiers emit a **score vector** for leaderboards, hard gates, and future settlement. Numbers are total-ordered and digest-stable under JCS. Booleans/strings as first-class result measurements would force ambiguous ordering and locale/format instability. Therefore:

- Evidence MAY carry full `MeasurementValue`.
- `VerificationResult.measurements` MUST be `Record<string, number>` only.
- Non-numeric outcomes that fail a rule use `status: "rejected"` and `disqualifications[]` (string rule IDs), not string values inside `measurements`.

#### `EvidenceEnvelope`

Producer-submitted evidence (Simpl3 eval runner or game adapter):

| Field group | Intent |
|-------------|--------|
| `protocolVersion` | |
| `evidenceId` | UUID or ULID |
| `manifestDigest` | Digest of canonical BenchmarkManifest bytes |
| `subject` | `{ type: agent\|model\|skill\|human, id, version }` |
| `provenance` | `codeCommit?`, `configDigest`, `inputDigest`, `toolCatalogDigest?`, `modelId?` (no secrets) |
| `artifacts` | List of `{ mediaType, digest, availability: inline\|uri\|redacted, role }` |
| `metrics` | Flat map for quick display; authoritative multi-axis values also in structured measurements if present |
| `measurements` | Optional structured values aligned to manifest definitions |
| `createdAt` | ISO-8601 |
| `signature?` | Optional producer signature (not required in v0.1 tests) |

**Public fields MUST NOT contain:** raw prompts, private tool traces, hidden tests, user portfolio balances, CDP secrets, or provider API keys. Those live only in private offchain stores; public evidence may carry **digests** only.

#### `VerifierDescriptor`

```text
{
  id,
  version,
  digest,   // digest of this descriptor under projection D3.2 (excludes the digest field itself)
  capabilities: ("deterministic" | "staked" | "hybrid")[]
}
```

#### `VerificationResult`

```text
{
  protocolVersion,                 // must be in supported 0.1.x range
  evidenceId,
  manifestDigest,                  // REQUIRED — digest of BenchmarkManifest (full document)
  evidenceDigest,                  // REQUIRED — digest of EvidenceEnvelope under evidence projection
  verifierId, verifierVersion, verifierDigest,
  status: "verified" | "rejected" | "error",
  disqualifications: string[],
  measurements: Record<string, number>,  // multi-axis numeric score vector only (see D2.1)
  resultDigest,                    // digest of this result under result projection
  verifiedAt,
  signature                        // optional in v0.1 unit tests with test keys; settlement-grade later
}
```

Binding rules (enforced by recompute helpers, D3.3): `manifestDigest` / `evidenceDigest` / `verifierDigest` / `resultDigest` MUST match recomputation over the stated projections; mismatches → validation failure.

### D3 — Canonical serialization and digests (normative)

#### D3.0 — JCS (RFC 8785) + UTF-8 + digest string format

1. **Canonical serialization** for all digest inputs is **RFC 8785 JSON Canonicalization Scheme (JCS)** applied to a JSON value, producing a unique **UTF-8** byte sequence.
2. Implementations MUST NOT invent an alternate key-sort/whitespace algorithm; behavior is defined by RFC 8785.
3. **Numbers:** only finite JSON numbers that JCS can represent safely are allowed. **`NaN`, `Infinity`, `-Infinity`, and non-finite values MUST be rejected** before canonicalization. Values that cannot be represented without precision loss relative to the protocol’s numeric rules MUST be rejected (fail closed).
4. **Digest algorithm and encoding (fixed for v0.1):**
   `digest = "sha256:" + lowercase_hex( SHA-256( utf8_bytes( JCS(value) ) ) )`
   where `lowercase_hex` is exactly **64** characters `[0-9a-f]`.
5. Digest **format** validation is a separate check from content recompute (see D3.3): strings not matching `^sha256:[0-9a-f]{64}$` are rejected as `INVALID_DIGEST_FORMAT`.

#### D3.1 — Digest projections (what is hashed)

| Object | Projection for its content digest | Notes |
|--------|-----------------------------------|--------|
| **BenchmarkManifest** | **Entire document** | All fields; no omissions. |
| **EvidenceEnvelope** | Document **with `signature` removed** (omit key) | If `signature` absent, hash whole document. |
| **VerifierDescriptor** | Document **with its own `digest` field removed** | Self-digest does not include the digest field. |
| **VerificationResult** | Document **with `resultDigest` and `signature` removed** | Binding fields `manifestDigest` / `evidenceDigest` remain inside the projection. |

Artifact digests and other nested digests hash the artifact payload bytes or nested JCS object as specified by the artifact descriptor in 1B schemas; top-level rules above are fixed here.

#### D3.2 — Storing digests on objects

- `BenchmarkManifest` does not need an embedded self-digest field; consumers compute `manifestDigest = Digest(full manifest)`.
- `EvidenceEnvelope.manifestDigest` MUST equal `Digest(full manifest)`.
- `EvidenceEnvelope` content digest for binding is `evidenceDigest = Digest(evidence without signature)`.
- `VerifierDescriptor.digest` MUST equal `Digest(descriptor without digest field)`.
- `VerificationResult.manifestDigest` / `evidenceDigest` are **required** and MUST equal the corresponding digests.
- `VerificationResult.resultDigest` MUST equal `Digest(result without resultDigest and signature)`.

#### D3.3 — Separate validation APIs (1B surface; normative split)

The package MUST expose **separate** helpers (names illustrative; behavior normative):

| API | Responsibility |
|-----|----------------|
| **`parseAndValidateSchema(document, schemaId)`** | JSON parse (if needed) + **Draft 2020-12** validation including `additionalProperties: false` and `protocolVersion` range (D1.1). Does **not** recompute digests. |
| **`assertDigestFormat(digest: string)`** | Enforces `sha256:` + 64 lowercase hex only. |
| **`computeDigest(value, projection)`** | Apply projection (D3.1), JCS, SHA-256, format string. |
| **`assertDigestBinding({...})`** | Given concrete objects, recompute digests and assert equality for manifest / evidence / verifier / result bindings. Fails on mismatch (`DIGEST_MISMATCH`). |

Callers MAY run schema validation without binding checks (e.g. draft UIs). Settlement-grade and golden tests MUST run **schema + format + binding**.

#### D3.4 — Browser-safe tooling approach (normative preference)

v0.1 validation/canonicalization/hash MUST be **browser-safe** and Node-safe without native addons:

| Concern | Chosen approach |
|---------|-----------------|
| Schema | Pure JS/WASM-free or pure JS Draft 2020-12 validator usable in browser bundles (e.g. Ajv 2020 build **or** equivalent pure implementation). |
| JCS | Pure JS RFC 8785 implementation. |
| SHA-256 | `crypto.subtle.digest` in browsers; Node `crypto` / Web Crypto; no required native `sha256` addon. |

**Rejected alternatives (for v0.1 normative path):**

| Rejected | Reason |
|----------|--------|
| Node-only `fs` + CLI as sole validator | Blocks Simpl3 web/eval and browser agents |
| Custom “sort keys + minify” instead of RFC 8785 | Interop risk; not a standard |
| Multihash / non-`sha256:` digests as required | Premature; v0.1 fixes one format |
| OpenAPI-only types without JSON Schema artifacts | Interop and non-TS consumers |
| `additionalProperties` defaults true | Silent field injection / digest ambiguity |
| Soft-strip unknown properties | Hides producer bugs; weakens binding |

### D3.5 — Summary of rejections (parsers)

MUST fail closed on: unsupported `protocolVersion` (D1.1); schema violation / extra properties; invalid digest format; digest mismatch on binding; non-finite or unsafe numbers; invalid status enums.

### D4 — Onchain vs offchain placement

| Onchain-safe (summaries / digests) | Offchain / private only |
|------------------------------------|-------------------------|
| Identity / reference IDs | Prompts, chain-of-thought |
| Manifest / evidence / result digests | Raw tool traces |
| Verifier identity digests | Hidden tests / private datasets |
| Optional summary measurements | User portfolio, enterprise data |
| Settlement receipt refs (later) | Large blobs |

v0.1 **does not require** writing any of these onchain. When later phases anchor digests, they use this placement map.

### D5 — Identity (evaluation vs production)

- Simpl3 **production CDP / Server Wallet / user Base Account used for live funds** MUST NOT be the evaluation subject identity by default.
- Phase 1 pilots use a **dedicated evaluation identity** per build/config.
- ERC-8004 is optional later; not required for protocol v0.1.
- SkillOS never gains execute authority over Simpl3.

### D6 — Legacy game compatibility (adapter, not rewrite)

- Keep existing score/tournament HTTP and `TournamentPool` as-is.
- Provide an **adapter** (1B scope) that maps a game score submission + run metadata → `EvidenceEnvelope` + manifest for that game task type.
- No breaking change to public game clients required for protocol v0.1 package publish.
- Games become **fixtures** that prove domain-neutrality.

### D7 — Simpl3 Safety Arena mapping (consumer)

Simpl3 offline evaluation runner (later kit phase) produces:

- Synthetic scenario + frozen provider fixtures → digests in provenance.
- Read/propose-only tool trace → redacted artifacts (digest or redacted stub).
- Decision + metrics → `measurements` / `metrics`.
- No live execute, no real funds, no SkillOS → Simpl3 Act path.

SkillOS verifier (later) only verifies evidence against manifest; it does not call Simpl3 execution APIs.

### D8 — Implementation package layout (1B, not this ADR PR body)

Recommended (non-binding until 1B):

```text
packages/protocol/
  package.json          # name: @skillos/protocol, version 0.1.0
  src/types.ts
  src/serialize.ts      # canonical JSON + sha256
  src/validate.ts
  src/adapt/gameScore.ts
  schemas/*.json
  fixtures/game-2048/*.json
  fixtures/simpl3-safety/*.json
  test/*.test.ts
  README.md
```

Workspace registration and CI job for protocol tests are part of 1B.

### D9 — Golden fixtures (1B acceptance)

Minimum two fixtures validated by schema + digest tests:

1. **Legacy 2048-style** submission adapted to evidence (synthetic or recorded, no secrets).
2. **Synthetic Simpl3 safety evaluation** evidence (offline, redacted).

Tests must reject: wrong major version, tampered digest, missing required measurement when `required: true`.

### D10 — Verification lifecycle (API later; names frozen)

Attempt/evidence lifecycle strings used by future endpoints (not all implemented in v0.1 package):

`submitted` → `verifying` → `verified` | `rejected` | `disputed` | `settled`

Protocol package v0.1 only needs `VerificationResult.status`: `verified` | `rejected` | `error`.

## Consequences

### Positive

- Simpl3 and SkillOS share one contract without mono-repo coupling.
- Games remain fixtures; benchmarks and agent evals use the same envelope.
- Privacy and security boundaries are explicit before code lands.
- Ops soak can proceed in parallel without blocking protocol 1B.

### Negative / tradeoffs

- Existing score JSON is not identical to `EvidenceEnvelope`; adapter layer required.
- JCS + closed schemas are strict; producers must not emit undefined/extra keys or non-finite numbers.
- Multi-axis measurements need UI/API education vs single score; non-numeric axes need explicit verifier mapping into numbers or disqualifications.

### Risks if rejected or delayed

- Divergent ad-hoc JSON between Simpl3 eval and SkillOS verifiers.
- Premature onchain coupling or secret leakage into “public” evidence fields.

## Implementation gate (Phase 1B)

Codex (or product owner) marks this ADR **Accepted**. Then Grok Build may:

1. Implement `@skillos/protocol@0.1.0` per D1–D10.
2. Add schemas, validators, digests, fixtures, adapter, tests.
3. **Not** open agent-funded production spend; **not** wire Simpl3 execute tools.

Out of 1B unless separately authorized: arena HTTP endpoints, MCP tool surface expansion, onchain anchoring, staked resolution.

## Alternatives considered

| Alternative | Why rejected for v0.1 |
|-------------|------------------------|
| Extend only game score schema | Blocks Simpl3/benchmark neutrality |
| Require ERC-8004 + x402 in core types | Couples protocol to rails not ready for all domains |
| Single scalar score as canonical | Insufficient for safety multi-axis evals |
| Onchain-first evidence storage | Privacy + cost; conflicts with private traces |

## References

- `ROADMAP.md` — Phase 1 (#209), Phase 0 exit gate split (CI vs ops)
- `grok-build/context/03_INTEGRATION_CONTRACT.md` — starter TypeScript shapes
- `grok-build/prompts/03_SHARED_PROTOCOL.md` — package acceptance criteria
- `grok-build/context/04_SECURITY_BOUNDARIES.md` — non-negotiables
- PR #200 — security/CI baseline on main
- PR #203 — product roadmap on main

## Approval checklist (reviewer)

- [ ] Domain-neutral types cover game + Simpl3 eval without special-case core fields
- [ ] Privacy/onchain placement is sufficient for public evidence
- [ ] Digest/canonicalization choice is implementable and testable
- [ ] Legacy `TournamentPool` / score API unbroken by design
- [ ] SkillOS cannot gain Simpl3 execute authority via this protocol
- [ ] Ops soak correctly non-blocking for 1B package work
- [ ] Status → **Accepted** (or request revisions)
