import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestEvidence,
  digestJsonValue,
  parseJsonStrict,
} from "@skillos/protocol";
import {
  runDeterministicBundleVerifier,
  verifyPortableOfflineEvalBundle,
  projectOfflineEvalBundleBody,
  projectToolTraceRecordsForBundle,
  digestToolTraceProjection,
  assertToolTraceConsumerReady,
  isSecretValue,
  EVAL_BUNDLE_PRODUCER_ID,
  OFFLINE_EVAL_BUNDLE_BODY_KEYS,
  type OfflineEvalBundleBody,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  "../fixtures/risk-tier.portable.bundle.json",
);

function loadFixture(): Record<string, unknown> {
  const text = readFileSync(fixturePath, "utf8");
  return parseJsonStrict(text) as Record<string, unknown>;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Fully rebind nested digests after body mutation so fail-open cannot hide
 * behind stale digest mismatch. Mirrors producer binding order.
 */
async function rebindBundleDigests(
  bundle: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const evidence = deepClone(bundle.evidence) as {
    artifacts: Array<Record<string, unknown>>;
    [k: string]: unknown;
  };
  const toolTrace = bundle.toolTrace;
  // Validate shape and recompute tool_trace artifact digest from projection
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
  // keep body.manifestDigest as-is unless caller changed manifest
  if (typeof bundle.manifestDigest === "string") {
    body.manifestDigest = bundle.manifestDigest;
  }
  const bundleDigest = await digestJsonValue(body);
  return { ...body, bundleDigest };
}

describe("verifyPortableOfflineEvalBundle — golden fixture", () => {
  it("accepts the synthetic risk-tier portable bundle", async () => {
    const bundle = loadFixture();
    const r = await verifyPortableOfflineEvalBundle(bundle);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.bundleDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(r.bundleDigest, bundle.bundleDigest);
    assert.equal(r.body.producer.id, EVAL_BUNDLE_PRODUCER_ID);
    assert.equal(r.body.scenario.scenarioId, "risk-tier-conservative-limits");
  });

  it("emits a protocol-valid VerificationResult bound to evidence", async () => {
    const bundle = loadFixture();
    const r = await runDeterministicBundleVerifier(bundle, {
      verifiedAt: "2026-08-01T12:00:00.000Z",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.status, "verified");
    assert.equal(r.result.evidenceId, r.body.evidence.evidenceId);
    assert.equal(r.result.manifestDigest, r.body.manifestDigest);
    assert.equal(r.result.verifierId, "skillos.offline.bundle-verifier");
    assert.match(r.result.resultDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(r.result.disqualifications, []);
    // Only declared numeric/boolean axes projected
    assert.equal(r.result.measurements.step_count, 8);
    assert.equal(r.result.measurements.hard_failure, 0);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        r.result.measurements,
        "attacker_score",
      ),
      false,
    );
  });
});

describe("P1 measurements — fully re-digested", () => {
  it("rejects unknown evidence measurement after full rebind", async () => {
    const base = deepClone(loadFixture());
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements = {
      ...evidence.measurements,
      attacker_score: 999,
    };
    const rebound = await rebindBundleDigests(base);
    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "MEASUREMENTS_INVALID");
  });

  it("rejects missing required measurement after full rebind", async () => {
    const base = deepClone(loadFixture());
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    delete evidence.measurements.step_count;
    const rebound = await rebindBundleDigests(base);
    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "MEASUREMENTS_INVALID");
  });

  it("rejects wrong-type measurement after full rebind", async () => {
    const base = deepClone(loadFixture());
    const evidence = base.evidence as {
      measurements: Record<string, unknown>;
    };
    evidence.measurements.step_count = "not-a-number";
    const rebound = await rebindBundleDigests(base);
    const r = await runDeterministicBundleVerifier(rebound);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "MEASUREMENTS_INVALID");
  });
});

