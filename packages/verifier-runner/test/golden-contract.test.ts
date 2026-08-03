/**
 * Cross-repo golden contract tests (ADR 0006).
 * Locks body keys, version pins, producer id, toolTrace allowlist,
 * golden digests + provenance metadata, and fail-closed tamper.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseJsonStrict } from "@skillos/protocol";
import {
  BUNDLE_TOOL_TRACE_FIELDS,
  EVAL_BUNDLE_PRODUCER_ID,
  EVAL_BUNDLE_VERSION,
  OFFLINE_EVAL_BUNDLE_BODY_KEYS,
  verifyPortableOfflineEvalBundle,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "../fixtures");
const lockPath = join(fixturesDir, "GOLDEN_LOCK.json");

/** ADR 0006 D2.1 normative body field list (order-sensitive). */
const ADR_BODY_KEYS = [
  "bundleVersion",
  "protocolVersion",
  "scenario",
  "producer",
  "decision",
  "hardFailure",
  "hardFailureCode",
  "pathStage",
  "pathOutcome",
  "logicalLatencyTotalMs",
  "provenance",
  "manifest",
  "manifestDigest",
  "evidence",
  "evidenceDigest",
  "toolTrace",
] as const;

const ADR_TOOL_TRACE_FIELDS = [
  "tool",
  "args",
  "ok",
  "errorCode",
  "logicalLatencyMs",
  "result",
] as const;

const LOCK_TOP_KEYS = [
  "lockVersion",
  "bundleVersion",
  "protocolVersion",
  "producerId",
  "producerCodeCommitNote",
  "source",
  "fixtures",
] as const;

const LOCK_SOURCE_KEYS = [
  "producerRepo",
  "producerMainRef",
  "consumerPackage",
  "privacy",
] as const;

/**
 * Machine-pinned provenance claims (exact equality; no prose/substrings).
 * Human explanation lives in fixtures/README.md.
 */
const LOCK_PRODUCER_REPO = "youngstar-eth/simpl3-monorepo";
/** codeCommit / producerMainRef are document-internal coherence only. */
const LOCK_PRODUCER_CODE_COMMIT_SEMANTICS = "coherence-only";
const LOCK_CONSUMER_PACKAGE = "@skillos/verifier-runner";
/** Synthetic offline eval scenarios only — no live user/portfolio/production data. */
const LOCK_PRIVACY = "synthetic-only";

const LOCK_ENTRY_KEYS = [
  "file",
  "scenarioId",
  "bundleDigest",
  "bundleVersion",
  "protocolVersion",
  "decision",
  "producerCodeCommit",
] as const;

type GoldenLockEntry = {
  file: string;
  scenarioId: string;
  bundleDigest: string;
  bundleVersion: string;
  protocolVersion: string;
  decision: string;
  producerCodeCommit: string;
};

type GoldenLock = {
  lockVersion: string;
  bundleVersion: string;
  protocolVersion: string;
  producerId: string;
  producerCodeCommitNote: string;
  source: {
    producerRepo: string;
    producerMainRef: string;
    consumerPackage: string;
    privacy: string;
  };
  fixtures: GoldenLockEntry[];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype ||
      Object.getPrototypeOf(v) === null)
  );
}

function assertExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = Object.keys(obj);
  for (const k of keys) {
    assert.ok(allowed.includes(k), `${label}: unexpected key "${k}"`);
  }
  for (const k of allowed) {
    assert.ok(Object.prototype.hasOwnProperty.call(obj, k), `${label}: missing key "${k}"`);
  }
}

function assertNonEmptyString(v: unknown, label: string): asserts v is string {
  assert.equal(typeof v, "string", `${label} must be string`);
  assert.ok((v as string).length > 0, `${label} must be non-empty`);
}

/**
 * Strict-parse GOLDEN_LOCK.json (protocol parseJsonStrict + closed schema).
 * Rejects unknown keys, missing fields, duplicate fixture filenames.
 */
