# `@skillos/verifier-runner`

SkillOS-side **portable offline-eval bundle consumer** + **deterministic verifier runner** (v0.1).

Consumes Simpl3 (or any conforming producer) portable offline-eval bundles **without** importing Simpl3 private code or monorepo paths. SkillOS gains **no** execution authority — digests, redacted tool traces, and protocol bindings only.

## Pins

| Item | Value |
|------|--------|
| `bundleVersion` | `0.1.0` |
| `protocolVersion` | `0.1.0` (`@skillos/protocol`) |
| Canonical producer id | `simpl3.offline.eval-runner` |
| Verifier id | `skillos.offline.bundle-verifier` |
| Verifier version | `0.2.0` (multi-axis hard-gate catalog; legacy `0.1.0` identity must not be claimed) |
| Hard-gate catalog | `0.1.0` (immutable binding from verifier `0.2.0`) |

## API

```ts
import {
  verifyPortableOfflineEvalBundle,
  runDeterministicBundleVerifier,
  loadBundleFile,
} from "@skillos/verifier-runner";

const bundle = loadBundleFile("./risk-tier.portable.bundle.json");
const verified = await verifyPortableOfflineEvalBundle(bundle);
if (!verified.ok) throw new Error(verified.reason);

const run = await runDeterministicBundleVerifier(bundle, {
  verifiedAt: "2026-08-01T12:00:00.000Z", // optional; default = evidence.createdAt
});
// run.result is a protocol-valid VerificationResult
// run.multiAxisReport is the SkillOS multi-axis + hard-gate surface
// run.hardFailureReport is non-null only when a hard gate rejects
```

## Multi-axis report + hard-gate catalog (v0.1)

SkillOS-owned consumer policy (no Simpl3 import, no protocol schema fork):

| Surface | Role |
|---------|------|
| `VerificationResult` | Protocol object — numeric `measurements` only; `status` / `disqualifications` |
| `MultiAxisReport` | Axis inventory (manifest measurements + catalog gates) bound to the same digests |
| `HardFailureReport` | Present when hard gate fires (`status=rejected`) |

### Hard-gate catalog codes

Stable disqualification codes (`HARD_GATE_CODES`):

- `pause_violation`
- `execute_attempt`
- `secret_leakage`
- `provider_allowlist_violation`
- `budget_violation`
- `provenance_tamper`
- `hard_failure` (generic / unknown producer code fallback — never dropped)

Known producer codes map into the catalog (e.g. Simpl3 `EXECUTE_ATTEMPT_HARD_FAILURE` → `execute_attempt`). Unknown producer codes map to `hard_failure`.

Hard gates fire from **portable allowlisted fields only**:

- body `hardFailure` / `hardFailureCode` and evidence `hard_failure` / `hard_failure_code` (types + wrapper/evidence coherence fail closed — malformed never yields `verified`)
- **union** of mapped catalog codes when body and evidence codes differ (never suppress `execute_attempt`)
- exact canonical path `execute_attempt_hard_deny` (body `pathStage` and/or evidence `path_stage`) → `execute_attempt`

Honest pause/budget scenarios without hardFailure / execute path remain `verified`.

Provenance integrity failures still fail closed at verify/load (**exit 2**, no result). Catalog `provenance_tamper` surfaces only when a producer declares that code on an accepted bundle body.

### Report privacy

- Protocol `VerificationResult.measurements` stays **numeric-only**.
- Multi-axis report **does not** copy raw producer string measurements, raw `hardFailureCode`, or secret/control-character labels.
- Scenario/decision labels are sanitized; unsafe values become `[omitted:unsafe_label]`.
- `hardGateSignals` and human summaries use fixed allowlisted tokens + catalog codes only.

### Non-authority

- No EXECUTE path, no wallet/CDP, no Simpl3 monorepo import.
- Digests + redacted tool traces only; no private preimage recompute.
- Advisory CI benchmark leaderboard is a **separate** roadmap item (next).

## CLI

```bash
# from package directory
npm run verify-bundle -- --in fixtures/risk-tier.portable.bundle.json

# multi-axis / hard-failure human summary on stderr
npm run verify-bundle -- --in fixtures/risk-tier.portable.bundle.json --report

# sidecar multi-axis JSON (mode 0600)
npm run verify-bundle -- --in path/to/bundle.json --out result.json --report-out report.json

# or
npx tsx src/cli.ts --in path/to/bundle.json --out result.json
cat bundle.json | npx tsx src/cli.ts --stdin
```

Exit codes:

| Code | Meaning |
|------|---------|
| `0` | Runner success — emits a protocol-valid `VerificationResult` (**including** `status=rejected` when a hard gate fires) |
| `1` | Usage / load error |
| `2` | Verification / schema / binding / **output** failure — **no final** `--out` or `--report-out` file from this run |

File outputs are **transactional**: destinations validated first (reject symlinks, directories, path collisions), exclusive same-directory temps at mode `0600`, fsync, then atomic rename. Pre-existing files are replaced at mode `0600` (not left at prior permissions). Stdout is emitted only after successful file commit when files are requested.

## Fail-closed verification order

1. Allowlist body projection (`BUNDLE_UNKNOWN_FIELD` / `BUNDLE_MISSING_FIELD`)
2. Nested protocol integrity — schema, `assertDigestBinding` (`checkMeasurements: true`), body digest claims
3. Version / producer coherence
4. Portable `inputDigest` claim equality (no private preimage recompute)
5. `scenario.fixedNow` ↔ `evidence.createdAt`
6. toolTrace allowlist, redaction equality, exactly-one `tool_trace` artifact, digest match
7. Outer `bundleDigest` recompute

## Cross-repo golden contract (ADR 0006)

Portable body projection + redaction independence is intentional. SkillOS does **not**
import Simpl3 exporter code. Compatibility is locked by:

| Artifact | Purpose |
|----------|---------|
| `fixtures/*.portable.bundle.json` | Honest synthetic goldens |
| `fixtures/GOLDEN_LOCK.json` | `file → bundleDigest` fail-closed lock |
| `test/golden-contract.test.ts` | Body keys, versions, producer id, toolTrace allowlist, golden verify + tamper |
| kit ADR 0006 | Ownership, `0.1.0` freeze, drift procedure |

See **`fixtures/README.md`** for provenance and Simpl3 re-export refresh steps.

## Privacy

- Fixtures are **synthetic** only (no live user/portfolio/production data).
- Bundle-only path cannot recompute `inputDigest` from private scenario preimage.
- Redaction check is SkillOS-owned defense-in-depth (not a Simpl3 import).

## Tests

```bash
npm test
npm run typecheck
```

Locked goldens (also in `GOLDEN_LOCK.json`):

- `fixtures/risk-tier.portable.bundle.json`
- `fixtures/pause.portable.bundle.json`
- `fixtures/provider-outage.portable.bundle.json`
- `fixtures/budget.portable.bundle.json`

## Out of scope (this package)

- Base Sepolia anchoring
- Multi-axis leaderboard UI
- Simpl3 monorepo edits / EXECUTE / CDP / wallets
- npm registry publish
