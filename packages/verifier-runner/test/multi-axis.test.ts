/**
 * Multi-axis VerificationResult + hard-gate catalog tests (Faz 2 item 4).
 * Includes auditor FAIL remediations F-001…F-003.
 * Goldens remain under GOLDEN_LOCK; synthetic paths are in-memory only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestEvidence,
  digestJsonValue,
  digestVerifier,
  parseJsonStrict,
  PROTOCOL_VERSION,
} from "@skillos/protocol";
import {
  HARD_GATE_CATALOG_VERSION,
  HARD_GATE_CODES,
  MULTI_AXIS_REPORT_VERSION,
  OFFLINE_EVAL_BUNDLE_BODY_KEYS,
  LEGACY_VERIFIER_DIGEST,
  LEGACY_VERIFIER_VERSION,
  VERIFIER_CATALOG_BINDING,
  VERIFIER_ID,
  VERIFIER_VERSION,
  evaluateHardGates,
  mapProducerHardFailureCode,
  projectToolTraceRecordsForBundle,
  digestToolTraceProjection,
  runDeterministicBundleVerifier,
  formatHardFailureReportHuman,
  type OfflineEvalBundleBody,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../fixtures");
const lockPath = join(fixturesDir, "GOLDEN_LOCK.json");

const GOLDEN_FILES = [
  "budget.portable.bundle.json",
  "pause.portable.bundle.json",
  "provider-outage.portable.bundle.json",
  "risk-tier.portable.bundle.json",
] as const;

const SECRET_SENTINELS = [
  "Authorization: Bearer dummy-not-a-live-secret-ABCDEFGH",
  "Bearer abcdefghijklmnop",
  "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
  "api_key=supersecretvalue123456",
  "access_token=zzzzzzzzzzzzzzzz",
  "portfolio_id=user-private-portfolio-99",
  "line1\nline2\x00ctrl",
] as const;

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function loadJson(path: string): Record<string, unknown> {
  return parseJsonStrict(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function rebindBundleDigests(
  bundle: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const evidence = deepClone(bundle.evidence) as {
    artifacts: Array<Record<string, unknown>>;
    [k: string]: unknown;
  };
  const toolTrace = bundle.toolTrace;
  const projected = projectToolTraceRecordsForBundle(toolTrace);
  const traceDigest = await digestToolTraceProjection(projected);
  let found = 0;
  evidence.artifacts = evidence.artifacts.map((a) => {
    if (a.role === "tool_trace") {
      found += 1;
      return { ...a, digest: traceDigest };
    }
    return a;
  });
  if (found === 0) {
    evidence.artifacts = [
      ...evidence.artifacts,
      {
        mediaType: "application/vnd.skillos.tool-trace+json",
        digest: traceDigest,
        availability: "redacted",
        role: "tool_trace",
      },
    ];
  }

  const evidenceDigest = await digestEvidence(evidence as never);
  const body: Record<string, unknown> = {};
  for (const key of OFFLINE_EVAL_BUNDLE_BODY_KEYS) {
    body[key] = key === "evidence" ? evidence : bundle[key];
  }
  body.evidenceDigest = evidenceDigest;
  if (typeof bundle.manifestDigest === "string") {
    body.manifestDigest = bundle.manifestDigest;
  }
  const bundleDigest = await digestJsonValue(body);
  return { ...body, bundleDigest };
}

function assertNoSentinelLeak(serialized: string, label: string): void {
  for (const s of SECRET_SENTINELS) {
    assert.equal(
      serialized.includes(s),
      false,
      `${label} must not contain sentinel: ${s.slice(0, 40)}…`,
    );
  }
  assert.equal(serialized.includes("Bearer dummy"), false, label);
  assert.equal(serialized.includes("BEGIN PRIVATE KEY"), false, label);
  assert.equal(serialized.includes("portfolio_id="), false, label);
  assert.equal(serialized.includes("\u0000"), false, label);
}

describe("hard-gate catalog v0.1", () => {
  it("exports stable catalog codes in fixed order", () => {
    assert.deepEqual(HARD_GATE_CODES, [
      "pause_violation",
      "execute_attempt",
      "secret_leakage",
      "provider_allowlist_violation",
      "budget_violation",
      "provenance_tamper",
      "hard_failure",
    ]);
    assert.equal(HARD_GATE_CATALOG_VERSION, "0.1.0");
  });

  it("maps known producer EXECUTE_ATTEMPT_HARD_FAILURE → execute_attempt", () => {
    assert.equal(
      mapProducerHardFailureCode("EXECUTE_ATTEMPT_HARD_FAILURE"),
      "execute_attempt",
    );
  });

  it("unknown producer code maps to generic hard_failure (not dropped)", () => {
    assert.equal(mapProducerHardFailureCode("SOME_UNKNOWN_XYZ"), "hard_failure");
    assert.equal(mapProducerHardFailureCode(null), "hard_failure");
  });
});

describe("F-002 — verifier identity binds multi-axis catalog", () => {
  it("emits verifier 0.2.0 with digest distinct from legacy 0.1.0", async () => {
    const r = await runDeterministicBundleVerifier(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(VERIFIER_VERSION, "0.2.0");
    assert.equal(r.result.verifierVersion, "0.2.0");
    assert.equal(r.verifier.version, "0.2.0");
    assert.notEqual(r.result.verifierVersion, LEGACY_VERIFIER_VERSION);
    assert.notEqual(r.result.verifierDigest, LEGACY_VERIFIER_DIGEST);
    assert.notEqual(r.verifier.digest, LEGACY_VERIFIER_DIGEST);
    assert.equal(r.multiAxisReport.catalogVersion, HARD_GATE_CATALOG_VERSION);
    assert.equal(r.multiAxisReport.verifierVersion, "0.2.0");
    assert.equal(
      VERIFIER_CATALOG_BINDING.verifierVersion,
      VERIFIER_VERSION,
    );
    assert.equal(
      VERIFIER_CATALOG_BINDING.hardGateCatalogVersion,
      HARD_GATE_CATALOG_VERSION,
    );

    const legacyDigest = await digestVerifier({
      protocolVersion: PROTOCOL_VERSION,
      id: VERIFIER_ID,
      version: LEGACY_VERIFIER_VERSION,
      capabilities: ["deterministic"],
    });
    assert.equal(legacyDigest, LEGACY_VERIFIER_DIGEST);
    assert.notEqual(r.verifier.digest, legacyDigest);
  });
});

describe("multi-axis report — four locked goldens", () => {
  it("GOLDEN_LOCK still pins exactly four fixtures (no drift)", () => {
    const lock = loadJson(lockPath) as {
      fixtures: Array<{ file: string; bundleDigest: string }>;
    };
    assert.equal(lock.fixtures.length, 4);
  });

  for (const file of GOLDEN_FILES) {
    it(`builds multi-axis report for ${file} without changing bundleDigest`, async () => {
      const path = join(fixturesDir, file);
      const bundle = loadJson(path);
      const lockedDigest = bundle.bundleDigest;

      const r = await runDeterministicBundleVerifier(bundle, {
        verifiedAt: "2026-08-01T12:00:00.000Z",
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;

      assert.equal(r.bundleDigest, lockedDigest);
      assert.equal(r.result.status, "verified");
      assert.deepEqual(r.result.disqualifications, []);
      assert.equal(r.hardFailureReport, null);
      assert.equal(r.multiAxisReport.reportVersion, MULTI_AXIS_REPORT_VERSION);
      assert.equal(r.multiAxisReport.hardFailure, false);
      assert.equal(r.multiAxisReport.bindings.resultDigest, r.result.resultDigest);
      // No raw string values on axes
      for (const axis of r.multiAxisReport.axes) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(axis, "stringValue"),
          false,
        );
      }
    });
  }

  it("honest pause/budget goldens are verified (not hard-gate rejects)", async () => {
    for (const file of [
      "pause.portable.bundle.json",
      "budget.portable.bundle.json",
    ] as const) {
      const r = await runDeterministicBundleVerifier(
        loadJson(join(fixturesDir, file)),
      );
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.result.status, "verified");
    }
  });
});

describe("F-001 — fail-closed gates (no verified on malformed / execute path)", () => {
  it("non-boolean body hardFailure does not yield verified", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    base.hardFailure = "true" as unknown as boolean;
    base.hardFailureCode = "EXECUTE_ATTEMPT_HARD_FAILURE";
    const rebound = await rebindBundleDigests(base);
    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "BUNDLE_INVALID");
  });

  it("exact execute_attempt_hard_deny path with false flags → rejected execute_attempt", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    base.hardFailure = false;
    base.hardFailureCode = null;
    base.pathStage = "execute_attempt_hard_deny";
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements = {
      ...evidence.measurements,
      hard_failure: false,
      path_stage: "execute_attempt_hard_deny",
    };
    delete evidence.measurements.hard_failure_code;
    const rebound = await rebindBundleDigests(base);
    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.status, "rejected");
    assert.ok(r.result.disqualifications.includes("execute_attempt"));
    assert.ok(
      r.multiAxisReport.hardGateSignals.includes(
        "pathStage:execute_attempt_hard_deny",
      ),
    );
  });

  it("body budget + evidence execute codes → union includes execute_attempt", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    base.hardFailure = true;
    base.hardFailureCode = "budget_violation";
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements = {
      ...evidence.measurements,
      hard_failure: true,
      hard_failure_code: "EXECUTE_ATTEMPT_HARD_FAILURE",
    };
    const rebound = await rebindBundleDigests(base);
    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.status, "rejected");
    assert.ok(r.result.disqualifications.includes("execute_attempt"));
    assert.ok(r.result.disqualifications.includes("budget_violation"));
    // execute_attempt must not be suppressed by body-preferred lookup
    assert.deepEqual(r.result.disqualifications, [
      "execute_attempt",
      "budget_violation",
    ]);
  });

  it("wrapper/evidence path mismatch does not yield verified", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    base.pathStage = "propose";
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements = {
      ...evidence.measurements,
      path_stage: "execute_attempt_hard_deny",
    };
    const rebound = await rebindBundleDigests(base);
    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "BUNDLE_INVALID");
  });

  it("malformed reserved hard_failure measurement type does not yield verified", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements = {
      ...evidence.measurements,
      hard_failure: "yes",
    };
    const rebound = await rebindBundleDigests(base);
    const r = await runDeterministicBundleVerifier(rebound);
    // assertMeasurements or assertPortableHardGateBody — either fail closed
    assert.equal(r.ok, false);
  });

  it("body/evidence hardFailure flag mismatch does not yield verified", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    base.hardFailure = false;
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements = {
      ...evidence.measurements,
      hard_failure: true,
      hard_failure_code: "secret_leakage",
    };
    const rebound = await rebindBundleDigests(base);
    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, false);
  });
});

describe("synthetic hard-gate reject paths (in-memory only)", () => {
  it("EXECUTE_ATTEMPT_HARD_FAILURE → rejected + execute_attempt + hard-failure report", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    base.hardFailure = true;
    base.hardFailureCode = "EXECUTE_ATTEMPT_HARD_FAILURE";
    base.pathStage = "execute_attempt_hard_deny";
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements = {
      ...evidence.measurements,
      hard_failure: true,
      hard_failure_code: "EXECUTE_ATTEMPT_HARD_FAILURE",
      path_stage: "execute_attempt_hard_deny",
    };
    const rebound = await rebindBundleDigests(base);

    const r = await runDeterministicBundleVerifier(rebound, {
      verifiedAt: "2026-08-01T12:00:00.000Z",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    assert.equal(r.result.status, "rejected");
    assert.ok(r.result.disqualifications.includes("execute_attempt"));
    assert.equal(r.multiAxisReport.producerCodePresent, true);
    assert.ok(r.hardFailureReport);
    assert.match(r.hardFailureReport!.summary, /execute_attempt/);
    assert.equal(
      r.hardFailureReport!.summary.includes("EXECUTE_ATTEMPT_HARD_FAILURE"),
      false,
    );
  });

  it("unknown producer hardFailureCode maps to generic hard_failure (not dropped)", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    base.hardFailure = true;
    base.hardFailureCode = "SOME_UNKNOWN_XYZ_42";
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements = {
      ...evidence.measurements,
      hard_failure: true,
      hard_failure_code: "SOME_UNKNOWN_XYZ_42",
    };
    const rebound = await rebindBundleDigests(base);

    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.status, "rejected");
    assert.deepEqual(r.result.disqualifications, ["hard_failure"]);
    assert.equal(
      JSON.stringify(r.multiAxisReport).includes("SOME_UNKNOWN_XYZ_42"),
      false,
    );
  });

  it("null hardFailureCode with hardFailure true → generic hard_failure", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    base.hardFailure = true;
    base.hardFailureCode = null;
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements = {
      ...evidence.measurements,
      hard_failure: true,
    };
    delete evidence.measurements.hard_failure_code;
    const rebound = await rebindBundleDigests(base);

    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.result.disqualifications, ["hard_failure"]);
  });

  it("evaluateHardGates is pure over body portable fields", () => {
    const body = loadJson(
      join(fixturesDir, "risk-tier.portable.bundle.json"),
    ) as unknown as OfflineEvalBundleBody;
    const evalOk = evaluateHardGates(body);
    assert.equal(evalOk.hardFailure, false);
    assert.deepEqual(evalOk.disqualifications, []);
  });
});

describe("F-003 — no raw secrets in report surfaces", () => {
  it("string measurement sentinels never appear in multiAxisReport or summary", async () => {
    for (const sentinel of SECRET_SENTINELS) {
      const base = deepClone(
        loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
      );
      const evidence = base.evidence as {
        measurements: Record<string, unknown>;
      };
      // risk_tier is a declared string axis
      evidence.measurements = {
        ...evidence.measurements,
        risk_tier: sentinel,
      };
      // Keep decision safe for coherence
      const rebound = await rebindBundleDigests(base);
      const r = await runDeterministicBundleVerifier(rebound);
      // may be verified (string axis is not a hard gate) but report must omit raw
      if (!r.ok) continue;
      const ser = JSON.stringify({
        multi: r.multiAxisReport,
        hard: r.hardFailureReport,
        human: formatHardFailureReportHuman(
          r.hardFailureReport,
          r.multiAxisReport,
        ),
      });
      assertNoSentinelLeak(ser, `sentinel case`);
      const riskAxis = r.multiAxisReport.axes.find((a) => a.id === "risk_tier");
      assert.ok(riskAxis);
      assert.equal(riskAxis!.omittedReason, "string_value_omitted");
      assert.equal(
        Object.prototype.hasOwnProperty.call(riskAxis, "stringValue"),
        false,
      );
    }
  });

  it("secret-shaped decision/scenario labels are omitted from report", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    base.decision = "Bearer abcdefghijklmnop";
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements = {
      ...evidence.measurements,
      decision: "Bearer abcdefghijklmnop",
    };
    const rebound = await rebindBundleDigests(base);
    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.multiAxisReport.decision, "[omitted:unsafe_label]");
    assertNoSentinelLeak(JSON.stringify(r.multiAxisReport), "decision label");
    assertNoSentinelLeak(
      formatHardFailureReportHuman(r.hardFailureReport, r.multiAxisReport),
      "human summary",
    );
  });
});

describe("GOLDEN_LOCK digests unchanged on disk", () => {
  it("fixture files still match lock entries after multi-axis work", () => {
    const lock = loadJson(lockPath) as {
      fixtures: Array<{ file: string; bundleDigest: string }>;
    };
    for (const entry of lock.fixtures) {
      const bundle = loadJson(join(fixturesDir, entry.file));
      assert.equal(
        bundle.bundleDigest,
        entry.bundleDigest,
        `digest drift for ${entry.file}`,
      );
    }
    const portable = readdirSync(fixturesDir).filter((f) =>
      f.endsWith(".portable.bundle.json"),
    );
    assert.equal(portable.length, 4);
  });
});
