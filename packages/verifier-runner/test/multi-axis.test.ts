/**
 * Multi-axis VerificationResult + hard-gate catalog tests (Faz 2 item 4).
 * Includes auditor FAIL remediations F-001…F-005.
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
  digestManifest,
  digestVerifier,
  parseJsonStrict,
  PROTOCOL_VERSION,
} from "@skillos/protocol";
import * as publicIndex from "../src/index.js";
import {
  BundleConsumerError,
  HARD_GATE_CATALOG_VERSION,
  HARD_GATE_CODES,
  LEGACY_MULTI_AXIS_REPORT_VERSION,
  MULTI_AXIS_REPORT_VERSION,
  OFFLINE_EVAL_BUNDLE_BODY_KEYS,
  LEGACY_VERIFIER_DIGEST,
  LEGACY_VERIFIER_VERSION,
  PRE_SANITIZE_VERIFIER_VERSION,
  UNSAFE_OMITTED,
  VERIFIER_CATALOG_BINDING,
  VERIFIER_ID,
  VERIFIER_VERSION,
  evaluateHardGates,
  mapProducerHardFailureCode,
  projectToolTraceRecordsForBundle,
  digestToolTraceProjection,
  runDeterministicBundleVerifier,
  type AxisReportEntry,
  type MultiAxisReport,
  type OfflineEvalBundleBody,
} from "../src/index.js";
// Internal-only report builders (not on public index — F-004 / F-005).
// Keep R-1 inventory + F-003 boundary + privacy human-summary tests green.
import {
  buildAxisInventory,
  buildHardFailureReport,
  formatHardFailureReportHuman,
} from "../src/multiAxis.js";

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
  it("emits verifier 0.3.0 with digest distinct from legacy 0.1.0 and pre-sanitize 0.2.0", async () => {
    const r = await runDeterministicBundleVerifier(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(VERIFIER_VERSION, "0.3.0");
    assert.equal(r.result.verifierVersion, "0.3.0");
    assert.equal(r.verifier.version, "0.3.0");
    assert.notEqual(r.result.verifierVersion, LEGACY_VERIFIER_VERSION);
    assert.notEqual(r.result.verifierVersion, PRE_SANITIZE_VERIFIER_VERSION);
    assert.notEqual(r.result.verifierDigest, LEGACY_VERIFIER_DIGEST);
    assert.notEqual(r.verifier.digest, LEGACY_VERIFIER_DIGEST);
    assert.equal(r.multiAxisReport.catalogVersion, HARD_GATE_CATALOG_VERSION);
    assert.equal(r.multiAxisReport.verifierVersion, "0.3.0");
    assert.equal(r.multiAxisReport.reportVersion, MULTI_AXIS_REPORT_VERSION);
    assert.equal(MULTI_AXIS_REPORT_VERSION, "0.2.0");
    assert.notEqual(MULTI_AXIS_REPORT_VERSION, LEGACY_MULTI_AXIS_REPORT_VERSION);
    assert.equal(
      VERIFIER_CATALOG_BINDING.verifierVersion,
      VERIFIER_VERSION,
    );
    assert.equal(
      VERIFIER_CATALOG_BINDING.hardGateCatalogVersion,
      HARD_GATE_CATALOG_VERSION,
    );
    assert.equal(
      VERIFIER_CATALOG_BINDING.multiAxisReportVersion,
      MULTI_AXIS_REPORT_VERSION,
    );

    const legacyDigest = await digestVerifier({
      protocolVersion: PROTOCOL_VERSION,
      id: VERIFIER_ID,
      version: LEGACY_VERIFIER_VERSION,
      capabilities: ["deterministic"],
    });
    assert.equal(legacyDigest, LEGACY_VERIFIER_DIGEST);
    assert.notEqual(r.verifier.digest, legacyDigest);

    const preSanitizeDigest = await digestVerifier({
      protocolVersion: PROTOCOL_VERSION,
      id: VERIFIER_ID,
      version: PRE_SANITIZE_VERIFIER_VERSION,
      capabilities: ["deterministic"],
    });
    assert.notEqual(r.verifier.digest, preSanitizeDigest);
    assert.notEqual(r.result.verifierDigest, preSanitizeDigest);
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

/**
 * R-1 — consumer-side measurement id sanitize on multi-axis / hard-failure
 * report surfaces only (do not tighten measurement-definition.schema.json).
 */