function parseAndValidateLock(rawText: string): GoldenLock {
  const parsed = parseJsonStrict(rawText);
  assert.ok(isPlainObject(parsed), "GOLDEN_LOCK root must be a plain object");
  assertExactKeys(parsed, LOCK_TOP_KEYS, "GOLDEN_LOCK");

  assertNonEmptyString(parsed.lockVersion, "lockVersion");
  assert.equal(parsed.lockVersion, "0.1.0");
  assert.equal(parsed.bundleVersion, "0.1.0");
  assert.equal(parsed.protocolVersion, "0.1.0");
  assert.equal(parsed.producerId, EVAL_BUNDLE_PRODUCER_ID);
  assertNonEmptyString(parsed.producerCodeCommitNote, "producerCodeCommitNote");
  assert.equal(
    parsed.producerCodeCommitNote,
    LOCK_PRODUCER_CODE_COMMIT_SEMANTICS,
    "producerCodeCommitNote must be exact coherence-only enum",
  );

  assert.ok(isPlainObject(parsed.source), "source must be plain object");
  assertExactKeys(parsed.source, LOCK_SOURCE_KEYS, "source");
  for (const k of LOCK_SOURCE_KEYS) {
    assertNonEmptyString(parsed.source[k], `source.${k}`);
  }
  assert.equal(
    parsed.source.producerRepo,
    LOCK_PRODUCER_REPO,
    "source.producerRepo must match pinned producer repository id",
  );
  assert.equal(
    parsed.source.consumerPackage,
    LOCK_CONSUMER_PACKAGE,
    "source.consumerPackage must match this package",
  );
  assert.equal(
    parsed.source.privacy,
    LOCK_PRIVACY,
    "source.privacy must be exact synthetic-only classification",
  );

  assert.ok(Array.isArray(parsed.fixtures), "fixtures must be array");
  assert.ok(parsed.fixtures.length >= 2, "expect at least two locked goldens");

  const seenFiles = new Set<string>();
  const fixtures: GoldenLockEntry[] = [];
  for (let i = 0; i < parsed.fixtures.length; i += 1) {
    const rawUnknown: unknown = parsed.fixtures[i];
    assert.ok(
      isPlainObject(rawUnknown),
      `fixtures[${i}] must be plain object`,
    );
    const raw: Record<string, unknown> = rawUnknown;
    assertExactKeys(raw, LOCK_ENTRY_KEYS, `fixtures[${i}]`);
    for (const k of LOCK_ENTRY_KEYS) {
      assertNonEmptyString(raw[k], `fixtures[${i}].${k}`);
    }
    const file = raw.file as string;
    const scenarioId = raw.scenarioId as string;
    const bundleDigest = raw.bundleDigest as string;
    const bundleVersion = raw.bundleVersion as string;
    const protocolVersion = raw.protocolVersion as string;
    const decision = raw.decision as string;
    const producerCodeCommit = raw.producerCodeCommit as string;
    assert.equal(bundleVersion, "0.1.0");
    assert.equal(protocolVersion, "0.1.0");
    assert.match(
      bundleDigest,
      /^sha256:[0-9a-f]{64}$/,
      `fixtures[${i}].bundleDigest format`,
    );
    assert.ok(!seenFiles.has(file), `duplicate fixture file in lock: ${file}`);
    seenFiles.add(file);
    fixtures.push({
      file,
      scenarioId,
      bundleDigest,
      bundleVersion,
      protocolVersion,
      decision,
      producerCodeCommit,
    });
  }

  return {
    lockVersion: parsed.lockVersion as string,
    bundleVersion: parsed.bundleVersion as string,
    protocolVersion: parsed.protocolVersion as string,
    producerId: parsed.producerId as string,
    producerCodeCommitNote: parsed.producerCodeCommitNote as string,
    source: {
      producerRepo: parsed.source.producerRepo as string,
      producerMainRef: parsed.source.producerMainRef as string,
      consumerPackage: parsed.source.consumerPackage as string,
      privacy: parsed.source.privacy as string,
    },
    fixtures,
  };
}

function loadLock(): GoldenLock {
  return parseAndValidateLock(readFileSync(lockPath, "utf8"));
}

function loadFixture(file: string): Record<string, unknown> {
  return parseJsonStrict(
    readFileSync(join(fixturesDir, file), "utf8"),
  ) as Record<string, unknown>;
}

