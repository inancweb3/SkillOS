# `@skillos/protocol` v0.1.0

Domain-neutral, **offchain-first** Arena / Evidence protocol for SkillOS and Simpl3.

- **License:** Apache-2.0
- **Spec:** ADR 0005 (Accepted — 2026-08-01, Codex architecture review)
- **Runtime:** browser + Node ≥ 20 (Web Crypto + pure JS I-JSON/JCS; no native addons)
- **Deps:** `ajv` + `ajv-formats` only — **no** other `@skillos/*` packages
- **Types:** generated from `schemas/*.schema.json` via `npm run generate-types` (CI drift gate)

## Install

```bash
npm install @skillos/protocol@0.1.0
```

Consumers may also vendor `schemas/*.json` and golden `fixtures/**` without importing SkillOS server code.

## Core models

| Type | Role |
|------|------|
| `ArenaDefinition` | Arena configuration |
| `BenchmarkManifest` | What is being evaluated |
| `MeasurementDefinition` | Multi-axis metric definition |
| `EvidenceEnvelope` | Producer evidence |
| `VerifierDescriptor` | Verifier identity + self-digest (`protocolVersion` required) |
| `VerificationResult` | Verifier output + bindings |

`protocolVersion` is **exactly** `"0.1.0"` on every top-level document including `VerifierDescriptor`.

## APIs (separate surfaces)

| API | Responsibility |
|-----|----------------|
| `parseAndValidateSchema(doc, schemaId)` | Strict JSON parse (dup keys fail) + I-JSON walk + Draft 2020-12; no digest recompute |
| `assertDigestFormat(digest)` | `sha256:` + 64 lowercase hex |
| `computeDigest(value, projection)` | Projection → JCS → SHA-256 |
| `assertDigestBinding({…})` | Recompute digests **and** cross-object field matches |
| `assertMeasurements(manifest, evidence)` | Unique ids, `Object.hasOwn` presence, valueType, unknown keys |

### Binding matches

- evidence ↔ manifest: `manifestDigest`
- result ↔ evidence: `evidenceId`, `evidenceDigest`, `manifestDigest`
- result ↔ verifier: `id`/`version`/`digest`

Projections: `manifest` (full), `evidence` (omit `signature`), `verifier` (omit `digest`), `result` (omit `resultDigest` + `signature`).

## JCS / I-JSON fail-closed

Rejects: `undefined`, non-plain objects, cycles, duplicate JSON keys (on parse), lone UTF-16 surrogates, `NaN` / ±Infinity / **`-0`**.

Protocol **documents** additionally require `Number.isSafeInteger` for integer values (stricter than bare RFC JCS doubles such as `1e30`).

## Legacy adapter

`adaptGameScoreToEvidence` maps a game score submission to `EvidenceEnvelope` without changing public score APIs or `TournamentPool`.

- Invalid / unsafe `score` and `matchCountDelta` fail closed.
- Provenance digests are **real** (caller-supplied or deterministic JCS digests of input/config).
- Seeds are never written to `codeCommit`.

## Fixtures

- `fixtures/game-2048/` — legacy 2048-style (real digests)
- `fixtures/simpl3-safety/` — synthetic, redacted offline eval (real digests)

Regenerate: `npm run build-fixtures -w @skillos/protocol`

## Scripts

```bash
npm run generate-types -w @skillos/protocol
npm run check-types-drift -w @skillos/protocol
npm run typecheck -w @skillos/protocol
npm test -w @skillos/protocol          # unit + browser-bundle smoke
npm run build -w @skillos/protocol     # emits dist/ (gitignored)
npm pack --dry-run -w @skillos/protocol  # includes dist/
```

## Docs

- [Privacy / onchain placement](./docs/PRIVACY_ONCHAIN.md)
- [Semver](./docs/SEMVER.md)

## Non-goals (v0.1)

No API endpoints, MCP tools, contracts, database, onchain anchoring, staked verifier runtime, or agent-funded execution.
