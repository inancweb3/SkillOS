/**
 * RC benchmark evidence consumer — fail-closed unit/contract tests.
 * Closes residual RC-02: expectedCodeCommit mandatory for verified-ready.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  RC_DEFAULT_MAX_AGE_MS,
  RC_EVIDENCE_KIND,
  RC_EVIDENCE_REQUIRED_KEYS,
  RC_EVIDENCE_VERIFIER_ID,
  RC_EVIDENCE_VERIFIER_VERSION,
  RC_EVIDENCE_VERSION,
  RC_GATE_IDS,
  isPromotionAuthorizedByRcBenchmarkEvidence,
  isRcBenchmarkVerifiedReady,
  normalizeCodeCommit,
  validateRcBenchmarkEvidence,
  verifyRcBenchmarkEvidence,
  type RcBenchmarkEvidence,
} from "../src/rcEvidence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const HEAD = "84beb043f4f060372e2aeb94153473bc38c03a2d";
const OTHER = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const NOW = "2026-08-05T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const bind = {
  expectedCodeCommit: HEAD,
  now: NOW_MS,
};

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

function measuredReady(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: RC_EVIDENCE_KIND,
    version: RC_EVIDENCE_VERSION,
    mode: "measured",
    codeCommit: HEAD,
    createdAt: NOW,
    benchmarkEqualsPromote: false,
    executeEnabled: false,
    promoteAuthorized: false,
    gates: Object.fromEntries(
      RC_GATE_IDS.map((id) => [id, { ok: true, detail: "ok" }]),
    ),
    qualityPass: true,
    rcBenchmarkSatisfied: true,
    ...overrides,
  };
}

describe("RC evidence fixtures load (redacted, no secrets)", () => {
  it("measured.ready fixture validates and is verified-ready with subject bind", () => {
    const e = loadFixture("rc-evidence.measured.ready.json");
    assert.equal(validateRcBenchmarkEvidence(e, bind).ok, true);
    const ready = isRcBenchmarkVerifiedReady(e, bind);
    assert.equal(ready.ready, true);
    if (ready.ready) {
      assert.equal(ready.reason, "RC_BENCHMARK_SATISFIED");
      assert.equal(ready.evidence.mode, "measured");
    }
    assert.equal(isPromotionAuthorizedByRcBenchmarkEvidence(e), false);
  });

  it("fixture.not-ready validates but never verified-ready", () => {
    const e = loadFixture("rc-evidence.fixture.not-ready.json");
    assert.equal(validateRcBenchmarkEvidence(e, bind).ok, true);
    assert.deepEqual(isRcBenchmarkVerifiedReady(e, bind), {
      ready: false,
      reason: "RC_BENCHMARK_FIXTURE_NOT_MEASURED",
    });
  });

  it("measured.gate-fail validates and is not verified-ready", () => {
    const e = loadFixture("rc-evidence.measured.gate-fail.json");
    assert.equal(validateRcBenchmarkEvidence(e, bind).ok, true);
    assert.deepEqual(isRcBenchmarkVerifiedReady(e, bind), {
      ready: false,
      reason: "RC_BENCHMARK_NOT_SATISFIED",
    });
  });
});

describe("validateRcBenchmarkEvidence fail-closed", () => {
  it("rejects null/array/non-object", () => {
    assert.equal(validateRcBenchmarkEvidence(null).ok, false);
    assert.equal(validateRcBenchmarkEvidence([]).ok, false);
    assert.equal(validateRcBenchmarkEvidence("x").ok, false);
  });

  it("rejects missing required fields", () => {
    for (const k of RC_EVIDENCE_REQUIRED_KEYS) {
      const e = measuredReady();
      delete e[k];
      const v = validateRcBenchmarkEvidence(e, bind);
      assert.equal(v.ok, false);
      assert.match(v.reason, /MISSING_FIELD|RC_BENCHMARK/);
    }
  });

  it("rejects wrong kind / version / mode", () => {
    assert.equal(
      validateRcBenchmarkEvidence(measuredReady({ kind: "not.rc" }), bind).ok,
      false,
    );
    assert.equal(
      validateRcBenchmarkEvidence(measuredReady({ version: "0.1.0" }), bind)
        .ok,
      false,
    );
    assert.equal(
      validateRcBenchmarkEvidence(measuredReady({ mode: "live" }), bind).ok,
      false,
    );
  });

  it("rejects invalid codeCommit / createdAt", () => {
    assert.equal(
      validateRcBenchmarkEvidence(measuredReady({ codeCommit: "abc" }), bind)
        .ok,
      false,
    );
    assert.equal(
      validateRcBenchmarkEvidence(
        measuredReady({ createdAt: "0000000000" }),
        bind,
      ).ok,
      false,
    );
  });

  it("rejects promote/EXECUTE flags not hard-false", () => {
    assert.equal(
      validateRcBenchmarkEvidence(
        measuredReady({ promoteAuthorized: true }),
        bind,
      ).ok,
      false,
    );
    assert.equal(
      validateRcBenchmarkEvidence(
        measuredReady({ executeEnabled: true }),
        bind,
      ).ok,
      false,
    );
    assert.equal(
      validateRcBenchmarkEvidence(
        measuredReady({ benchmarkEqualsPromote: true }),
        bind,
      ).ok,
      false,
    );
  });

  it("rejects tampered qualityPass / rcBenchmarkSatisfied", () => {
    const q = measuredReady({
      gates: Object.fromEntries(
        RC_GATE_IDS.map((id) => [
          id,
          { ok: id !== "typecheck", detail: "ok" },
        ]),
      ),
      qualityPass: false,
      rcBenchmarkSatisfied: false,
    });
    q.qualityPass = true;
    q.rcBenchmarkSatisfied = true;
    assert.equal(validateRcBenchmarkEvidence(q, bind).ok, false);

    const s = measuredReady();
    s.rcBenchmarkSatisfied = false;
    const sv = validateRcBenchmarkEvidence(s, bind);
    assert.equal(sv.ok, false);
    if (!sv.ok) {
      assert.equal(sv.reason, "RC_BENCHMARK_SATISFIED_TAMPER");
    }
  });

  it("rejects stale and future createdAt", () => {
    const stale = measuredReady({ createdAt: "2020-01-01T00:00:00.000Z" });
    const staleV = validateRcBenchmarkEvidence(stale, bind);
    assert.equal(staleV.ok, false);
    if (!staleV.ok) {
      assert.equal(staleV.reason, "RC_BENCHMARK_CREATED_AT_STALE");
    }
    const future = measuredReady({ createdAt: "2099-01-01T00:00:00.000Z" });
    const futureV = validateRcBenchmarkEvidence(future, bind);
    assert.equal(futureV.ok, false);
    if (!futureV.ok) {
      assert.equal(futureV.reason, "RC_BENCHMARK_CREATED_AT_FUTURE");
    }
  });

  it("rejects subject mismatch when expectedCodeCommit provided", () => {
    const e = measuredReady({ codeCommit: OTHER });
    const v = validateRcBenchmarkEvidence(e, bind);
    assert.equal(v.ok, false);
    assert.equal(v.reason, "RC_BENCHMARK_CODE_COMMIT_MISMATCH");
  });

  it("allows structural validate without subject bind (shape only)", () => {
    const e = measuredReady({ codeCommit: OTHER });
    const v = validateRcBenchmarkEvidence(e, { now: NOW_MS });
    assert.equal(v.ok, true);
  });
});

describe("RC-02 mandatory subject bind for verified-ready", () => {
  it("omit expectedCodeCommit → SUBJECT_BIND_REQUIRED (non-success)", () => {
    const e = measuredReady();
    // @ts-expect-error — intentional missing bind for fail-closed probe
    const ready = isRcBenchmarkVerifiedReady(e, { now: NOW_MS });
    assert.equal(ready.ready, false);
    assert.equal(ready.reason, "RC_BENCHMARK_SUBJECT_BIND_REQUIRED");

    // @ts-expect-error — intentional missing bind
    const out = verifyRcBenchmarkEvidence(e, { now: NOW_MS });
    assert.equal(out.ok, false);
    assert.equal(out.verifiedReady, false);
    assert.equal(out.reason, "RC_BENCHMARK_SUBJECT_BIND_REQUIRED");
    assert.equal(out.promoteAuthorized, false);
  });

  it("empty/whitespace expectedCodeCommit → SUBJECT_BIND_REQUIRED", () => {
    const e = measuredReady();
    assert.equal(
      isRcBenchmarkVerifiedReady(e, {
        expectedCodeCommit: "",
        now: NOW_MS,
      }).reason,
      "RC_BENCHMARK_SUBJECT_BIND_REQUIRED",
    );
    assert.equal(
      isRcBenchmarkVerifiedReady(e, {
        expectedCodeCommit: "   ",
        now: NOW_MS,
      }).reason,
      "RC_BENCHMARK_SUBJECT_BIND_REQUIRED",
    );
  });

  it("measured + all-zero commit without bind would be producer ready; consumer refuses", () => {
    // Producer residual RC-02: without expectedCodeCommit, all-zero measured
    // could be ready. Consumer must not allow omit-bind success.
    const e = measuredReady({
      codeCommit: "0000000000000000000000000000000000000000",
    });
    const producerStyle = isRcBenchmarkVerifiedReady(e, {
      expectedCodeCommit: "",
      now: NOW_MS,
    });
    assert.equal(producerStyle.ready, false);
    assert.equal(producerStyle.reason, "RC_BENCHMARK_SUBJECT_BIND_REQUIRED");
  });

  it("measured + matching bind → verified-ready", () => {
    const e = measuredReady();
    const ready = isRcBenchmarkVerifiedReady(e, bind);
    assert.equal(ready.ready, true);
    const out = verifyRcBenchmarkEvidence(e, bind);
    assert.equal(out.ok, true);
    assert.equal(out.verifiedReady, true);
    assert.equal(out.reason, "RC_BENCHMARK_SATISFIED");
    assert.equal(out.promoteAuthorized, false);
    assert.equal(out.verifierId, RC_EVIDENCE_VERIFIER_ID);
    assert.equal(out.verifierVersion, RC_EVIDENCE_VERIFIER_VERSION);
  });

  it("measured + mismatched bind → CODE_COMMIT_MISMATCH", () => {
    const e = measuredReady({ codeCommit: OTHER });
    assert.equal(
      isRcBenchmarkVerifiedReady(e, bind).reason,
      "RC_BENCHMARK_CODE_COMMIT_MISMATCH",
    );
  });

  it("normalizeCodeCommit is case-insensitive", () => {
    assert.equal(
      normalizeCodeCommit("AABBCCDD"),
      normalizeCodeCommit("aabbccdd"),
    );
    const e = measuredReady({ codeCommit: HEAD.toUpperCase() });
    assert.equal(isRcBenchmarkVerifiedReady(e, bind).ready, true);
  });
});

describe("isRcBenchmarkVerifiedReady measured path", () => {
  it("missing evidence → MISSING", () => {
    assert.deepEqual(isRcBenchmarkVerifiedReady(null, bind), {
      ready: false,
      reason: "RC_BENCHMARK_MISSING",
    });
  });

  it("fixture mode never ready even with bind", () => {
    const e = measuredReady({ mode: "fixture" });
    assert.equal(
      isRcBenchmarkVerifiedReady(e, bind).reason,
      "RC_BENCHMARK_FIXTURE_NOT_MEASURED",
    );
  });

  it("gate fail → NOT_SATISFIED", () => {
    const e = measuredReady({
      gates: Object.fromEntries(
        RC_GATE_IDS.map((id) => [
          id,
          { ok: id !== "unitTests", detail: "ok" },
        ]),
      ),
      qualityPass: false,
      rcBenchmarkSatisfied: false,
    });
    assert.equal(
      isRcBenchmarkVerifiedReady(e, bind).reason,
      "RC_BENCHMARK_NOT_SATISFIED",
    );
  });
});

describe("non-authority: verified ≠ promote", () => {
  it("isPromotionAuthorizedByRcBenchmarkEvidence always false", () => {
    assert.equal(isPromotionAuthorizedByRcBenchmarkEvidence(null), false);
    assert.equal(
      isPromotionAuthorizedByRcBenchmarkEvidence(measuredReady()),
      false,
    );
    assert.equal(
      isPromotionAuthorizedByRcBenchmarkEvidence({
        promoteAuthorized: true,
      }),
      false,
    );
  });

  it("verify outcome always promoteAuthorized false", () => {
    const ok = verifyRcBenchmarkEvidence(measuredReady(), bind);
    assert.equal(ok.promoteAuthorized, false);
    const bad = verifyRcBenchmarkEvidence(null, bind);
    assert.equal(bad.promoteAuthorized, false);
    assert.equal(bad.verifiedReady, false);
  });
});

describe("freshness defaults", () => {
  it("exports default windows matching producer contract", () => {
    assert.equal(RC_DEFAULT_MAX_AGE_MS, 48 * 60 * 60 * 1000);
  });

  it("custom maxAgeMs can accept older evidence for tests", () => {
    const e = measuredReady({ createdAt: "2020-01-01T00:00:00.000Z" });
    const ready = isRcBenchmarkVerifiedReady(e, {
      ...bind,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(ready.ready, true);
  });
});

describe("verifyRcBenchmarkEvidence structural vs ready", () => {
  it("valid fixture with bind → ok true, verifiedReady false", () => {
    const e = measuredReady({ mode: "fixture" });
    const out = verifyRcBenchmarkEvidence(e, bind);
    assert.equal(out.ok, true);
    assert.equal(out.verifiedReady, false);
    assert.equal(out.reason, "RC_BENCHMARK_FIXTURE_NOT_MEASURED");
    if (out.ok) {
      assert.equal((out.evidence as RcBenchmarkEvidence).mode, "fixture");
    }
  });

  it("invalid type → ok false", () => {
    const out = verifyRcBenchmarkEvidence("not-json", bind);
    assert.equal(out.ok, false);
    assert.equal(out.verifiedReady, false);
  });
});