/** Bind lock entry fields to fixture body (fail closed on provenance drift). */
function assertEntryBoundToFixture(
  entry: GoldenLockEntry,
  bundle: Record<string, unknown>,
  sourceMainRef: string,
): void {
  assert.equal(bundle.bundleVersion, entry.bundleVersion);
  assert.equal(bundle.protocolVersion, entry.protocolVersion);
  assert.equal(bundle.bundleDigest, entry.bundleDigest);
  assert.equal(bundle.decision, entry.decision);

  const producer = bundle.producer as {
    id?: string;
    codeCommit?: string;
  };
  assert.equal(producer.id, EVAL_BUNDLE_PRODUCER_ID);
  assert.equal(producer.codeCommit, entry.producerCodeCommit);

  const provenance = bundle.provenance as { codeCommit?: string };
  assert.equal(provenance.codeCommit, entry.producerCodeCommit);

  const scenario = bundle.scenario as { scenarioId?: string };
  assert.equal(scenario.scenarioId, entry.scenarioId);

  // All fixtures in this pack share the documented producer main ref.
  assert.equal(
    entry.producerCodeCommit,
    sourceMainRef,
    `${entry.file}: producerCodeCommit must match source.producerMainRef`,
  );
}

describe("ADR 0006 contract pins", () => {
  it("OFFLINE_EVAL_BUNDLE_BODY_KEYS matches ADR D2.1 ordered list", () => {
    assert.deepEqual([...OFFLINE_EVAL_BUNDLE_BODY_KEYS], [...ADR_BODY_KEYS]);
  });

  it("BUNDLE_TOOL_TRACE_FIELDS matches ADR allowlist", () => {
    assert.deepEqual(
      [...BUNDLE_TOOL_TRACE_FIELDS],
      [...ADR_TOOL_TRACE_FIELDS],
    );
  });

  it("version and producer pins", () => {
    assert.equal(EVAL_BUNDLE_VERSION, "0.1.0");
    assert.equal(EVAL_BUNDLE_PRODUCER_ID, "simpl3.offline.eval-runner");
    const lock = loadLock();
    assert.equal(lock.bundleVersion, "0.1.0");
    assert.equal(lock.protocolVersion, "0.1.0");
    assert.equal(lock.producerId, EVAL_BUNDLE_PRODUCER_ID);
    assert.equal(lock.lockVersion, "0.1.0");
  });
});