describe("P1 embedded secret redaction — fully re-digested", () => {
  it("isSecretValue detects embedded Authorization Bearer (case-insensitive)", () => {
    assert.equal(
      isSecretValue(
        "request rejected; Authorization: Bearer dummy-not-a-live-secret",
      ),
      true,
    );
    assert.equal(isSecretValue("Bearer only-token-value-here"), true);
    assert.equal(
      isSecretValue("Proxy-Authorization: Basic dXNlcjpwYXNz"),
      true,
    );
    // Case-insensitive schemes (HTTP auth is case-insensitive)
    assert.equal(isSecretValue("bearer only-token-value-here"), true);
    assert.equal(isSecretValue("BASIC dXNlcjpwYXNzMTIz"), true);
    assert.equal(
      isSecretValue(
        "request rejected; authorization: bearer dummy-not-a-live-secret",
      ),
      true,
    );
    assert.equal(
      isSecretValue("log line bearer abcdefghijklmnop under noise"),
      true,
    );
    // near-miss safe strings
    assert.equal(isSecretValue("authorization header missing"), false);
    assert.equal(isSecretValue("short"), false);
  });

  it("rejects nested embedded Bearer under innocuous key after rebind", async () => {
    const base = deepClone(loadFixture());
    const toolTrace = base.toolTrace as Array<Record<string, unknown>>;
    const first = toolTrace[0]!;
    first.result = {
      ...(typeof first.result === "object" && first.result !== null
        ? (first.result as object)
        : {}),
      detail: "request rejected; Authorization: Bearer dummy-not-a-live-secret",
    };
    const rebound = await rebindBundleDigests(base);
    const r = await verifyPortableOfflineEvalBundle(rebound);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "TRACE_NOT_REDACTED");
  });

  it("rejects lowercase bare bearer under innocuous key after full rebind", async () => {
    const base = deepClone(loadFixture());
    const toolTrace = base.toolTrace as Array<Record<string, unknown>>;
    const first = toolTrace[0]!;
    first.result = {
      ...(typeof first.result === "object" && first.result !== null
        ? (first.result as object)
        : {}),
      detail: "upstream error: bearer dummy-not-a-live-secret",
    };
    const rebound = await rebindBundleDigests(base);
    const r = await verifyPortableOfflineEvalBundle(rebound);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "TRACE_NOT_REDACTED");
  });
});

describe("P2 strict toolTrace types — fully re-digested", () => {
  it("rejects string boolean ok after rebind", async () => {
    const base = deepClone(loadFixture());
    const toolTrace = base.toolTrace as Array<Record<string, unknown>>;
    toolTrace[0] = { ...toolTrace[0]!, ok: "false" };
    // rebind will fail at projectToolTraceRecordsForBundle
    await assert.rejects(
      () => rebindBundleDigests(base),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "TRACE_UNEXPECTED_FIELD");
        assert.match(err.message, /ok must be a boolean/);
        return true;
      },
    );
  });

  it("rejects coerced-looking string ok via full verify path after manual digest skip", async () => {
    // Build a self-consistent body by hand without going through projector:
    // set ok to string, recompute digests using coerced projection would hide —
    // instead validate that projector rejects before any acceptance.
    const body = projectOfflineEvalBundleBody(loadFixture());
    const badTrace = deepClone(body.toolTrace) as Array<Record<string, unknown>>;
    badTrace[0] = { ...badTrace[0]!, ok: "false" as unknown as boolean };
    await assert.rejects(
      () =>
        assertToolTraceConsumerReady(badTrace, body.evidence),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "TRACE_UNEXPECTED_FIELD");
        return true;
      },
    );
  });

  it("rejects missing required field", async () => {
    const body = projectOfflineEvalBundleBody(loadFixture());
    const bad = deepClone(body.toolTrace) as Array<Record<string, unknown>>;
    delete bad[0]!.tool;
    await assert.rejects(
      () => assertToolTraceConsumerReady(bad, body.evidence),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "TRACE_UNEXPECTED_FIELD");
        assert.match(err.message, /missing required field "tool"/);
        return true;
      },
    );
  });

  it("rejects non-finite / negative latency", async () => {
    const body = projectOfflineEvalBundleBody(loadFixture());
    const bad = deepClone(body.toolTrace) as Array<Record<string, unknown>>;
    bad[0] = { ...bad[0]!, logicalLatencyMs: -1 };
    await assert.rejects(
      () => assertToolTraceConsumerReady(bad, body.evidence),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "TRACE_UNEXPECTED_FIELD");
        return true;
      },
    );
    bad[0] = { ...bad[0]!, logicalLatencyMs: Number.NaN };
    await assert.rejects(
      () => assertToolTraceConsumerReady(bad, body.evidence),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "TRACE_UNEXPECTED_FIELD");
        return true;
      },
    );
  });

  it("rejects numeric string latency", async () => {
    const body = projectOfflineEvalBundleBody(loadFixture());
    const bad = deepClone(body.toolTrace) as Array<Record<string, unknown>>;
    bad[0] = { ...bad[0]!, logicalLatencyMs: "12" as unknown as number };
    await assert.rejects(
      () => assertToolTraceConsumerReady(bad, body.evidence),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "TRACE_UNEXPECTED_FIELD");
        return true;
      },
    );
  });
});

