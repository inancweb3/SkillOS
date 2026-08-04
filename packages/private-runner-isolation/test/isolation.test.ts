/**
 * ADR 0006 compliance tests — private-runner isolation foundations.
 * Includes security regressions for auditor F-001…F-005 and ClaudeSec P2/P3.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_ALLOWED_MODES,
  ACTION_MIN_TRUST,
  ADMITTABLE_ISOLATION_MODES,
  ISOLATION_CONTRACT_VERSION,
  InMemoryRunnerRegistry,
  IsolationRegistryError,
  MAX_STALENESS_CEILING_MS,
  TRUST_TIER_RANK,
  evaluateRunnerAdmission,
  isAdmissionRegistryPort,
  type ActionClass,
  type AdmissionRegistryPort,
  type RunnerIsolationRecord,
} from "../src/index.js";

const NOW = 1_700_000_000_000;
const FRESH_MS = 60_000;

function registryAt(nowMs: number): InMemoryRunnerRegistry {
  return new InMemoryRunnerRegistry({ clock: () => nowMs });
}

function portOf(registry: InMemoryRunnerRegistry): AdmissionRegistryPort {
  return registry.asAdmissionPort();
}

function registerStd(
  registry: InMemoryRunnerRegistry,
  opts?: Partial<{
    runnerId: string;
    trustTier: "ephemeral" | "standard" | "trusted";
    isolationMode: "process" | "fixture" | "hosted_stub";
    lastHeartbeatAtMs: number;
    maxStalenessMs: number;
  }>,
): RunnerIsolationRecord {
  return registry.register({
    runnerId: opts?.runnerId ?? "runner-std",
    trustTier: opts?.trustTier ?? "standard",
    isolationMode: opts?.isolationMode ?? "hosted_stub",
    lastHeartbeatAtMs: opts?.lastHeartbeatAtMs ?? NOW,
    maxStalenessMs: opts?.maxStalenessMs ?? FRESH_MS,
  });
}

describe("isolation contract pins", () => {
  it("exports contract version 0.1.0", () => {
    assert.equal(ISOLATION_CONTRACT_VERSION, "0.1.0");
  });

  it("trust tiers are totally ordered", () => {
    assert.ok(TRUST_TIER_RANK.ephemeral < TRUST_TIER_RANK.standard);
    assert.ok(TRUST_TIER_RANK.standard < TRUST_TIER_RANK.trusted);
    assert.ok(TRUST_TIER_RANK.trusted < TRUST_TIER_RANK.control_plane);
  });

  it("execute and promotion authorization are never grantable", () => {
    assert.equal(ACTION_MIN_TRUST.request_execute, null);
    assert.equal(ACTION_MIN_TRUST.issue_promotion_authorization, null);
    assert.equal(ACTION_ALLOWED_MODES.request_execute.length, 0);
    assert.equal(ACTION_ALLOWED_MODES.issue_promotion_authorization.length, 0);
  });

  it("exports max staleness ceiling (24h)", () => {
    assert.equal(MAX_STALENESS_CEILING_MS, 86_400_000);
  });
});

describe("InMemoryRunnerRegistry", () => {
  let registry: InMemoryRunnerRegistry;

  beforeEach(() => {
    registry = registryAt(NOW);
  });

  it("registers a private runner and looks it up", () => {
    const rec = registerStd(registry, { runnerId: "r1" });
    assert.equal(rec.runnerId, "r1");
    assert.equal(rec.trustTier, "standard");
    assert.ok(rec.registryEpoch >= 1);
    assert.deepEqual(registry.get("r1"), rec);
  });

  it("refuses control_plane trust for private runners", () => {
    assert.throws(
      () =>
        registry.register({
          runnerId: "cp",
          trustTier: "control_plane",
          isolationMode: "process",
          lastHeartbeatAtMs: NOW,
          maxStalenessMs: FRESH_MS,
        }),
      (err: unknown) => {
        assert.ok(err instanceof IsolationRegistryError);
        assert.equal(err.code, "CONTROL_PLANE_RESERVED");
        return true;
      },
    );
  });

  it("heartbeat cannot change trust tier", () => {
    registry.register({
      runnerId: "r1",
      trustTier: "ephemeral",
      isolationMode: "process",
      lastHeartbeatAtMs: NOW,
      maxStalenessMs: FRESH_MS,
    });
    registry.setClock(() => NOW + 1000);
    const next = registry.heartbeat("r1", NOW + 1000);
    assert.equal(next.trustTier, "ephemeral");
    assert.equal(next.lastHeartbeatAtMs, NOW + 1000);
  });
});

describe("evaluateRunnerAdmission — happy path", () => {
  it("admits fresh standard runner for verify_digest", () => {
    const registry = registryAt(NOW + 1_000);
    registerStd(registry, {
      runnerId: "runner-ok",
      lastHeartbeatAtMs: NOW,
    });
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "runner-ok",
      actionClass: "verify_digest",
      nowMs: NOW + 1_000,
    });
    assert.equal(d.admit, true);
    assert.equal(d.denyCode, null);
    assert.equal(d.contractVersion, ISOLATION_CONTRACT_VERSION);
    assert.equal(d.registryTrustTier, "standard");
    assert.equal(d.selfClaimIgnored, false);
    assert.equal(d.callerClockIgnored, true);
    assert.ok(d.registryEpoch !== null && d.registryEpoch >= 1);
  });
});

describe("evaluateRunnerAdmission — fail closed", () => {
  let registry: InMemoryRunnerRegistry;

  beforeEach(() => {
    registry = registryAt(NOW);
    registerStd(registry);
  });

  it("RUNNER_ABSENT when id missing", () => {
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "no-such-runner",
      actionClass: "verify_digest",
      nowMs: NOW,
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "RUNNER_ABSENT");
    assert.equal(d.registryEpoch, null);
  });

  it("RUNNER_STALE when heartbeat exceeds max staleness", () => {
    registry.setClock(() => NOW + FRESH_MS + 1);
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "runner-std",
      actionClass: "verify_digest",
      nowMs: NOW + FRESH_MS + 1,
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "RUNNER_STALE");
    assert.equal(d.registryTrustTier, "standard");
    assert.ok(d.registryEpoch !== null && d.registryEpoch >= 1);
  });

  it("REGISTRY_UNAVAILABLE fails closed", () => {
    registry.setAvailable(false);
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "runner-std",
      actionClass: "verify_digest",
      nowMs: NOW,
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "REGISTRY_UNAVAILABLE");
  });

  it("TRUST_TIER_INSUFFICIENT for lower-trust higher action", () => {
    // mutate requires process mode + trusted; standard/hosted_stub fails trust
    // after mode check — use process so mode is allowed and trust is the deny.
    registerStd(registry, {
      runnerId: "runner-std-proc",
      trustTier: "standard",
      isolationMode: "process",
    });
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "runner-std-proc",
      actionClass: "mutate_private_workspace",
      nowMs: NOW,
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "TRUST_TIER_INSUFFICIENT");
  });

  it("request_execute always ACTION_CLASS_FORBIDDEN", () => {
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "runner-std",
      actionClass: "request_execute",
      nowMs: NOW,
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "ACTION_CLASS_FORBIDDEN");
  });

  it("issue_promotion_authorization always ACTION_CLASS_FORBIDDEN", () => {
    registerStd(registry, {
      runnerId: "runner-trusted",
      trustTier: "trusted",
      isolationMode: "process",
    });
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "runner-trusted",
      actionClass: "issue_promotion_authorization",
      nowMs: NOW,
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "ACTION_CLASS_FORBIDDEN");
  });

  it("self-claimed elevated trust is ignored (no escalation)", () => {
    registerStd(registry, {
      runnerId: "runner-std-proc2",
      trustTier: "standard",
      isolationMode: "process",
    });
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "runner-std-proc2",
      actionClass: "mutate_private_workspace",
      nowMs: NOW,
      selfClaim: {
        claimedTrustTier: "trusted",
        claimedHealthy: true,
      },
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "TRUST_TIER_INSUFFICIENT");
    assert.equal(d.selfClaimIgnored, true);
    assert.equal(d.registryTrustTier, "standard");
  });

  it("self-claim does not grant execute either", () => {
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "runner-std",
      actionClass: "request_execute",
      nowMs: NOW,
      selfClaim: {
        claimedTrustTier: "control_plane",
        claimedHealthy: true,
      },
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "ACTION_CLASS_FORBIDDEN");
    assert.equal(d.selfClaimIgnored, true);
  });
});

describe("action matrix coverage", () => {
  it("ephemeral may observe_health but not verify_digest", () => {
    const registry = registryAt(NOW);
    registerStd(registry, {
      runnerId: "eph",
      trustTier: "ephemeral",
      isolationMode: "fixture",
    });
    const ok = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "eph",
      actionClass: "observe_health",
      nowMs: NOW,
    });
    assert.equal(ok.admit, true);
    const no = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "eph",
      actionClass: "verify_digest",
      nowMs: NOW,
    });
    assert.equal(no.admit, false);
    assert.equal(no.denyCode, "TRUST_TIER_INSUFFICIENT");
  });

  it("trusted may mutate_private_workspace only in process mode", () => {
    const registry = registryAt(NOW);
    registerStd(registry, {
      runnerId: "tr",
      trustTier: "trusted",
      isolationMode: "process",
    });
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "tr",
      actionClass: "mutate_private_workspace" satisfies ActionClass,
      nowMs: NOW,
    });
    assert.equal(d.admit, true);
  });
});

describe("F-001 — public matrix mutation cannot reopen EXECUTE", () => {
  it("assignment / Object.assign on ACTION_MIN_TRUST leave execute denied", () => {
    const registry = registryAt(NOW);
    registerStd(registry, { runnerId: "r-exec", trustTier: "trusted" });

    // Hostile mutation attempts on the public inspection export.
    const table = ACTION_MIN_TRUST as Record<string, unknown>;
    try {
      table.request_execute = "ephemeral";
    } catch {
      // strict mode / freeze may throw — both are acceptable
    }
    try {
      Object.assign(table, { request_execute: "trusted" });
    } catch {
      // ignore
    }
    try {
      table.issue_promotion_authorization = "control_plane";
    } catch {
      // ignore
    }

    // Gate must never consult the public table for enforcement.
    const exec = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "r-exec",
      actionClass: "request_execute",
      nowMs: NOW,
    });
    assert.equal(exec.admit, false);
    assert.equal(exec.denyCode, "ACTION_CLASS_FORBIDDEN");

    const promo = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "r-exec",
      actionClass: "issue_promotion_authorization",
      nowMs: NOW,
    });
    assert.equal(promo.admit, false);
    assert.equal(promo.denyCode, "ACTION_CLASS_FORBIDDEN");

    // Inspection export itself remains null under freeze (or was ignored).
    assert.equal(ACTION_MIN_TRUST.request_execute, null);
    assert.equal(ACTION_MIN_TRUST.issue_promotion_authorization, null);
  });

  it("ADMITTABLE_ISOLATION_MODES is not a mutable Set surface", () => {
    assert.ok(Array.isArray(ADMITTABLE_ISOLATION_MODES));
    assert.ok(Object.isFrozen(ADMITTABLE_ISOLATION_MODES));
    const modes = ADMITTABLE_ISOLATION_MODES as unknown as {
      add?: (v: string) => unknown;
      push?: (v: string) => number;
    };
    // No Set.add; array push must not extend under freeze.
    assert.equal(typeof modes.add, "undefined");
    const before = ADMITTABLE_ISOLATION_MODES.length;
    try {
      modes.push?.("hostile_mode");
    } catch {
      // freeze throws in strict
    }
    assert.equal(ADMITTABLE_ISOLATION_MODES.length, before);
    assert.ok(!ADMITTABLE_ISOLATION_MODES.includes("hostile_mode" as never));
  });
});

describe("F-002 — registry freeze + runtime trust validation", () => {
  it("mutating returned register/get/heartbeat snapshots does not elevate stored trust", () => {
    const registry = registryAt(NOW);
    const reg = registerStd(registry, {
      runnerId: "mut",
      trustTier: "ephemeral",
      isolationMode: "process",
    });
    const got = registry.get("mut");
    assert.ok(got);
    const beat = registry.heartbeat("mut", NOW);
    const lookup = registry.lookupForAdmission("mut");
    assert.equal(lookup.ok, true);

    for (const snap of [reg, got, beat, lookup.ok ? lookup.record : reg]) {
      const hostile = snap as { trustTier: string };
      try {
        hostile.trustTier = "trusted";
      } catch {
        // freeze may throw
      }
      assert.equal(snap.trustTier, "ephemeral");
    }

    // Stored record still ephemeral — mutate_private_workspace denied.
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "mut",
      actionClass: "mutate_private_workspace",
      nowMs: NOW,
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "TRUST_TIER_INSUFFICIENT");
    assert.equal(d.registryTrustTier, "ephemeral");
  });

  it("rejects bogus / undefined / object trustTier at register", () => {
    const registry = registryAt(NOW);
    for (const bad of ["bogus", undefined, null, 3, {}, ["trusted"]]) {
      assert.throws(
        () =>
          registry.register({
            runnerId: "bad-tier",
            // @ts-expect-error intentional invalid runtime input
            trustTier: bad,
            isolationMode: "fixture",
            lastHeartbeatAtMs: NOW,
            maxStalenessMs: FRESH_MS,
          }),
        (err: unknown) => {
          assert.ok(err instanceof IsolationRegistryError);
          assert.equal(err.code, "INVALID_INPUT");
          return true;
        },
      );
    }
  });

  it("rejects bogus isolationMode at register", () => {
    const registry = registryAt(NOW);
    assert.throws(
      () =>
        registry.register({
          runnerId: "bad-mode",
          trustTier: "standard",
          // @ts-expect-error intentional invalid runtime input
          isolationMode: "container_escape",
          lastHeartbeatAtMs: NOW,
          maxStalenessMs: FRESH_MS,
        }),
      (err: unknown) => {
        assert.ok(err instanceof IsolationRegistryError);
        assert.equal(err.code, "INVALID_INPUT");
        return true;
      },
    );
  });
});

describe("F-003 — trusted clock owns freshness; caller nowMs ignored", () => {
  it("stale runner stays denied even when caller supplies earlier nowMs", () => {
    // Heartbeat at NOW; trusted clock advances past max staleness.
    const registry = registryAt(NOW);
    registerStd(registry, {
      runnerId: "stale-r",
      lastHeartbeatAtMs: NOW,
      maxStalenessMs: FRESH_MS,
    });
    registry.setClock(() => NOW + FRESH_MS + 5_000);

    // Caller tries to rewind time to make heartbeat look fresh.
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "stale-r",
      actionClass: "verify_digest",
      nowMs: NOW,
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "RUNNER_STALE");
    assert.equal(d.callerClockIgnored, true);
  });

  it("future heartbeat at register is rejected", () => {
    const registry = registryAt(NOW);
    assert.throws(
      () =>
        registry.register({
          runnerId: "future",
          trustTier: "standard",
          isolationMode: "fixture",
          lastHeartbeatAtMs: NOW + 10_000,
          maxStalenessMs: FRESH_MS,
        }),
      (err: unknown) => {
        assert.ok(err instanceof IsolationRegistryError);
        assert.equal(err.code, "INVALID_INPUT");
        return true;
      },
    );
  });

  it("future and backwards heartbeats fail closed", () => {
    const registry = registryAt(NOW);
    registerStd(registry, { runnerId: "hb", lastHeartbeatAtMs: NOW });
    assert.throws(
      () => registry.heartbeat("hb", NOW + 1),
      (err: unknown) => {
        assert.ok(err instanceof IsolationRegistryError);
        assert.equal(err.code, "INVALID_INPUT");
        return true;
      },
    );
    // Advance clock, then try going backwards relative to stored heartbeat.
    registry.setClock(() => NOW + 10_000);
    assert.throws(
      () => registry.heartbeat("hb", NOW - 1),
      (err: unknown) => {
        assert.ok(err instanceof IsolationRegistryError);
        assert.equal(err.code, "INVALID_INPUT");
        return true;
      },
    );
  });

  it("non-safe-integer clock fails closed at admission", () => {
    const registry = new InMemoryRunnerRegistry({
      clock: () => Number.NaN,
    });
    // Cannot register with NaN clock either — use a temp clock to register.
    const okReg = registryAt(NOW);
    registerStd(okReg, { runnerId: "c1" });
    // Swap in bad clock on a registry that already has a record via re-create path:
    // inject bad clock after register on same instance.
    const registry2 = registryAt(NOW);
    registerStd(registry2, { runnerId: "c2" });
    registry2.setClock(() => Number.POSITIVE_INFINITY);
    const d = evaluateRunnerAdmission(portOf(registry2), {
      runnerId: "c2",
      actionClass: "verify_digest",
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "CLOCK_UNTRUSTED");
  });

  it("fresh runner admits when trusted clock is current (no caller nowMs)", () => {
    const registry = registryAt(NOW);
    registerStd(registry, { runnerId: "fresh", trustTier: "standard" });
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "fresh",
      actionClass: "verify_digest",
    });
    assert.equal(d.admit, true);
    assert.equal(d.callerClockIgnored, false);
  });
});

describe("P2-01 — genuine read-only admission port (WeakSet identity)", () => {
  it("asAdmissionPort is genuine and structurally excludes mutators", () => {
    const registry = registryAt(NOW);
    const port = registry.asAdmissionPort();
    assert.equal(isAdmissionRegistryPort(port), true);
    assert.equal(typeof port.nowMs, "function");
    assert.equal(typeof port.lookupForAdmission, "function");

    const keys = Object.keys(port).sort();
    assert.deepEqual(keys, ["lookupForAdmission", "nowMs"]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(port, "register"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(port, "setClock"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(port, "setAvailable"),
      false,
    );
    // Runtime: mutators must not be invocable via the port object.
    assert.equal(
      typeof (port as unknown as { register?: unknown }).register,
      "undefined",
    );
    assert.equal(
      typeof (port as unknown as { setClock?: unknown }).setClock,
      "undefined",
    );
    assert.equal(
      typeof (port as unknown as { setAvailable?: unknown }).setAvailable,
      "undefined",
    );
  });

  it("gate rejects unminted full mutable registry handle", () => {
    const registry = registryAt(NOW);
    registerStd(registry, { runnerId: "r-port" });
    // Pass the mutable registry as if it were a port (hostile / mistaken consumer).
    const d = evaluateRunnerAdmission(
      registry as unknown as AdmissionRegistryPort,
      {
        runnerId: "r-port",
        actionClass: "verify_digest",
        nowMs: NOW,
      },
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.match(d.reason, /genuine read-only AdmissionRegistryPort/);
  });

  it("forged object with Symbol.for brand + attacker methods is INVALID_INPUT", () => {
    const registry = registryAt(NOW);
    registerStd(registry, {
      runnerId: "victim",
      trustTier: "ephemeral",
      isolationMode: "process",
      lastHeartbeatAtMs: NOW,
      maxStalenessMs: FRESH_MS,
    });

    // Reconstruct the old forgeable global symbol identity (no longer authority).
    const forgedGlobal = Symbol.for(
      "skillos.private-runner-isolation.AdmissionRegistryPort",
    );
    const forged = Object.freeze({
      [forgedGlobal]: true,
      nowMs: () => NOW,
      // Attacker elevates trust via fake lookup.
      lookupForAdmission: (runnerId: string) => ({
        ok: true as const,
        record: Object.freeze({
          runnerId,
          trustTier: "trusted" as const,
          isolationMode: "process" as const,
          lastHeartbeatAtMs: NOW,
          maxStalenessMs: FRESH_MS,
          registryEpoch: 1,
        }),
      }),
    });

    assert.equal(isAdmissionRegistryPort(forged), false);
    const d = evaluateRunnerAdmission(
      forged as unknown as AdmissionRegistryPort,
      {
        runnerId: "victim",
        actionClass: "mutate_private_workspace",
      },
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.match(d.reason, /genuine read-only/);

    // Genuine mint still admits only what the real registry records (ephemeral).
    const genuine = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "victim",
      actionClass: "mutate_private_workspace",
    });
    assert.equal(genuine.admit, false);
    assert.equal(genuine.denyCode, "TRUST_TIER_INSUFFICIENT");
    assert.equal(genuine.registryTrustTier, "ephemeral");
  });

  it("forged shape-compatible port without WeakSet membership is INVALID_INPUT", () => {
    const registry = registryAt(NOW);
    registerStd(registry, {
      runnerId: "r-shape",
      trustTier: "standard",
      isolationMode: "fixture",
    });
    const forged = {
      nowMs: () => NOW,
      lookupForAdmission: registry.lookupForAdmission.bind(registry),
    };
    assert.equal(isAdmissionRegistryPort(forged), false);
    const d = evaluateRunnerAdmission(
      forged as unknown as AdmissionRegistryPort,
      {
        runnerId: "r-shape",
        actionClass: "verify_digest",
      },
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
  });

  it("genuine mint still admits a fresh standard runner", () => {
    const registry = registryAt(NOW);
    registerStd(registry, {
      runnerId: "ok",
      trustTier: "standard",
      isolationMode: "fixture",
    });
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "ok",
      actionClass: "verify_digest",
    });
    assert.equal(d.admit, true);
    assert.equal(isAdmissionRegistryPort(portOf(registry)), true);
  });

  it("P2-01R: package root and deep-import expose no mint/mark/add authority-adder", async () => {
    const pkg = await import("../src/index.js");
    const adderNames = [
      "mintAdmissionPort",
      "markGenuineAdmissionPort",
      "registerAdmissionPort",
      "addGenuineAdmissionPort",
      "createAdmissionPort",
    ] as const;
    for (const name of adderNames) {
      assert.equal(
        typeof (pkg as Record<string, unknown>)[name],
        "undefined",
        `package root must not export ${name}`,
      );
    }
    // Read-only predicate remains available.
    assert.equal(typeof pkg.isAdmissionRegistryPort, "function");
    assert.equal(typeof pkg.InMemoryRunnerRegistry, "function");

    // Deep-import of deleted admission-port module must fail (no exported mint path).
    // Dynamic path string so tsc does not require the module to exist (P2-01R).
    const removedMintPath = "../src/" + "admission-port.js";
    await assert.rejects(
      () => import(removedMintPath),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        // Node ERR_MODULE_NOT_FOUND or similar
        return true;
      },
    );

    // Deep-import registry: only predicate + class; no mint helper on the module namespace.
    const regMod = await import("../src/registry.js");
    for (const name of adderNames) {
      assert.equal(
        typeof (regMod as Record<string, unknown>)[name],
        "undefined",
        `registry module must not export ${name}`,
      );
    }
    assert.equal(typeof regMod.isGenuineAdmissionPort, "function");
    // Predicate is not an adder — cannot elevate via deep-import of isGenuine.
    const forged = Object.freeze({
      nowMs: () => NOW,
      lookupForAdmission: () => ({
        ok: true as const,
        record: Object.freeze({
          runnerId: "x",
          trustTier: "trusted" as const,
          isolationMode: "process" as const,
          lastHeartbeatAtMs: NOW,
          maxStalenessMs: FRESH_MS,
          registryEpoch: 1,
        }),
      }),
    });
    assert.equal(regMod.isGenuineAdmissionPort(forged), false);
    const d = evaluateRunnerAdmission(
      forged as unknown as AdmissionRegistryPort,
      { runnerId: "x", actionClass: "mutate_private_workspace" },
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
  });

  it("port holder cannot elevate trust, revive stale, or clear unavailable", () => {
    const registry = registryAt(NOW);
    registerStd(registry, {
      runnerId: "eph",
      trustTier: "ephemeral",
      isolationMode: "process",
      lastHeartbeatAtMs: NOW,
      maxStalenessMs: FRESH_MS,
    });
    const port = portOf(registry);

    // Attempt elevation / revive / clear via port — methods do not exist.
    const hostile = port as unknown as {
      register?: (x: unknown) => unknown;
      setClock?: (c: () => number) => void;
      setAvailable?: (v: boolean) => void;
    };
    assert.equal(typeof hostile.register, "undefined");
    assert.equal(typeof hostile.setClock, "undefined");
    assert.equal(typeof hostile.setAvailable, "undefined");

    // Trust still insufficient for mutate.
    const before = evaluateRunnerAdmission(port, {
      runnerId: "eph",
      actionClass: "mutate_private_workspace",
    });
    assert.equal(before.admit, false);
    assert.equal(before.denyCode, "TRUST_TIER_INSUFFICIENT");

    // Stale on registry; port cannot rewind clock.
    registry.setClock(() => NOW + FRESH_MS + 1);
    const stale = evaluateRunnerAdmission(port, {
      runnerId: "eph",
      actionClass: "observe_health",
    });
    assert.equal(stale.admit, false);
    assert.equal(stale.denyCode, "RUNNER_STALE");

    // Unavailable; port cannot re-enable.
    registry.setAvailable(false);
    const unavail = evaluateRunnerAdmission(port, {
      runnerId: "eph",
      actionClass: "observe_health",
    });
    assert.equal(unavail.admit, false);
    assert.equal(unavail.denyCode, "REGISTRY_UNAVAILABLE");
  });
});

describe("P2-02 — per-action ISOLATION_VIOLATION is real and covered", () => {
  it("trusted + fixture denied mutate_private_workspace with ISOLATION_VIOLATION", () => {
    const registry = registryAt(NOW);
    registerStd(registry, {
      runnerId: "tr-fix",
      trustTier: "trusted",
      isolationMode: "fixture",
    });
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "tr-fix",
      actionClass: "mutate_private_workspace",
      nowMs: NOW,
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "ISOLATION_VIOLATION");
    assert.equal(d.registryTrustTier, "trusted");
    assert.match(d.reason, /fixture.*mutate_private_workspace/);
  });

  it("trusted + hosted_stub denied mutate_private_workspace with ISOLATION_VIOLATION", () => {
    const registry = registryAt(NOW);
    registerStd(registry, {
      runnerId: "tr-stub",
      trustTier: "trusted",
      isolationMode: "hosted_stub",
    });
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "tr-stub",
      actionClass: "mutate_private_workspace",
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "ISOLATION_VIOLATION");
  });

  it("public ACTION_ALLOWED_MODES mutation does not reopen mutate for fixture", () => {
    const registry = registryAt(NOW);
    registerStd(registry, {
      runnerId: "tr-mut",
      trustTier: "trusted",
      isolationMode: "fixture",
    });
    const table = ACTION_ALLOWED_MODES as Record<string, unknown>;
    try {
      table.mutate_private_workspace = ["fixture", "process", "hosted_stub"];
    } catch {
      // freeze may throw
    }
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "tr-mut",
      actionClass: "mutate_private_workspace",
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "ISOLATION_VIOLATION");
  });
});

describe("P3-01 — maxStalenessMs ceiling", () => {
  it("register rejects maxStalenessMs above ceiling", () => {
    const registry = registryAt(NOW);
    assert.throws(
      () =>
        registry.register({
          runnerId: "too-long",
          trustTier: "standard",
          isolationMode: "fixture",
          lastHeartbeatAtMs: NOW,
          maxStalenessMs: MAX_STALENESS_CEILING_MS + 1,
        }),
      (err: unknown) => {
        assert.ok(err instanceof IsolationRegistryError);
        assert.equal(err.code, "INVALID_INPUT");
        assert.match(err.message, /ceiling/);
        return true;
      },
    );
    assert.throws(
      () =>
        registry.register({
          runnerId: "max-safe",
          trustTier: "standard",
          isolationMode: "fixture",
          lastHeartbeatAtMs: NOW,
          maxStalenessMs: Number.MAX_SAFE_INTEGER,
        }),
      (err: unknown) => {
        assert.ok(err instanceof IsolationRegistryError);
        assert.equal(err.code, "INVALID_INPUT");
        return true;
      },
    );
  });

  it("record at ceiling still goes stale past it", () => {
    const registry = registryAt(NOW);
    registry.register({
      runnerId: "ceil",
      trustTier: "standard",
      isolationMode: "fixture",
      lastHeartbeatAtMs: NOW,
      maxStalenessMs: MAX_STALENESS_CEILING_MS,
    });
    // Fresh at t=NOW.
    assert.equal(
      evaluateRunnerAdmission(portOf(registry), {
        runnerId: "ceil",
        actionClass: "verify_digest",
      }).admit,
      true,
    );
    // Past ceiling → stale.
    registry.setClock(() => NOW + MAX_STALENESS_CEILING_MS + 1);
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "ceil",
      actionClass: "verify_digest",
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "RUNNER_STALE");
  });
});

/**
 * P2-01S — asAdmissionPort must not bind overridable public methods.
 * Subclass overrides of lookupForAdmission / nowMs must not redefine the
 * authoritative callbacks on a WeakSet-genuine port.
 */