describe("GOLDEN_LOCK integrity", () => {
  it("lock schema validates (closed keys + exact provenance pins)", () => {
    const lock = loadLock();
    assert.equal(lock.producerCodeCommitNote, LOCK_PRODUCER_CODE_COMMIT_SEMANTICS);
    assert.equal(lock.source.producerRepo, LOCK_PRODUCER_REPO);
    assert.equal(lock.source.consumerPackage, LOCK_CONSUMER_PACKAGE);
    assert.equal(lock.source.privacy, LOCK_PRIVACY);
  });

  it("lock and on-disk goldens are bijective", () => {
    const lock = loadLock();
    const locked = new Set(lock.fixtures.map((f) => f.file));
    const onDisk = readdirSync(fixturesDir).filter((n) =>
      n.endsWith(".portable.bundle.json"),
    );
    assert.ok(locked.size >= 2, "expect at least two locked goldens");
    for (const f of onDisk) {
      assert.ok(locked.has(f), `on-disk golden missing from lock: ${f}`);
    }
    for (const f of locked) {
      assert.ok(onDisk.includes(f), `lock entry missing on disk: ${f}`);
    }
  });

  it("every locked golden verifies and binds lock provenance to fixture", async () => {
    const lock = loadLock();
    for (const entry of lock.fixtures) {
      const bundle = loadFixture(entry.file);
      assertEntryBoundToFixture(entry, bundle, lock.source.producerMainRef);

      const r = await verifyPortableOfflineEvalBundle(bundle);
      assert.equal(r.ok, true, `${entry.file}: ${!r.ok ? r.reason : ""}`);
      if (!r.ok) continue;
      assert.equal(
        r.bundleDigest,
        entry.bundleDigest,
        `${entry.file} digest lock drift`,
      );
    }
  });

  it("rejects lock metadata drift (decision / producerMainRef / versions)", () => {
    const honest = JSON.parse(readFileSync(lockPath, "utf8")) as GoldenLock;
    const cases: Array<{ label: string; mutate: (l: GoldenLock) => void }> = [
      {
        label: "decision",
        mutate: (l) => {
          l.fixtures[0]!.decision = "attacker-decision";
        },
      },
      {
        label: "producerCodeCommit",
        mutate: (l) => {
          l.fixtures[0]!.producerCodeCommit =
            "0000000000000000000000000000000000000000";
        },
      },
      {
        label: "source.producerMainRef",
        mutate: (l) => {
          l.source.producerMainRef =
            "1111111111111111111111111111111111111111";
        },
      },
      {
        label: "entry.bundleVersion",
        mutate: (l) => {
          l.fixtures[0]!.bundleVersion = "9.9.9";
        },
      },
      {
        label: "lockVersion",
        mutate: (l) => {
          l.lockVersion = "9.9.9";
        },
      },
      {
        label: "duplicate file",
        mutate: (l) => {
          l.fixtures.push({ ...l.fixtures[0]! });
        },
      },
      {
        label: "unknown top key",
        mutate: (l) => {
          (l as unknown as Record<string, unknown>).extra = true;
        },
      },
      // P2-LOCK-SOURCE-CLAIMS-UNBOUND: exact provenance pins fail closed
      {
        label: "source.producerRepo",
        mutate: (l) => {
          l.source.producerRepo = "other-org/attacker-repo";
        },
      },
      {
        label: "producerCodeCommitNote",
        mutate: (l) => {
          l.producerCodeCommitNote = "externally-authenticated";
        },
      },
      {
        label: "source.privacy",
        mutate: (l) => {
          l.source.privacy = "not synthetic; contains live data";
        },
      },
    ];

    for (const c of cases) {
      const clone = structuredClone(honest);
      c.mutate(clone);
      const dir = mkdtempSync(join(tmpdir(), "golden-lock-"));
      const p = join(dir, "GOLDEN_LOCK.json");
      writeFileSync(p, JSON.stringify(clone));
      assert.throws(
        () => {
          // Re-validate as if this were the lock file content
          const text = readFileSync(p, "utf8");
          const lock = parseAndValidateLock(text);
          // For cases that pass schema but fail fixture bind:
          if (
            c.label === "decision" ||
            c.label === "producerCodeCommit" ||
            c.label === "source.producerMainRef"
          ) {
            const entry = lock.fixtures[0]!;
            const bundle = loadFixture(entry.file);
            assertEntryBoundToFixture(
              entry,
              bundle,
              lock.source.producerMainRef,
            );
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof Error, c.label);
          return true;
        },
        `expected fail for ${c.label}`,
      );
    }
  });

  it("fails closed when lock digest drifts without re-export", async () => {
    const lock = loadLock();
    const entry = lock.fixtures[0]!;
    const bundle = loadFixture(entry.file);
    const bad = {
      ...bundle,
      bundleDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    };
    const r = await verifyPortableOfflineEvalBundle(bad);
    assert.equal(r.ok, false);
    assert.notEqual(bad.bundleDigest, entry.bundleDigest);
  });
});

describe("golden tamper — fail closed without rebind", () => {
  it("rejects body field mutation under stale digests", async () => {
    const lock = loadLock();
    const entry = lock.fixtures.find((f) => f.file.includes("risk-tier"))!;
    const bundle = loadFixture(entry.file);
    const mutated = structuredClone(bundle) as Record<string, unknown>;
    mutated.decision = "attacker-decision";
    const r = await verifyPortableOfflineEvalBundle(mutated);
    assert.equal(r.ok, false);
  });

  it("rejects unknown top-level field on a golden", async () => {
    const lock = loadLock();
    const entry = lock.fixtures[0]!;
    const bundle = loadFixture(entry.file);
    const mutated = { ...bundle, diagnostic: { wallClockMs: 1 } };
    const r = await verifyPortableOfflineEvalBundle(mutated);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "BUNDLE_UNKNOWN_FIELD");
  });
});