describe("R-1 — measurement id sanitize on report surface", () => {
  const OVERLONG = `${"a".repeat(129)}`;

  function inventoryForDefs(
    defs: Array<{ id: unknown; valueType: "number" | "boolean" | "string" }>,
    bag: Record<string, unknown> = {},
  ) {
    return buildAxisInventory(
      { measurements: defs as never } as never,
      { measurements: bag } as never,
      false,
      [],
    );
  }

  it("safe measurement ids pass through unchanged on AxisReportEntry.id", () => {
    const axes = inventoryForDefs(
      [
        { id: "step_count", valueType: "number" },
        { id: "risk_tier", valueType: "string" },
        { id: "hard_failure", valueType: "boolean" },
      ],
      { step_count: 3, risk_tier: "low", hard_failure: false },
    );
    const ids = axes.map((a) => a.id);
    assert.ok(ids.includes("step_count"));
    assert.ok(ids.includes("risk_tier"));
    assert.ok(ids.includes("hard_failure"));
    for (const code of HARD_GATE_CODES) {
      assert.ok(ids.includes(`gate:${code}`), `expected gate:${code}`);
    }
  });

  it("credential-shaped / control-char / overlong / empty / non-string ids → omission token", () => {
    const cases: Array<{ id: unknown; label: string }> = [
      { id: "Bearer abcdefghijklmnop", label: "credential-shaped" },
      { id: "api_key=supersecretvalue123456", label: "api_key shape" },
      { id: "line1\nline2\x00ctrl", label: "control-char" },
      { id: OVERLONG, label: "overlong" },
      { id: "", label: "empty" },
      { id: 42, label: "non-string number" },
      { id: null, label: "non-string null" },
      { id: { nested: true }, label: "non-string object" },
      { id: "portfolio_id=user-private-portfolio-99", label: "portfolio sentinel" },
    ];

    for (const c of cases) {
      const axes = inventoryForDefs(
        [{ id: c.id, valueType: "number" }],
        typeof c.id === "string" && c.id.length > 0 ? { [c.id]: 1 } : {},
      );
      const measurementAxes = axes.filter((a) => !a.id.startsWith("gate:"));
      assert.equal(measurementAxes.length, 1, c.label);
      assert.equal(
        measurementAxes[0]!.id,
        UNSAFE_OMITTED,
        `${c.label} must sanitize to omission token`,
      );
      // Raw unsafe id must not appear on the report surface
      if (typeof c.id === "string" && c.id.length > 0) {
        assert.equal(
          JSON.stringify(axes).includes(c.id),
          false,
          `${c.label}: raw id must not appear in serialized axes`,
        );
      }
    }
  });

  it("bag lookup and hard_failure gate still use raw def.id (report id only sanitized)", () => {
    // Safe reserved id: report id unchanged, gate fail when hard_failure true
    const axes = buildAxisInventory(
      {
        measurements: [
          { id: "hard_failure", valueType: "boolean" },
          { id: "step_count", valueType: "number" },
        ],
      } as never,
      {
        measurements: { hard_failure: true, step_count: 9 },
      } as never,
      true,
      ["hard_failure"],
    );
    const hf = axes.find((a) => a.id === "hard_failure");
    assert.ok(hf);
    assert.equal(hf!.gate, "fail");
    assert.equal(hf!.numericValue, 1);
    const step = axes.find((a) => a.id === "step_count");
    assert.ok(step);
    assert.equal(step!.numericValue, 9);
    const gateHf = axes.find((a) => a.id === "gate:hard_failure");
    assert.ok(gateHf);
    assert.equal(gateHf!.gate, "fail");
  });

  it("end-to-end: unsafe manifest measurement id omitted on multi-axis + hard-failure reports", async () => {
    // Charset-unsafe (spaces/punctuation) — not a secret-shaped *value* that
    // would trip toolTrace/evidence redaction before report projection.
    // Real rejected path so hardFailureReport is non-null (F-002).
    const unsafeId = "weird measurement id with spaces!";
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    base.hardFailure = true;
    base.hardFailureCode = "EXECUTE_ATTEMPT_HARD_FAILURE";
    base.pathStage = "execute_attempt_hard_deny";
    const manifest = base.manifest as {
      measurements: Array<{ id: string; valueType: string }>;
    };
    manifest.measurements = [
      ...manifest.measurements,
      { id: unsafeId, valueType: "number" },
    ];
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
      manifestDigest: string;
    };
    evidence.measurements = {
      ...evidence.measurements,
      hard_failure: true,
      hard_failure_code: "EXECUTE_ATTEMPT_HARD_FAILURE",
      path_stage: "execute_attempt_hard_deny",
      [unsafeId]: 42,
    };
    // Rebind both body and evidence manifest digests after manifest mutation.
    const manifestDigest = await digestManifest(manifest as never);
    base.manifestDigest = manifestDigest;
    evidence.manifestDigest = manifestDigest;
    const rebound = await rebindBundleDigests(base);

    const r = await runDeterministicBundleVerifier(rebound, {
      verifiedAt: "2026-08-01T12:00:00.000Z",
    });
    assert.equal(r.ok, true, !r.ok ? `${r.code}: ${r.reason}` : undefined);
    if (!r.ok) return;

    assert.equal(r.result.status, "rejected");
    assert.ok(r.hardFailureReport, "hardFailureReport must be non-null on reject");
    assert.equal(r.hardFailureReport!.reportVersion, MULTI_AXIS_REPORT_VERSION);
    assert.equal(r.hardFailureReport!.verifierVersion, VERIFIER_VERSION);
    assert.notEqual(
      r.hardFailureReport!.reportVersion,
      LEGACY_MULTI_AXIS_REPORT_VERSION,
    );
    assert.notEqual(
      r.hardFailureReport!.verifierVersion,
      PRE_SANITIZE_VERIFIER_VERSION,
    );
    assert.ok(r.result.disqualifications.includes("execute_attempt"));

    const ser = JSON.stringify({
      multi: r.multiAxisReport,
      hard: r.hardFailureReport,
    });
    assert.equal(ser.includes(unsafeId), false, "raw unsafe id must not leak");
    assert.equal(
      JSON.stringify(r.hardFailureReport).includes(unsafeId),
      false,
      "raw unsafe id must not appear in serialized hardFailureReport",
    );
    assertNoSentinelLeak(ser, "e2e unsafe measurement id");

    const omittedAxes = r.multiAxisReport.axes.filter(
      (a) => a.id === UNSAFE_OMITTED,
    );
    assert.ok(
      omittedAxes.length >= 1,
      "unsafe measurement id must project as omission token",
    );
    // Omission also on hard-failure failedAxes surface when gated fail
    for (const axis of r.hardFailureReport!.failedAxes) {
      if (typeof axis.id === "string" && axis.id.length > 0) {
        assert.equal(
          axis.id.includes("weird measurement"),
          false,
          "HF failedAxes must not carry raw unsafe id substring",
        );
      }
    }
    // Safe ids still present
    assert.ok(r.multiAxisReport.axes.some((a) => a.id === "step_count"));
    assert.ok(r.multiAxisReport.axes.some((a) => a.id === "risk_tier"));
  });

  it("goldens still emit safe axis ids after sanitize projection", async () => {
    for (const file of GOLDEN_FILES) {
      const r = await runDeterministicBundleVerifier(
        loadJson(join(fixturesDir, file)),
      );
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.multiAxisReport.reportVersion, MULTI_AXIS_REPORT_VERSION);
      assert.equal(r.multiAxisReport.verifierVersion, VERIFIER_VERSION);
      assert.notEqual(
        r.multiAxisReport.reportVersion,
        LEGACY_MULTI_AXIS_REPORT_VERSION,
      );
      for (const axis of r.multiAxisReport.axes) {
        assert.notEqual(axis.id, UNSAFE_OMITTED);
        assert.match(axis.id, /^[A-Za-z0-9._:/\-]+$/);
      }
      assert.ok(r.multiAxisReport.axes.some((a) => a.id === "step_count"));
    }
  });

  it("F-001 pin: sanitized report identity is not 0.1.0/0.2.0 pre-fix path", async () => {
    assert.equal(MULTI_AXIS_REPORT_VERSION, "0.2.0");
    assert.equal(VERIFIER_VERSION, "0.3.0");
    assert.notEqual(MULTI_AXIS_REPORT_VERSION, LEGACY_MULTI_AXIS_REPORT_VERSION);
    assert.notEqual(VERIFIER_VERSION, LEGACY_VERIFIER_VERSION);
    assert.notEqual(VERIFIER_VERSION, PRE_SANITIZE_VERIFIER_VERSION);
    assert.equal(
      VERIFIER_CATALOG_BINDING.multiAxisReportVersion,
      MULTI_AXIS_REPORT_VERSION,
    );
    assert.equal(VERIFIER_CATALOG_BINDING.verifierVersion, VERIFIER_VERSION);

    const r = await runDeterministicBundleVerifier(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // Content-addressed digest must differ from pre-sanitize descriptor.
    const preSanitizeDigest = await digestVerifier({
      protocolVersion: PROTOCOL_VERSION,
      id: VERIFIER_ID,
      version: PRE_SANITIZE_VERIFIER_VERSION,
      capabilities: ["deterministic"],
    });
    assert.notEqual(r.result.verifierDigest, preSanitizeDigest);
    assert.notEqual(r.result.verifierDigest, LEGACY_VERIFIER_DIGEST);
    assert.equal(r.multiAxisReport.reportVersion, "0.2.0");
    assert.equal(r.result.verifierVersion, "0.3.0");
  });
});

