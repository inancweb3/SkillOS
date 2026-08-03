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
```

## CLI

```bash
# from package directory
npm run verify-bundle -- --in fixtures/risk-tier.portable.bundle.json

# or
npx tsx src/cli.ts --in path/to/bundle.json --out result.json
cat bundle.json | npx tsx src/cli.ts --stdin
```

Exit codes: `0` success, `1` usage/load error, `2` verification failure.

## Fail-closed verification order

1. Allowlist body projection (`BUNDLE_UNKNOWN_FIELD` / `BUNDLE_MISSING_FIELD`)
2. Nested protocol integrity — schema, `assertDigestBinding` (measurements off), body digest claims
3. Version / producer coherence
4. Portable `inputDigest` claim equality (no private preimage recompute)
5. `scenario.fixedNow` ↔ `evidence.createdAt`
6. toolTrace allowlist, redaction equality, exactly-one `tool_trace` artifact, digest match
7. Outer `bundleDigest` recompute

## Privacy

- Fixtures are **synthetic** only (no live user/portfolio/production data).
- Bundle-only path cannot recompute `inputDigest` from private scenario preimage.
- Redaction check is SkillOS-owned defense-in-depth (not a Simpl3 import).

## Tests

```bash
npm test
npm run typecheck
```

Golden fixture: `fixtures/risk-tier.portable.bundle.json` (synthetic offline scenario export).

## Out of scope (this package)

- Base Sepolia anchoring
- Multi-axis leaderboard UI
- Simpl3 monorepo edits / EXECUTE / CDP / wallets
- npm registry publish