class HostileLookupRegistry extends InMemoryRunnerRegistry {
  private hostile: RunnerIsolationRecord | null = null;
  private clockOverride: number | null = null;

  setHostileRecord(record: RunnerIsolationRecord): void {
    this.hostile = record;
  }

  setClockOverride(ms: number): void {
    this.clockOverride = ms;
  }

  override lookupForAdmission(runnerId: string) {
    if (this.hostile && this.hostile.runnerId === runnerId) {
      return { ok: true as const, record: this.hostile };
    }
    return super.lookupForAdmission(runnerId);
  }

  override nowMs(): number {
    if (this.clockOverride !== null) return this.clockOverride;
    return super.nowMs();
  }
}

describe("P2-01S — port binds non-virtual #private lookup+clock (subclass cannot elevate)", () => {
  it("subclass override returning trusted/process for unregistered id never admits", () => {
    const registry = new HostileLookupRegistry({ clock: () => NOW });
    // Public override would authorize mutate if the port used it — must not.
    registry.setHostileRecord({
      runnerId: "ghost-elevated",
      trustTier: "trusted",
      isolationMode: "process",
      lastHeartbeatAtMs: NOW,
      maxStalenessMs: FRESH_MS,
      registryEpoch: 99,
    });
    // Public API sees the hostile override.
    const publicLookup = registry.lookupForAdmission("ghost-elevated");
    assert.equal(publicLookup.ok, true);

    const port = registry.asAdmissionPort();
    assert.equal(isAdmissionRegistryPort(port), true);
    // Port must use base #private state → runner absent → never admit.
    const d = evaluateRunnerAdmission(port, {
      runnerId: "ghost-elevated",
      actionClass: "mutate_private_workspace",
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "RUNNER_ABSENT");
    assert.equal(d.registryTrustTier, null);
  });

  it("subclass hostile control_plane/over-ceiling snapshots never reach the gate via port", () => {
    const registry = new HostileLookupRegistry({ clock: () => NOW });
    registry.setHostileRecord({
      runnerId: "cp-hostile",
      trustTier: "control_plane",
      isolationMode: "process",
      lastHeartbeatAtMs: NOW,
      maxStalenessMs: MAX_STALENESS_CEILING_MS + 1,
      registryEpoch: 1,
    });
    const port = registry.asAdmissionPort();
    const d = evaluateRunnerAdmission(port, {
      runnerId: "cp-hostile",
      actionClass: "verify_digest",
    });
    // Base state has no such runner — not INVALID_INPUT from hostile payload.
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "RUNNER_ABSENT");
  });

  it("subclass nowMs override cannot rejuvenate a stale runner through the port", () => {
    const registry = new HostileLookupRegistry({ clock: () => NOW });
    registry.register({
      runnerId: "stale-r",
      trustTier: "standard",
      isolationMode: "fixture",
      lastHeartbeatAtMs: NOW - FRESH_MS - 1,
      maxStalenessMs: FRESH_MS,
    });
    // Public override claims "now" is still the heartbeat time (would un-stale).
    registry.setClockOverride(NOW - FRESH_MS - 1);
    assert.equal(registry.nowMs(), NOW - FRESH_MS - 1);

    const port = registry.asAdmissionPort();
    // Port clock is #private base clock (NOW) → still stale.
    const d = evaluateRunnerAdmission(port, {
      runnerId: "stale-r",
      actionClass: "verify_digest",
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "RUNNER_STALE");
  });

  it("genuine port still admits a fresh standard runner after subclass exists", () => {
    const registry = new HostileLookupRegistry({ clock: () => NOW });
    registry.register({
      runnerId: "ok",
      trustTier: "standard",
      isolationMode: "fixture",
      lastHeartbeatAtMs: NOW,
      maxStalenessMs: FRESH_MS,
    });
    // Hostile override for a different id must not affect registered runner.
    registry.setHostileRecord({
      runnerId: "other",
      trustTier: "trusted",
      isolationMode: "process",
      lastHeartbeatAtMs: NOW,
      maxStalenessMs: FRESH_MS,
      registryEpoch: 1,
    });
    const d = evaluateRunnerAdmission(registry.asAdmissionPort(), {
      runnerId: "ok",
      actionClass: "verify_digest",
    });
    assert.equal(d.admit, true);
    assert.equal(d.denyCode, null);
  });
});

describe("A1/A2 — held closed (register + authority surface)", () => {
  it("register still refuses control_plane and over-ceiling maxStaleness", () => {
    const registry = registryAt(NOW);
    assert.throws(
      () =>
        registry.register({
          runnerId: "cp",
          trustTier: "control_plane",
          isolationMode: "process",
          lastHeartbeatAtMs: NOW,
          maxStalenessMs: FRESH_MS,
        }),
      (err: unknown) => {
        assert.ok(err instanceof IsolationRegistryError);
        assert.equal(err.code, "CONTROL_PLANE_RESERVED");
        return true;
      },
    );
    assert.throws(
      () =>
        registry.register({
          runnerId: "ceil",
          trustTier: "standard",
          isolationMode: "fixture",
          lastHeartbeatAtMs: NOW,
          maxStalenessMs: MAX_STALENESS_CEILING_MS + 1,
        }),
      (err: unknown) => {
        assert.ok(err instanceof IsolationRegistryError);
        assert.equal(err.code, "INVALID_INPUT");
        return true;
      },
    );
  });

  it("no action class requires control_plane at v0.1.0 (A2 authority surface)", () => {
    for (const action of Object.keys(ACTION_MIN_TRUST) as ActionClass[]) {
      assert.notEqual(
        ACTION_MIN_TRUST[action],
        "control_plane",
        `${action} must not require control_plane`,
      );
    }
  });
});

describe("P3 — package LICENSE is full Apache-2.0 with SkillOS attribution", () => {
  it("LICENSE contains Sections 1-9, END OF TERMS, and SkillOS copyright only", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const licensePath = resolve(here, "../LICENSE");
    const text = readFileSync(licensePath, "utf8");
    assert.match(text, /Apache License/);
    assert.match(text, /1\.\s+Definitions\./);
    assert.match(text, /2\.\s+Grant of Copyright License\./);
    assert.match(text, /3\.\s+Grant of Patent License\./);
    assert.match(text, /4\.\s+Redistribution\./);
    assert.match(text, /5\.\s+Submission of Contributions\./);
    assert.match(text, /6\.\s+Trademarks\./);
    assert.match(text, /7\.\s+Disclaimer of Warranty\./);
    assert.match(text, /8\.\s+Limitation of Liability\./);
    assert.match(text, /9\.\s+Accepting Warranty or Additional Liability\./);
    assert.match(text, /END OF TERMS AND CONDITIONS/);
    assert.match(text, /Copyright 2026 SkillOS contributors/);
    assert.equal(text.includes("Simpl3"), false);
    // Not the short boilerplate-only form (must include full grant text).
    assert.ok(text.length > 8_000, "LICENSE must be full Apache-2.0 text");
  });
});