/**
 * F-003 — internal `buildHardFailureReport` boundary (module-local import).
 * Still fail-closed for id sanitize + bad version tuples when reached from the
 * full-verifier path. Not a public package export (see F-004).
 */
describe("F-003 — internal buildHardFailureReport boundary", () => {
  const DUMMY_DIGEST = `sha256:${"ab".repeat(32)}`;

  function makeRejectedMulti(
    overrides: Partial<MultiAxisReport> = {},
  ): MultiAxisReport {
    return {
      reportVersion: MULTI_AXIS_REPORT_VERSION,
      catalogVersion: HARD_GATE_CATALOG_VERSION,
      verifierVersion: VERIFIER_VERSION,
      status: "rejected",
      disqualifications: ["hard_failure"],
      axes: [
        {
          id: "hard_failure",
          valueType: "boolean",
          numericValue: 1,
          gate: "fail",
        },
      ],
      bindings: {
        bundleDigest: DUMMY_DIGEST,
        evidenceDigest: DUMMY_DIGEST,
        manifestDigest: DUMMY_DIGEST,
        resultDigest: DUMMY_DIGEST,
        verifierDigest: DUMMY_DIGEST,
      },
      scenarioId: "test-scenario",
      decision: "propose",
      hardFailure: true,
      producerCodePresent: false,
      hardGateSignals: ["hard_failure"],
      ...overrides,
    };
  }

  function assertBundleInvalid(fn: () => unknown): void {
    assert.throws(fn, (e: unknown) => {
      assert.ok(e instanceof BundleConsumerError, "expected BundleConsumerError");
      assert.equal((e as BundleConsumerError).code, "BUNDLE_INVALID");
      return true;
    });
  }

  it("unsafe failed-axis id → only omission token (internal builder)", () => {
    const unsafeId = "unsafe measurement id with spaces!";
    const callerAxis: AxisReportEntry = {
      id: unsafeId,
      valueType: "boolean",
      numericValue: 1,
      gate: "fail",
    };
    // Current-looking identity tuple (auditor reproduction shape).
    const multi = makeRejectedMulti({ axes: [callerAxis] });
    const hf = buildHardFailureReport(multi);
    assert.ok(hf, "hard-failure report must be built for rejected input");
    assert.equal(hf!.reportVersion, MULTI_AXIS_REPORT_VERSION);
    assert.equal(hf!.verifierVersion, VERIFIER_VERSION);
    assert.equal(hf!.failedAxes.length, 1);
    assert.equal(hf!.failedAxes[0]!.id, UNSAFE_OMITTED);
    assert.equal(
      JSON.stringify(hf).includes(unsafeId),
      false,
      "raw unsafe id must not appear in serialized hard-failure report",
    );
    // Clone: never reuse caller axis object.
    assert.notEqual(hf!.failedAxes[0], callerAxis);
    callerAxis.id = "mutated-after-build";
    assert.equal(hf!.failedAxes[0]!.id, UNSAFE_OMITTED);
    assert.equal(
      JSON.stringify(hf).includes("mutated-after-build"),
      false,
    );
  });

  it("safe failed-axis id is preserved after clone+sanitize", () => {
    const multi = makeRejectedMulti({
      axes: [
        {
          id: "hard_failure",
          valueType: "boolean",
          numericValue: 1,
          gate: "fail",
        },
        {
          id: "gate:execute_attempt",
          valueType: "boolean",
          numericValue: 1,
          gate: "fail",
        },
      ],
    });
    const hf = buildHardFailureReport(multi);
    assert.ok(hf);
    assert.deepEqual(
      hf!.failedAxes.map((a) => a.id).sort(),
      ["gate:execute_attempt", "hard_failure"].sort(),
    );
  });

  it("rejects legacy multi-axis reportVersion (no silent upgrade)", () => {
    const multi = makeRejectedMulti({
      // Runtime-only legacy claim; type is narrowed at compile time.
      reportVersion: LEGACY_MULTI_AXIS_REPORT_VERSION as typeof MULTI_AXIS_REPORT_VERSION,
    });
    assertBundleInvalid(() => buildHardFailureReport(multi));
  });

  it("rejects pre-sanitize verifierVersion 0.2.0 (no silent upgrade)", () => {
    const multi = makeRejectedMulti({
      verifierVersion: PRE_SANITIZE_VERIFIER_VERSION,
    });
    assertBundleInvalid(() => buildHardFailureReport(multi));
  });

  it("rejects legacy verifierVersion 0.1.0", () => {
    const multi = makeRejectedMulti({
      verifierVersion: LEGACY_VERIFIER_VERSION,
    });
    assertBundleInvalid(() => buildHardFailureReport(multi));
  });

  it("rejects contradictory catalogVersion", () => {
    const multi = makeRejectedMulti({
      catalogVersion: "9.9.9" as typeof HARD_GATE_CATALOG_VERSION,
    });
    assertBundleInvalid(() => buildHardFailureReport(multi));
  });

  it("rejects contradictory verifierVersion string", () => {
    const multi = makeRejectedMulti({
      verifierVersion: "0.9.9-not-current",
    });
    assertBundleInvalid(() => buildHardFailureReport(multi));
  });

  it("null when not rejected / not hard-failure (no identity stamp attempt)", () => {
    const multi = makeRejectedMulti({
      status: "verified",
      hardFailure: false,
      disqualifications: [],
      axes: [
        {
          id: "step_count",
          valueType: "number",
          numericValue: 1,
          gate: "pass",
        },
      ],
    });
    assert.equal(buildHardFailureReport(multi), null);
  });
});