describe("verifyPortableOfflineEvalBundle — fail-closed tamper cases", () => {
  it("rejects unknown top-level field", async () => {
    const bundle = loadFixture();
    (bundle as Record<string, unknown>).diagnostic = { wallClockMs: 1 };
    const r = await verifyPortableOfflineEvalBundle(bundle);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "BUNDLE_UNKNOWN_FIELD");
  });

  it("rejects bundleDigest mismatch", async () => {
    const bundle = loadFixture();
    bundle.bundleDigest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const r = await verifyPortableOfflineEvalBundle(bundle);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "BUNDLE_DIGEST_MISMATCH");
  });

  it("rejects unexpected toolTrace field", async () => {
    const bundle = deepClone(loadFixture());
    const toolTrace = bundle.toolTrace as Array<Record<string, unknown>>;
    toolTrace[0] = { ...toolTrace[0]!, wallClockMs: 99 };
    const r = await verifyPortableOfflineEvalBundle(bundle);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(
      r.code === "TRACE_UNEXPECTED_FIELD" ||
        r.code === "BUNDLE_DIGEST_MISMATCH",
      `unexpected code ${r.code}: ${r.reason}`,
    );
  });

  it("rejects producer id mismatch", async () => {
    const bundle = deepClone(loadFixture());
    const producer = bundle.producer as Record<string, unknown>;
    producer.id = "not.the.canonical.producer";
    const r = await verifyPortableOfflineEvalBundle(bundle);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(
      r.code === "PRODUCER_ID_INVALID" || r.code === "BUNDLE_DIGEST_MISMATCH",
      `unexpected code ${r.code}: ${r.reason}`,
    );
  });
});

describe("projectOfflineEvalBundleBody", () => {
  it("projects body without bundleDigest field", () => {
    const bundle = loadFixture();
    const body = projectOfflineEvalBundleBody(bundle);
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, "bundleDigest"),
      false,
    );
    assert.equal(body.bundleVersion, "0.1.0");
  });
});

describe("assertToolTraceConsumerReady — TRACE_ARTIFACT_COUNT", () => {
  it("rejects zero tool_trace artifacts", async () => {
    const body = projectOfflineEvalBundleBody(
      loadFixture(),
    ) as OfflineEvalBundleBody;
    const evidence = {
      ...body.evidence,
      artifacts: body.evidence.artifacts.filter((a) => a.role !== "tool_trace"),
    };
    await assert.rejects(
      () => assertToolTraceConsumerReady(body.toolTrace, evidence),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "TRACE_ARTIFACT_COUNT");
        return true;
      },
    );
  });

  it("rejects two tool_trace artifacts", async () => {
    const body = projectOfflineEvalBundleBody(
      loadFixture(),
    ) as OfflineEvalBundleBody;
    const trace = body.evidence.artifacts.find((a) => a.role === "tool_trace")!;
    const evidence = {
      ...body.evidence,
      artifacts: [...body.evidence.artifacts, { ...trace }],
    };
    await assert.rejects(
      () => assertToolTraceConsumerReady(body.toolTrace, evidence),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, "TRACE_ARTIFACT_COUNT");
        return true;
      },
    );
  });
});