describe("P3-02 — registryEpoch bound into decisions", () => {
  it("admitted decision records positive registryEpoch from the record", () => {
    const registry = registryAt(NOW);
    const rec = registerStd(registry, { runnerId: "ep" });
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "ep",
      actionClass: "verify_digest",
    });
    assert.equal(d.admit, true);
    assert.equal(d.registryEpoch, rec.registryEpoch);
    assert.ok(d.registryEpoch !== null && d.registryEpoch >= 1);
  });

  it("absent runner decision has null registryEpoch", () => {
    const registry = registryAt(NOW);
    const d = evaluateRunnerAdmission(portOf(registry), {
      runnerId: "none",
      actionClass: "verify_digest",
    });
    assert.equal(d.admit, false);
    assert.equal(d.registryEpoch, null);
  });
});

describe("F-004 — CI test path is an argument to tsx, not a bare command", () => {
  it("workflow lists isolation test after continued advisory-benchmark path", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const ciPath = resolve(here, "../../../.github/workflows/ci.yml");
    const text = readFileSync(ciPath, "utf8");
    // Extract the test-ts run block's path list region.
    const marker = "packages/verifier-runner/test/advisory-benchmark.test.ts";
    const idx = text.indexOf(marker);
    assert.ok(idx >= 0, "advisory-benchmark path present");
    const lineEnd = text.indexOf("\n", idx);
    const line = text.slice(text.lastIndexOf("\n", idx) + 1, lineEnd);
    // P3-03: correct pattern is backslash then optional whitespace at EOL.
    assert.match(line, /\\\s*$/, "advisory-benchmark line must end with \\");
    assert.ok(line.trimEnd().endsWith("\\"), "missing line continuation before isolation test");

    const nextLine = text.slice(lineEnd + 1, text.indexOf("\n", lineEnd + 1));
    assert.match(
      nextLine,
      /packages\/private-runner-isolation\/test\/isolation\.test\.ts/,
    );
    // Next line must NOT be a bare executable path alone without being under the same list.
    // It should not start at column 0 as a shell command — in YAML it is indented under run: |
    assert.ok(/^\s+packages\//.test(nextLine), "isolation path must remain indented list arg");
  });
});