/**
 * F-004 / F-005 — public surface must not expose synthetic report builders.
 *
 * Report-seam invariant: a public symbol may emit verifier/catalog identity on
 * multi-axis / hard-failure reports only when content derives from
 * `runDeterministicBundleVerifier`. Caller-constructed report/result structures
 * never hit a public identity-stamping path.
 *
 * Guard is an **exhaustive reviewed runtime public-export manifest** (not a
 * name-heuristic deny-regex). Every public runtime symbol must appear here with
 * a classification; any new export (including aliases like
 * `createMultiAxisReport`) fails until explicitly classified. Do not "fix"
 * F-005 by extending a deny-name regex list.
 *
 * Classifications:
 * - report-seam: sole multi-axis / hard-failure report identity emitters
 * - advisory: advisory helpers that derive rows from the runner
 * - constant / utility / error / load / verify / gates / identity / redaction /
 *   tool-trace / project / report-safe / atomic-write: non-report surfaces
 */

/** Reviewed classification for every public runtime export. */
type PublicExportClass =
  | "report-seam"
  | "advisory"
  | "constant"
  | "utility"
  | "error"
  | "load"
  | "verify"
  | "gates"
  | "identity"
  | "redaction"
  | "tool-trace"
  | "project"
  | "report-safe"
  | "atomic-write"
  | "rc-evidence";

