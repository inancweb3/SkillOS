# `@skillos/private-runner-isolation`

SkillOS **private-runner isolation contract foundations** (Faz 3 / ADR 0006).

## What this is

- Versioned isolation contract: trust tiers, action classes, registry records, admission decisions.
- **Fail-closed** admission for absent, stale, unavailable registry, trust mismatch, isolation-mode mismatch, and forbidden actions.
- **Read-only admission port** — consumers call the gate with `registry.asAdmissionPort()`, not the mutable registry.
- Gate re-checks: denies `control_plane` records and `maxStalenessMs` above the 24h ceiling against *any* genuine port.
- In-memory registry stub for CI and local use — **not** a cloud provisioner.
- **Open publishable SkillOS package** (Apache-2.0; same posture as `@skillos/protocol`).

## What this is not

- No live host/cloud runner provisioning.
- No Simpl3 execution, wallet, CDP, or funded x402 authority.
- No config promotion authorization (Control Plane / later ADR 0008).
- `request_execute` and `issue_promotion_authorization` are **always denied** for private runners.
- `control_plane` tier is a reserved unreachable ceiling — no action class requires it at v0.1.0.

## Report / admit seam

```ts
import {
  InMemoryRunnerRegistry,
  evaluateRunnerAdmission,
} from "@skillos/private-runner-isolation";

const now = Date.now();
// Freshness is bound to the registry trusted clock (caller nowMs is ignored).
const registry = new InMemoryRunnerRegistry({ clock: () => now });
registry.register({
  runnerId: "runner-1",
  trustTier: "standard",
  isolationMode: "fixture",
  lastHeartbeatAtMs: now,
  maxStalenessMs: 60_000,
});

// P2-01: pass a genuine read-only port from asAdmissionPort() — never a hand-built forge.
const decision = evaluateRunnerAdmission(registry.asAdmissionPort(), {
  runnerId: "runner-1",
  actionClass: "verify_digest",
});
// decision.admit === true
// decision.registryEpoch >= 1
```

## Invariants (ADR 0006)

1. **Registry is source of truth** — runner self-claims are ignored for admission.
2. **Absent / stale fail closed** — no best-effort admit.
3. **Lower trust cannot cause higher-authority action** — matrix deny by construction; gate takes a read-only port only.
4. **Per-action isolation modes** — e.g. `mutate_private_workspace` requires `process` mode.
5. **Registry owns the trusted clock** — `AdmissionInput.nowMs` is non-authoritative.

## Tests

```bash
npm test --workspace=@skillos/private-runner-isolation
npm run typecheck --workspace=@skillos/private-runner-isolation
```
