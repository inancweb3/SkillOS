# Portable offline-eval golden fixtures

Cross-repo **golden contract** surface for `@skillos/verifier-runner` (ADR 0006).

## Privacy

**Synthetic offline evaluation only.** No live user portfolios, production provider
responses, credentials, or customer data. Bundles contain redacted tool traces and
digest claims only.

## Files

| File | Role |
|------|------|
| `GOLDEN_LOCK.json` | Machine-readable lock: fixture → `bundleDigest` (+ scenario metadata) |
| `*.portable.bundle.json` | Locked portable bundles (`bundleVersion` / `protocolVersion` `0.1.0`) |

Current locked goldens (honest producer exports from Simpl3 offline scenarios):

- `risk-tier.portable.bundle.json`
- `pause.portable.bundle.json`
- `provider-outage.portable.bundle.json`
- `budget.portable.bundle.json`

## Provenance

Human-readable summary. Machine pins live in `GOLDEN_LOCK.json` and are enforced by
exact equality in `test/golden-contract.test.ts` (no prose/substring checks).

| Lock field | Machine value | Meaning |
|------------|---------------|---------|
| `source.producerRepo` | `youngstar-eth/simpl3-monorepo` | Reviewed producer repository id |
| `source.producerMainRef` | `f6b57ec515e9f169b863c12639d68583f95f3258` | Producer tip at export (coherence pin) |
| `source.consumerPackage` | `@skillos/verifier-runner` | This consumer package |
| `source.privacy` | `synthetic-only` | Synthetic offline eval only; no live user/portfolio/production data |
| `producerCodeCommitNote` | `coherence-only` | `codeCommit` is internal document coherence, not external trust |
| `producerId` | `simpl3.offline.eval-runner` | Simpl3 offline eval exporter |

`producer.codeCommit` / `provenance.codeCommit` match `source.producerMainRef` for
pack-wide coherence. They are **not** signer authenticity or external trust anchors.

Normative contract: kit ADR 0006
(`grok-build/docs/adr/0006-offline-eval-bundle-consumer-compatibility-v0.1.md`).

## Digest lock discipline

1. Every golden in `fixtures/*.portable.bundle.json` **must** appear in `GOLDEN_LOCK.json`.
2. Contract tests fail if:
   - a lock entry’s file is missing,
   - `verifyPortableOfflineEvalBundle` fails,
   - recomputed / claimed `bundleDigest` ≠ lock entry,
   - lock is missing an on-disk golden (drift).
3. **Do not** edit digests by hand without re-exporting the bundle.

## Refresh procedure (when Simpl3 re-exports)

Same `bundleVersion` `0.1.0` only if body projection + redaction semantics are unchanged
(ADR 0006 D3/D4). Breaking changes require a new `bundleVersion`.

1. On a trusted machine, export synthetic scenarios with the Simpl3 offline exporter
   (`eval:export` / `exportCli`) using a known code-commit pin.
2. Copy JSON into `packages/verifier-runner/fixtures/<name>.portable.bundle.json`.
3. Recompute lock entries: for each file, record `bundleDigest` and `scenarioId` from the JSON.
4. Update `GOLDEN_LOCK.json` `source.producerMainRef` if the producer tip advanced.
5. Run `npm test` in this package (must include contract/golden tests).
6. Note the dual-repo obligation: if digests change under the same version, investigate
   producer drift before merging; do not silently redefine `0.1.0`.

## Gap / TODO (non-theater)

`execute-attempt` offline scenario exists in the producer scenario pack but is **not**
locked here until an honest portable export is confirmed green under the consumer.
Do not invent invalid goldens for coverage theater.