/**
 * Exhaustive manifest of approved public runtime exports.
 * Source of truth for the F-005 fail-closed surface guard.
 * Keep in lockstep with `src/index.ts` re-exports (runtime values only).
 */
const REVIEWED_PUBLIC_RUNTIME_EXPORTS: Readonly<
  Record<string, PublicExportClass>
> = Object.freeze({
  // report seams — only these may emit multi-axis / HF report identity
  runDeterministicBundleVerifier: "report-seam",
  runDeterministicBundleVerifierOrThrow: "report-seam",

  // advisory — runner-derived; out of F-005 unexport scope
  ADVISORY_BENCHMARK_REPORT_VERSION: "constant",
  ADVISORY_GOLDEN_FILES: "constant",
  buildAdvisoryBenchmarkFromGoldenFixtures: "advisory",
  buildAdvisoryBenchmarkReport: "advisory",
  buildAdvisoryRowFromBundle: "advisory",
  formatAdvisoryBenchmarkHuman: "advisory",
  isTrustworthyAdvisoryReport: "advisory",
  publicErrorCode: "advisory",
  sanitizeCiBinding: "advisory",
  sanitizeFixtureFileLabel: "advisory",

  // constants / pin identity
  BUNDLE_TOOL_TRACE_FIELDS: "constant",
  CANONICAL_EXECUTE_ATTEMPT_PATH: "constant",
  EVAL_BUNDLE_PRODUCER_ID: "constant",
  EVAL_BUNDLE_VERSION: "constant",
  HARD_GATE_CATALOG_VERSION: "constant",
  HARD_GATE_CODES: "constant",
  LEGACY_MULTI_AXIS_REPORT_VERSION: "constant",
  LEGACY_VERIFIER_DIGEST: "constant",
  LEGACY_VERIFIER_VERSION: "constant",
  MULTI_AXIS_REPORT_VERSION: "constant",
  OFFLINE_EVAL_BUNDLE_BODY_KEYS: "constant",
  PRE_SANITIZE_VERIFIER_VERSION: "constant",
  SAFE_LABEL_MAX_CHARS: "constant",
  UNSAFE_OMITTED: "constant",
  VERIFIER_CATALOG_BINDING: "constant",
  VERIFIER_ID: "constant",
  VERIFIER_VERSION: "constant",

  // errors
  BundleConsumerError: "error",

  // identity
  assertBundleIdentityCoherence: "identity",
  assertPortableInputDigestCoherence: "identity",
  assertScenarioIdentityCoherence: "identity",
  isValidDigestString: "identity",

  // gates
  assertPortableHardGateBody: "gates",
  evaluateHardGates: "gates",
  isCanonicalExecuteAttemptPath: "gates",
  mapProducerHardFailureCode: "gates",

  // load / verify / project
  loadBundleFile: "load",
  verifyPortableOfflineEvalBundle: "verify",
  projectOfflineEvalBundleBody: "project",

  // RC benchmark evidence consumer (evidence input only; never promote/EXECUTE)
  RC_DEFAULT_MAX_AGE_MS: "constant",
  RC_DEFAULT_MAX_FUTURE_SKEW_MS: "constant",
  RC_EVIDENCE_KIND: "constant",
  RC_EVIDENCE_REQUIRED_KEYS: "constant",
  RC_EVIDENCE_VERSION: "constant",
  RC_EVIDENCE_VERIFIER_ID: "constant",
  RC_EVIDENCE_VERIFIER_VERSION: "constant",
  RC_GATE_IDS: "constant",
  RC_MODES: "constant",
  isPromotionAuthorizedByRcBenchmarkEvidence: "rc-evidence",
  isRcBenchmarkVerifiedReady: "rc-evidence",
  normalizeCodeCommit: "rc-evidence",
  validateRcBenchmarkEvidence: "rc-evidence",
  verifyRcBenchmarkEvidence: "rc-evidence",

  // redaction
  isSecretValue: "redaction",
  isSensitiveKey: "redaction",
  redactDeep: "redaction",

  // tool-trace
  assertToolTraceConsumerReady: "tool-trace",
  digestToolTraceProjection: "tool-trace",
  projectToolTraceForDigest: "tool-trace",
  projectToolTraceRecordsForBundle: "tool-trace",

  // report-safe labels (not multi-axis builders)
  hasControlChars: "report-safe",
  sanitizeReportLabel: "report-safe",

  // multi-axis inventory helper (declared measurements only; not a report builder)
  declaredNumericMeasurements: "utility",

  // atomic write
  assertSafeOutputPath: "atomic-write",
  writeOutputsAtomic: "atomic-write",
});

