/**
 * Advisory CI benchmark report v0.1 tests (Faz 2 item 5).
 * Production seam: runDeterministicBundleVerifier over locked goldens.
 * GOLDEN_LOCK digests must not drift.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  digestEvidence,
  digestJsonValue,
  parseJsonStrict,
} from "@skillos/protocol";
import {
  ADVISORY_BENCHMARK_REPORT_VERSION,
  ADVISORY_GOLDEN_FILES,
  HARD_GATE_CATALOG_VERSION,
  MULTI_AXIS_REPORT_VERSION,
  OFFLINE_EVAL_BUNDLE_BODY_KEYS,
  VERIFIER_ID,
  VERIFIER_VERSION,
  buildAdvisoryBenchmarkFromGoldenFixtures,
  buildAdvisoryBenchmarkReport,
  buildAdvisoryRowFromBundle,
  formatAdvisoryBenchmarkHuman,
  isTrustworthyAdvisoryReport,
  projectToolTraceRecordsForBundle,
  digestToolTraceProjection,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../fixtures");
const lockPath = join(fixturesDir, "GOLDEN_LOCK.json");
const FIXED_AT = "2026-08-01T12:00:00.000Z";
const cliPath = join(here, "../src/advisoryBenchmarkCli.ts");

const SECRET_SENTINELS = [
  "Authorization: Bearer dummy-not-a-live-secret-ABCDEFGH",
  "Bearer abcdefghijklmnop",
  "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
  "api_key=supersecretvalue123456",
  "portfolio_id=user-private-portfolio-99",
] as const;

const PRIVATE_PATH_SENTINEL =
  "/private/secret-vault/user-portfolio-99/Authorization: Bearer dummy-not-a-live-secret-ABCDEFGH.portable.bundle.json";

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

  const bundleDigest = await digestJsonValue(body);
  return { ...body, bundleDigest };
}

function assertNoSentinelLeak(serialized: string): void {
  for (const s of SECRET_SENTINELS) {
    assert.equal(
      serialized.includes(s),
      false,
      `report leaked sentinel: ${s.slice(0, 24)}…`,
    );
  }
  assert.equal(serialized.includes("EXECUTE_ATTEMPT_HARD_FAILURE"), false);
}

describe("advisory benchmark — authority literals + versions", () => {
  it("locks advisory/non-authority flags and version pins", async () => {
    const report = await buildAdvisoryBenchmarkFromGoldenFixtures(fixturesDir, {
      verifiedAt: FIXED_AT,
    });
    assert.equal(report.reportVersion, ADVISORY_BENCHMARK_REPORT_VERSION);
    assert.equal(report.advisory, true);
    assert.equal(report.promotionAuthority, false);
    assert.equal(report.executionAuthority, false);
    assert.equal(report.verifierId, VERIFIER_ID);
    assert.equal(report.verifierVersion, VERIFIER_VERSION);
    assert.equal(report.catalogVersion, HARD_GATE_CATALOG_VERSION);
    assert.equal(report.multiAxisReportVersion, MULTI_AXIS_REPORT_VERSION);
    assert.equal(report.gitSha, "");
    assert.equal(report.workflowRunId, "");
  });
});

describe("advisory benchmark — four locked goldens", () => {
  it("GOLDEN_LOCK digests unchanged after report build", async () => {
    const beforeLock = readFileSync(lockPath, "utf8");
    const lock = parseJsonStrict(beforeLock) as {
      fixtures: Array<{ file: string; bundleDigest: string }>;
    };
    assert.equal(lock.fixtures.length, 4);

    await buildAdvisoryBenchmarkFromGoldenFixtures(fixturesDir, {
      verifiedAt: FIXED_AT,
    });

    const afterLock = readFileSync(lockPath, "utf8");
    assert.equal(afterLock, beforeLock);
    for (const entry of lock.fixtures) {
      const bundle = loadJson(join(fixturesDir, entry.file));
      assert.equal(bundle.bundleDigest, entry.bundleDigest);
    }
  });

  it("produces one stable row per locked golden (all verified today)", async () => {
    const report = await buildAdvisoryBenchmarkFromGoldenFixtures(fixturesDir, {
      verifiedAt: FIXED_AT,
    });
    assert.equal(report.rows.length, 4);
    assert.equal(report.summary.totalRows, 4);
    assert.equal(report.summary.verified, 4);
    assert.equal(report.summary.rejected, 0);
    assert.equal(report.summary.error, 0);

    const files = new Set(report.rows.map((r) => r.fixtureFile));
    for (const f of ADVISORY_GOLDEN_FILES) {
      assert.ok(files.has(f), `missing row for ${f}`);
    }

    for (const row of report.rows) {
      assert.equal(row.status, "verified");
      assert.deepEqual(row.disqualifications, []);
      assert.equal(row.verifiedAt, FIXED_AT);
      assert.ok(row.bundleDigest?.startsWith("sha256:"));
      assert.ok(row.resultDigest?.startsWith("sha256:"));
      assert.ok(row.evidenceDigest?.startsWith("sha256:"));
      assert.ok(row.manifestDigest?.startsWith("sha256:"));
      assert.ok(row.verifierDigest?.startsWith("sha256:"));
      assert.ok(row.rowId.includes("::"));
      assert.equal(row.error, undefined);
    }
  });

  it("A-1: records effective verifiedAt; override differs from default in the field (not only digests)", async () => {
    const OVERRIDE = "2026-09-15T18:30:00.000Z";
    const withDefault = await buildAdvisoryBenchmarkFromGoldenFixtures(
      fixturesDir,
      {},
    );
    const withOverride = await buildAdvisoryBenchmarkFromGoldenFixtures(
      fixturesDir,
      { verifiedAt: OVERRIDE },
    );

    assert.equal(withDefault.rows.length, 4);
    assert.equal(withOverride.rows.length, 4);

    for (let i = 0; i < 4; i += 1) {
      const d = withDefault.rows[i]!;
      const o = withOverride.rows[i]!;
      // Default path uses evidence.createdAt (goldens pin 2026-08-01T12:00:00.000Z)
      assert.equal(d.verifiedAt, "2026-08-01T12:00:00.000Z");
      assert.equal(o.verifiedAt, OVERRIDE);
      assert.notEqual(d.verifiedAt, o.verifiedAt);
      // resultDigest is bound to verifiedAt — must change when the field changes
      assert.notEqual(d.resultDigest, o.resultDigest);
      // Other identity digests (bundle/evidence) stay on the fixture, not the clock
      assert.equal(d.bundleDigest, o.bundleDigest);
      assert.equal(d.evidenceDigest, o.evidenceDigest);
    }
  });

  it("is deterministic for fixed verifiedAt (same digests + codes)", async () => {
    const a = await buildAdvisoryBenchmarkFromGoldenFixtures(fixturesDir, {
      verifiedAt: FIXED_AT,
      gitSha: "deadbeef",
      workflowRunId: "123",
    });
    const b = await buildAdvisoryBenchmarkFromGoldenFixtures(fixturesDir, {
      verifiedAt: FIXED_AT,
      gitSha: "deadbeef",
      workflowRunId: "123",
    });
    // Compare without relying on object identity
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  it("serialized report has no raw secret sentinels or raw producer codes", async () => {
    const report = await buildAdvisoryBenchmarkFromGoldenFixtures(fixturesDir, {
      verifiedAt: FIXED_AT,
    });
    assertNoSentinelLeak(JSON.stringify(report));
    assertNoSentinelLeak(formatAdvisoryBenchmarkHuman(report));
  });
});

describe("advisory benchmark — fail-closed rejected + error rows", () => {
  it("synthetic execute hard-fail row is rejected with execute_attempt (not verified)", async () => {
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
    base.evidence = evidence;

    const rebound = await rebindBundleDigests(base);
    const row = await buildAdvisoryRowFromBundle(
      rebound,
      {
        file: "synthetic-execute.portable.bundle.json",
        configLabel: "synthetic-execute",
      },
      { verifiedAt: FIXED_AT },
    );

    assert.equal(row.status, "rejected");
    assert.ok(row.disqualifications.includes("execute_attempt"));
    assert.ok(row.resultDigest?.startsWith("sha256:"));
    assert.equal(row.error, undefined);
    // raw producer code must not appear on the row surface
    assert.equal(
      JSON.stringify(row).includes("EXECUTE_ATTEMPT_HARD_FAILURE"),
      false,
    );
  });

  it("malformed bundle becomes status=error (never verified)", async () => {
    const report = await buildAdvisoryBenchmarkReport(
      [
        {
          path: join(fixturesDir, "risk-tier.portable.bundle.json"),
          file: "risk-tier.portable.bundle.json",
        },
        {
          path: join(fixturesDir, "does-not-exist.portable.bundle.json"),
          file: "does-not-exist.portable.bundle.json",
        },
      ],
      { verifiedAt: FIXED_AT },
    );
    assert.equal(report.rows.length, 2);
    assert.equal(report.rows[0]!.status, "verified");
    assert.equal(report.rows[1]!.status, "error");
    assert.ok(report.rows[1]!.error?.code);
    assert.equal(
      Object.prototype.hasOwnProperty.call(report.rows[1]!.error, "reason"),
      false,
      "error must be code-only (F-001)",
    );
    assert.equal(report.summary.error, 1);
    assert.equal(report.summary.verified, 1);
    assert.equal(isTrustworthyAdvisoryReport(report, 2), false);
  });
});

describe("F-001 — no raw diagnostics in report surface", () => {
  it("private path / unsafe filename / secret-shaped meta never appear in error rows", async () => {
    const unsafeName =
      "Authorization: Bearer dummy-not-a-live-secret-ABCDEFGH\nline2.portable.bundle.json";
    const report = await buildAdvisoryBenchmarkReport(
      [
        {
          path: PRIVATE_PATH_SENTINEL,
          file: unsafeName,
          configLabel: "portfolio_id=user-private-portfolio-99",
        },
      ],
      {
        verifiedAt: FIXED_AT,
        gitSha: "Authorization: Bearer dummy-not-a-live-secret-ABCDEFGH",
        workflowRunId: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
      },
    );
    assert.equal(report.rows.length, 1);
    assert.equal(report.rows[0]!.status, "error");
    assert.ok(report.rows[0]!.error?.code);
    assert.equal(
      Object.prototype.hasOwnProperty.call(report.rows[0]!.error, "reason"),
      false,
    );
    // CI bindings with secret shape must be emptied, not echoed
    assert.equal(report.gitSha, "");
    assert.equal(report.workflowRunId, "");

    const serialized = JSON.stringify(report);
    assertNoSentinelLeak(serialized);
    assert.equal(serialized.includes(PRIVATE_PATH_SENTINEL), false);
    assert.equal(serialized.includes("/private/secret-vault"), false);
    assert.equal(serialized.includes("does not exist"), false);
    assert.equal(serialized.includes("ENOENT"), false);
    // fixtureFile sanitized (unsafe → omission token)
    assert.equal(report.rows[0]!.fixtureFile, "[omitted:unsafe_label]");
  });

  it("verify-failure row is code-only (no raw reason with digest/secret interpolation)", async () => {
    const base = deepClone(
      loadJson(join(fixturesDir, "risk-tier.portable.bundle.json")),
    );
    // Digest mismatch without rebind → verify fail closed
    base.decision = "tampered-decision-value";
    const row = await buildAdvisoryRowFromBundle(
      base,
      {
        file: "risk-tier.portable.bundle.json",
      },
      { verifiedAt: FIXED_AT },
    );
    assert.equal(row.status, "error");
    assert.ok(row.error?.code);
    assert.equal(Object.prototype.hasOwnProperty.call(row.error, "reason"), false);
    const s = JSON.stringify(row);
    assert.equal(s.includes("tampered-decision-value"), false);
    assertNoSentinelLeak(s);
  });
});

function runCli(
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("npx", ["tsx", cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env },
    cwd: join(here, ".."),
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("F-002 — error rows fail closed (CLI exit 2, no artifact)", () => {
  it("missing fixtures dir / empty set exits 2 without writing --out", () => {
    const dir = mkdtempSync(join(tmpdir(), "adv-empty-"));
    const out = join(dir, "advisory-benchmark-report.json");
    const empty = mkdtempSync(join(tmpdir(), "adv-fix-empty-"));
    try {
      const r = runCli([
        "--out",
        out,
        "--fixtures-dir",
        empty,
        "--quiet",
      ]);
      assert.equal(r.status, 2, r.stderr);
      assert.equal(existsSync(out), false);
      assertNoSentinelLeak(r.stderr);
      assertNoSentinelLeak(r.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("invalid JSON fixture among four exits 2 and leaves no --out", () => {
    const fixDir = mkdtempSync(join(tmpdir(), "adv-badjson-"));
    const outDir = mkdtempSync(join(tmpdir(), "adv-out-"));
    const out = join(outDir, "advisory-benchmark-report.json");
    try {
      for (const f of ADVISORY_GOLDEN_FILES) {
        if (f === "risk-tier.portable.bundle.json") {
          writeFileSync(
            join(fixDir, f),
            "{ not valid json Authorization: Bearer dummy-not-a-live-secret-ABCDEFGH\n",
          );
        } else {
          copyFileSync(join(fixturesDir, f), join(fixDir, f));
        }
      }
      const r = runCli([
        "--out",
        out,
        "--fixtures-dir",
        fixDir,
        "--verified-at",
        FIXED_AT,
        "--quiet",
      ]);
      assert.equal(r.status, 2, r.stderr);
      assert.equal(existsSync(out), false);
      assertNoSentinelLeak(r.stderr);
      assert.equal(r.stderr.includes("Bearer dummy"), false);
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("mixed verified + catalog rejected (synthetic hard-gate) exits 0 and keeps disqualification", async () => {
    const fixDir = mkdtempSync(join(tmpdir(), "adv-mixed-"));
    const outDir = mkdtempSync(join(tmpdir(), "adv-out-"));
    const out = join(outDir, "advisory-benchmark-report.json");
    try {
      for (const f of ADVISORY_GOLDEN_FILES) {
        if (f === "risk-tier.portable.bundle.json") {
          const base = deepClone(loadJson(join(fixturesDir, f)));
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
          base.evidence = evidence;
          const rebound = await rebindBundleDigests(base);
          writeFileSync(join(fixDir, f), `${JSON.stringify(rebound, null, 2)}\n`);
        } else {
          copyFileSync(join(fixturesDir, f), join(fixDir, f));
        }
      }
      const r = runCli([
        "--out",
        out,
        "--fixtures-dir",
        fixDir,
        "--verified-at",
        FIXED_AT,
        "--quiet",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(out));
      const report = parseJsonStrict(readFileSync(out, "utf8")) as {
        summary: { verified: number; rejected: number; error: number };
        rows: Array<{
          status: string;
          disqualifications: string[];
          fixtureFile: string;
        }>;
      };
      assert.equal(report.summary.error, 0);
      assert.ok(report.summary.rejected >= 1);
      assert.ok(report.summary.verified >= 1);
      const rejected = report.rows.find((row) => row.status === "rejected");
      assert.ok(rejected);
      assert.ok(rejected!.disqualifications.includes("execute_attempt"));
      assertNoSentinelLeak(JSON.stringify(report));
      assert.equal(
        JSON.stringify(report).includes("EXECUTE_ATTEMPT_HARD_FAILURE"),
        false,
      );
    } finally {
      rmSync(fixDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("advisory benchmark — CLI", () => {
  it("emits report JSON exit 0 for locked goldens", () => {
    const dir = mkdtempSync(join(tmpdir(), "adv-bench-"));
    const out = join(dir, "advisory-benchmark-report.json");
    try {
      const r = runCli([
        "--out",
        out,
        "--fixtures-dir",
        fixturesDir,
        "--verified-at",
        FIXED_AT,
        "--git-sha",
        "testsha",
        "--workflow-run-id",
        "42",
        "--quiet",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(out));
      const report = parseJsonStrict(readFileSync(out, "utf8")) as {
        advisory: boolean;
        promotionAuthority: boolean;
        executionAuthority: boolean;
        rows: unknown[];
        gitSha: string;
        workflowRunId: string;
      };
      assert.equal(report.advisory, true);
      assert.equal(report.promotionAuthority, false);
      assert.equal(report.executionAuthority, false);
      assert.equal(report.rows.length, 4);
      assert.equal(report.gitSha, "testsha");
      assert.equal(report.workflowRunId, "42");
      assertNoSentinelLeak(JSON.stringify(report));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("usage without --out exits 1", () => {
    const r = runCli(["--quiet"]);
    assert.equal(r.status, 1);
  });
});