/** Historical synthetic multi-axis / HF helpers that must remain absent. */
const HISTORICAL_SYNTHETIC_HELPERS = [
  "buildHardFailureReport",
  "buildMultiAxisReport",
  "buildAxisInventory",
  "formatHardFailureReportHuman",
] as const;

/** Sole allowed report-seam names (locked). */
const LOCKED_REPORT_SEAMS = [
  "runDeterministicBundleVerifier",
  "runDeterministicBundleVerifierOrThrow",
] as const;

function runtimeExportKeys(surface: object): string[] {
  return Reflect.ownKeys(surface)
    .filter((k): k is string => typeof k === "string")
    .sort();
}

/**
 * Fail-closed public-export manifest check.
 * Any unclassified key (or missing classified key) fails without name heuristics.
 */
function assertPublicExportManifest(surface: object): void {
  const actual = runtimeExportKeys(surface);
  const expected = Object.keys(REVIEWED_PUBLIC_RUNTIME_EXPORTS).sort();
  assert.ok(actual.length > 0, "public surface must export something");

  const unexpected = actual.filter(
    (k) => !Object.prototype.hasOwnProperty.call(REVIEWED_PUBLIC_RUNTIME_EXPORTS, k),
  );
  const missing = expected.filter(
    (k) => !Object.prototype.hasOwnProperty.call(surface, k),
  );

  assert.deepEqual(
    unexpected,
    [],
    `unclassified public runtime exports (fail until reviewed/classified): ${unexpected.join(", ")}`,
  );
  assert.deepEqual(
    missing,
    [],
    `manifest lists symbols absent from surface: ${missing.join(", ")}`,
  );
  assert.deepEqual(
    actual,
    expected,
    "public runtime export set must exactly match the reviewed manifest",
  );

  // Report-seam classification is locked to the two runner entry points.
  const reportSeams = Object.entries(REVIEWED_PUBLIC_RUNTIME_EXPORTS)
    .filter(([, c]) => c === "report-seam")
    .map(([n]) => n)
    .sort();
  assert.deepEqual(
    reportSeams,
    [...LOCKED_REPORT_SEAMS].sort(),
    "only runDeterministicBundleVerifier(+OrThrow) may be classified report-seam",
  );

  for (const name of LOCKED_REPORT_SEAMS) {
    assert.equal(
      typeof (surface as Record<string, unknown>)[name],
      "function",
      `${name} must be a function on the public surface`,
    );
  }

  // Historical synthetic helpers must never reappear under their original names.
  for (const name of HISTORICAL_SYNTHETIC_HELPERS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(surface, name),
      false,
      `${name} must not be re-exported from package index`,
    );
    assert.equal(
      typeof (surface as Record<string, unknown>)[name],
      "undefined",
      `${name} must be undefined on public index`,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(REVIEWED_PUBLIC_RUNTIME_EXPORTS, name),
      false,
      `${name} must not be classified in the reviewed manifest`,
    );
  }
}

describe("F-004/F-005 — public index does not export synthetic report builders", () => {
  it("exhaustive manifest: public runtime exports match reviewed classification", () => {
    assertPublicExportManifest(publicIndex);
  });

  it("manifest fails closed on arbitrarily named extra public callable", () => {
    // Synthetic surface: real public index + an alias that would evade any
    // build*/format* name heuristic (auditor F-005 reproduction).
    const hostile: Record<string, unknown> = Object.create(null);
    for (const key of runtimeExportKeys(publicIndex)) {
      hostile[key] = (publicIndex as Record<string, unknown>)[key];
    }
    hostile.createMultiAxisReport = () => ({
      reportVersion: "forged",
      verifierVersion: "forged",
    });

    assert.throws(
      () => assertPublicExportManifest(hostile),
      (err: unknown) => {
        assert.ok(err instanceof assert.AssertionError);
        assert.match(
          String(err.message),
          /createMultiAxisReport|unclassified public runtime exports/,
        );
        return true;
      },
    );
  });

  it("public surface: runner is sole multi-axis/HF report seam; advisory stays public", () => {
    assert.equal(typeof publicIndex.runDeterministicBundleVerifier, "function");
    assert.equal(
      typeof publicIndex.runDeterministicBundleVerifierOrThrow,
      "function",
    );
    // Advisory path untouched (architect criterion 5 / F-005 scope).
    assert.equal(typeof publicIndex.buildAdvisoryRowFromBundle, "function");
    assert.equal(typeof publicIndex.buildAdvisoryBenchmarkReport, "function");
    assert.equal(
      typeof publicIndex.buildAdvisoryBenchmarkFromGoldenFixtures,
      "function",
    );
    assert.equal(typeof publicIndex.formatAdvisoryBenchmarkHuman, "function");

    // Advisory symbols remain classified advisory/constant — not report-seam.
    for (const name of [
      "buildAdvisoryRowFromBundle",
      "buildAdvisoryBenchmarkReport",
      "buildAdvisoryBenchmarkFromGoldenFixtures",
      "formatAdvisoryBenchmarkHuman",
    ] as const) {
      const cls = REVIEWED_PUBLIC_RUNTIME_EXPORTS[name];
      assert.ok(
        cls === "advisory" || cls === "constant",
        `${name} must stay advisory/constant, not report-seam (got ${cls})`,
      );
    }
  });

  /**
   * F-005 — real rejected full-verifier path (closes vacuous F-004 hole that
   * never invoked the runner). Must call runDeterministicBundleVerifier and
   * assert non-null hardFailureReport without public synthetic builders.
   */
  it("rejected full-verifier path produces non-null hardFailureReport (real runner)", async () => {
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

    // Must go through the public runner — not buildHardFailureReport / multi-axis builders.
    const r = await publicIndex.runDeterministicBundleVerifier(rebound, {
      verifiedAt: "2026-08-01T12:00:00.000Z",
    });
    assert.equal(r.ok, true, !r.ok ? `${r.code}: ${r.reason}` : undefined);
    if (!r.ok) return;

    assert.equal(r.result.status, "rejected");
    assert.ok(
      r.result.disqualifications.includes("execute_attempt"),
      "execute_attempt must appear on rejected result",
    );
    assert.ok(
      r.hardFailureReport,
      "hardFailureReport must be non-null on rejected full-verifier path",
    );
    assert.equal(r.hardFailureReport!.status, "rejected");
    assert.equal(r.hardFailureReport!.reportVersion, MULTI_AXIS_REPORT_VERSION);
    assert.equal(r.hardFailureReport!.verifierVersion, VERIFIER_VERSION);
    assert.ok(
      r.hardFailureReport!.disqualifications.includes("execute_attempt"),
    );
    assert.ok(
      r.hardFailureReport!.summary.includes("execute_attempt"),
      "human summary must include catalog code",
    );
    assert.equal(
      r.hardFailureReport!.summary.includes("EXECUTE_ATTEMPT_HARD_FAILURE"),
      false,
      "raw producer hardFailureCode must not appear in HF summary",
    );
    assert.equal(r.multiAxisReport.status, "rejected");
    assert.equal(r.multiAxisReport.hardFailure, true);
    assert.equal(r.multiAxisReport.reportVersion, MULTI_AXIS_REPORT_VERSION);
    assert.equal(r.multiAxisReport.verifierVersion, VERIFIER_VERSION);
  });
});
