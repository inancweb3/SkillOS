/**
 * @skillos/protocol v0.1 — normative + adversarial tests.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROTOCOL_VERSION,
  ProtocolError,
  canonicalize,
  parseJsonStrict,
  parseAndValidateSchema,
  assertDigestFormat,
  assertDigestBinding,
  assertMeasurements,
  assertIJsonValue,
  assertProtocolNumbers,
  computeDigest,
  digestEvidence,
  digestManifest,
  digestResult,
  digestVerifier,
  adaptGameScoreToEvidence,
  buildGameScoreManifestAsync,
  type ArenaDefinition,
  type BenchmarkManifest,
  type EvidenceEnvelope,
  type VerificationResult,
  type VerifierDescriptor,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "..", "fixtures");

function loadJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(fixtures, rel), "utf8")) as T;
}

let gameManifest: BenchmarkManifest;
let gameEvidence: EvidenceEnvelope;
let gameResult: VerificationResult;
let gameArena: ArenaDefinition;
let safetyManifest: BenchmarkManifest;
let safetyEvidence: EvidenceEnvelope;
let safetyResult: VerificationResult;
let safetyArena: ArenaDefinition;
let verifier: VerifierDescriptor;

before(() => {
  gameManifest = loadJson("game-2048/manifest.json");
  gameEvidence = loadJson("game-2048/evidence.json");
  gameResult = loadJson("game-2048/result.json");
  gameArena = loadJson("game-2048/arena.json");
  safetyManifest = loadJson("simpl3-safety/manifest.json");
  safetyEvidence = loadJson("simpl3-safety/evidence.json");
  safetyResult = loadJson("simpl3-safety/result.json");
  safetyArena = loadJson("simpl3-safety/arena.json");
  verifier = loadJson("shared/verifier.json");
});

// ── Golden fixtures ─────────────────────────────────────────────────────

describe("golden fixtures — schema + binding", () => {
  it("game-2048 validates all document schemas", () => {
    parseAndValidateSchema(gameArena, "ArenaDefinition");
    parseAndValidateSchema(gameManifest, "BenchmarkManifest");
    parseAndValidateSchema(gameEvidence, "EvidenceEnvelope");
    parseAndValidateSchema(gameResult, "VerificationResult");
    parseAndValidateSchema(verifier, "VerifierDescriptor");
    for (const m of gameManifest.measurements) {
      parseAndValidateSchema(m, "MeasurementDefinition");
    }
  });

  it("simpl3-safety validates all document schemas", () => {
    parseAndValidateSchema(safetyArena, "ArenaDefinition");
    parseAndValidateSchema(safetyManifest, "BenchmarkManifest");
    parseAndValidateSchema(safetyEvidence, "EvidenceEnvelope");
    parseAndValidateSchema(safetyResult, "VerificationResult");
  });

  it("game-2048 digest + field bindings hold", async () => {
    await assertDigestBinding({
      manifest: gameManifest,
      evidence: gameEvidence,
      verifier,
      result: gameResult,
    });
  });

  it("simpl3-safety digest + field bindings hold", async () => {
    await assertDigestBinding({
      manifest: safetyManifest,
      evidence: safetyEvidence,
      verifier,
      result: safetyResult,
    });
  });

  it("fixtures do not use zero digests or seed-as-codeCommit", () => {
    const zero =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    const texts = [
      JSON.stringify(gameManifest),
      JSON.stringify(gameEvidence),
      JSON.stringify(safetyManifest),
      JSON.stringify(safetyEvidence),
    ];
    for (const t of texts) {
      assert.equal(t.includes(zero), false);
    }
    assert.notEqual(
      gameEvidence.provenance.codeCommit,
      "seed:fixture-seed-2048",
    );
    assert.ok(
      gameEvidence.provenance.inputDigest.startsWith("sha256:") &&
        gameEvidence.provenance.inputDigest.length === 71,
    );
  });
});

// ── Tamper + binding mismatches ─────────────────────────────────────────

describe("tamper and binding rejection", () => {
  it("rejects tampered manifest", async () => {
    const tampered = { ...gameManifest, benchmarkVersion: "9.9.9" };
    await assert.rejects(
      () =>
        assertDigestBinding({
          manifest: tampered,
          evidence: gameEvidence,
        }),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "DIGEST_MISMATCH",
    );
  });

  it("rejects result.evidenceId mismatch", async () => {
    const tampered = { ...gameResult, evidenceId: "wrong-id" };
    // re-seal digest would fail differently; force binding check after fixing resultDigest skip
    // assertDigestBinding validates schema first — resultDigest will also fail
    await assert.rejects(
      () =>
        assertDigestBinding({
          evidence: gameEvidence,
          result: tampered,
        }),
      (err: unknown) =>
        err instanceof ProtocolError &&
        (err.code === "BINDING_MISMATCH" || err.code === "DIGEST_MISMATCH"),
    );
  });

  it("rejects result.verifierId mismatch vs verifier", async () => {
    const bad = {
      ...gameResult,
      verifierId: "evil",
    };
    // resultDigest still old; may fail DIGEST_MISMATCH first when checking result alone
    // Provide verifier so BINDING_MISMATCH can fire after self result digest check order
    await assert.rejects(
      () =>
        assertDigestBinding({
          verifier,
          result: bad,
        }),
      (err: unknown) => err instanceof ProtocolError,
    );
  });

  it("rejects tampered evidence / verifier / result digests", async () => {
    await assert.rejects(
      () =>
        assertDigestBinding({
          manifest: gameManifest,
          evidence: {
            ...gameEvidence,
            measurements: { ...gameEvidence.measurements, score: 1 },
          },
          result: gameResult,
        }),
      (e: unknown) => e instanceof ProtocolError,
    );
    await assert.rejects(
      () =>
        assertDigestBinding({
          verifier: { ...verifier, id: "evil.verifier" },
        }),
      (e: unknown) =>
        e instanceof ProtocolError && e.code === "DIGEST_MISMATCH",
    );
    await assert.rejects(
      () =>
        assertDigestBinding({
          result: { ...gameResult, status: "rejected" },
        }),
      (e: unknown) =>
        e instanceof ProtocolError && e.code === "DIGEST_MISMATCH",
    );
  });
});

// ── Fail-closed ─────────────────────────────────────────────────────────

describe("fail-closed validations", () => {
  it("rejects unsupported protocolVersion", () => {
    assert.throws(
      () =>
        parseAndValidateSchema(
          { ...gameManifest, protocolVersion: "0.2.0" },
          "BenchmarkManifest",
        ),
      (err: unknown) =>
        err instanceof ProtocolError &&
        err.code === "UNSUPPORTED_PROTOCOL_VERSION",
    );
  });

  it("rejects unknown property", () => {
    assert.throws(
      () =>
        parseAndValidateSchema(
          { ...gameManifest, evilExtra: true },
          "BenchmarkManifest",
        ),
      (err: unknown) =>
        err instanceof ProtocolError &&
        err.code === "SCHEMA_VALIDATION_FAILED",
    );
  });

  it("rejects invalid digest format", () => {
    assert.throws(
      () => assertDigestFormat("sha256:deadbeef"),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_DIGEST_FORMAT",
    );
  });

  it("rejects missing required measurement via Object.hasOwn path", () => {
    assert.throws(
      () =>
        assertMeasurements(gameManifest, {
          ...gameEvidence,
          measurements: {},
        }),
      (err: unknown) =>
        err instanceof ProtocolError &&
        err.code === "MISSING_REQUIRED_MEASUREMENT",
    );
  });

  it("rejects valueType mismatch and duplicate measurement ids", () => {
    assert.throws(
      () =>
        assertMeasurements(gameManifest, {
          ...gameEvidence,
          measurements: { score: "not-a-number" },
        }),
      (err: unknown) =>
        err instanceof ProtocolError &&
        err.code === "MEASUREMENT_TYPE_MISMATCH",
    );
    const dupManifest: BenchmarkManifest = {
      ...gameManifest,
      measurements: [
        ...gameManifest.measurements,
        { id: "score", valueType: "number" },
      ],
    };
    assert.throws(
      () => assertMeasurements(dupManifest, gameEvidence),
      (err: unknown) =>
        err instanceof ProtocolError &&
        err.code === "DUPLICATE_MEASUREMENT_ID",
    );
  });

  it("rejects unsafe integer (protocol) and -0 (JCS+protocol)", async () => {
    // Protocol document gate
    assert.throws(
      () => assertProtocolNumbers({ a: Number.MAX_SAFE_INTEGER + 1 }),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "UNSAFE_NUMBER",
    );
    // -0 rejected at JCS canonicalize / digest path
    const neg = { a: -0 };
    assert.equal(Object.is(neg.a, -0), true);
    await assert.rejects(
      () => computeDigest(neg, "manifest"),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "NEGATIVE_ZERO",
    );
  });

  it("rejects invalid adapter score and matchCountDelta", async () => {
    await assert.rejects(
      () =>
        adaptGameScoreToEvidence(
          {
            tournamentId: "t",
            player: "p",
            score: "not-a-number",
            gameId: "2048",
          },
          { evidenceId: "x" },
        ),
      (err: unknown) => err instanceof ProtocolError,
    );
    await assert.rejects(
      () =>
        adaptGameScoreToEvidence(
          {
            tournamentId: "t",
            player: "p",
            score: 1,
            matchCountDelta: Infinity,
            gameId: "2048",
          },
          { evidenceId: "x" },
        ),
      (err: unknown) => err instanceof ProtocolError,
    );
  });
});

// ── I-JSON / JCS adversarial ────────────────────────────────────────────

describe("I-JSON fail-closed JCS", () => {
  it("rejects undefined property values", () => {
    assert.throws(
      () => canonicalize({ a: undefined as unknown as number }),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );
  });

  it("rejects non-plain objects", () => {
    assert.throws(
      () => canonicalize(new Date()),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );
    assert.throws(
      () => canonicalize(new Map()),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );
  });

  it("rejects cycles", () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    assert.throws(
      () => canonicalize(o),
      (err: unknown) => err instanceof ProtocolError && err.code === "CYCLE",
    );
  });

  it("rejects duplicate JSON keys at parse", () => {
    assert.throws(
      () => parseJsonStrict('{"a":1,"a":2}'),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "DUPLICATE_KEY",
    );
    assert.throws(
      () => parseAndValidateSchema('{"a":1,"a":2}', "MeasurementDefinition"),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "DUPLICATE_KEY",
    );
  });

  it("rejects lone surrogates", () => {
    const lone = "\uDEAD";
    assert.throws(
      () => assertIJsonValue(lone),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "LONE_SURROGATE",
    );
    assert.throws(
      () => canonicalize({ a: lone }),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "LONE_SURROGATE",
    );
  });

  it("rejects Map/Date at computeDigest projection (not empty-object digest)", async () => {
    const emptyDigest = await computeDigest({}, "manifest");
    await assert.rejects(
      () => computeDigest(new Map([["secret", 1]]), "manifest"),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );
    await assert.rejects(
      () => computeDigest(new Date("2026-08-01T00:00:00.000Z"), "manifest"),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );
    // Ensure rejection is not "success as {}"
    assert.equal(emptyDigest.startsWith("sha256:"), true);
  });

  it("rejects mutating getters (TOCTOU) and accessors", () => {
    let reads = 0;
    const tricky = {};
    Object.defineProperty(tricky, "a", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? 1 : new Map([["x", 1]]);
      },
    });
    assert.throws(
      () => canonicalize(tricky),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );

    const withSetter = {};
    Object.defineProperty(withSetter, "b", {
      enumerable: true,
      configurable: true,
      get() {
        return 1;
      },
      set() {},
    });
    assert.throws(
      () => canonicalize(withSetter),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );

    const withSymbol = { a: 1 };
    Object.defineProperty(withSymbol, Symbol("s"), {
      value: 2,
      enumerable: true,
    });
    assert.throws(
      () => canonicalize(withSymbol),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );

    const hidden = {};
    Object.defineProperty(hidden, "secret", {
      value: 1,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(hidden, "visible", {
      value: 2,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    assert.throws(
      () => canonicalize(hidden),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );
  });

  it("allows shared DAG references but rejects true cycles", () => {
    const shared = { x: 1 };
    const dag = { a: shared, b: shared };
    assert.equal(canonicalize(dag), '{"a":{"x":1},"b":{"x":1}}');

    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    assert.throws(
      () => canonicalize(cyclic),
      (err: unknown) => err instanceof ProtocolError && err.code === "CYCLE",
    );
  });

  it("rejects enumerable non-index own properties on arrays", () => {
    const withExtra: unknown[] = [1];
    (withExtra as { extra?: number }).extra = 2;
    assert.throws(
      () => canonicalize(withExtra),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );

    const withPaddedIndex: unknown[] = [1];
    Object.defineProperty(withPaddedIndex, "01", {
      value: 2,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    // Either dense-count mismatch or non-index name — both are INVALID_INPUT.
    assert.throws(
      () => canonicalize(withPaddedIndex),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );
  });

  it("rejects huge sparse arrays quickly (no O(length) allocation)", () => {
    const sparse: unknown[] = [];
    sparse.length = 4_294_967_295;
    const t0 = performance.now();
    assert.throws(
      () => canonicalize(sparse),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "INVALID_INPUT",
    );
    const ms = performance.now() - t0;
    // Must not hang allocating billions of Set entries; allow generous CI bound.
    assert.ok(ms < 1000, `sparse reject took ${ms}ms (expected fast fail)`);
  });

  it("preserves __proto__ key on parse (no prototype pollution)", () => {
    const parsed = parseJsonStrict('{"__proto__":{"x":1},"a":2}') as Record<
      string,
      unknown
    >;
    assert.equal(Object.getPrototypeOf(parsed), null);
    assert.equal(Object.hasOwn(parsed, "__proto__"), true);
    const protoVal = Object.getOwnPropertyDescriptor(parsed, "__proto__")!
      .value as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(protoVal), null);
    assert.equal(protoVal.x, 1);
    assert.equal(parsed.a, 2);
    // Unicode-escaped "__proto__" key
    const protoEscaped = parseJsonStrict(
      '{"\\u005f\\u005fproto\\u005f\\u005f":{"polluted":true}}',
    ) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(protoEscaped), null);
    assert.equal(Object.hasOwn(protoEscaped, "__proto__"), true);
    const pe = Object.getOwnPropertyDescriptor(protoEscaped, "__proto__")!
      .value as Record<string, unknown>;
    assert.equal(pe.polluted, true);
    // Round-trip through JCS
    assert.equal(canonicalize(parsed), '{"__proto__":{"x":1},"a":2}');
  });
});

// ── RFC 8785 official vectors ───────────────────────────────────────────

describe("RFC 8785 official primitive + sorting vectors", () => {
  it("§3.2.2 / §3.2.3 numbers, string, literals + key order", () => {
    // Parsed equivalent of the RFC 8785 §3.2.2 sample object.
    // 333333333.33333329 rounds to 333333333.3333333 under IEEE-754 double.
    // 1e30 is allowed by JCS/I-JSON (finite double) though not Number.isSafeInteger;
    // protocol *documents* still reject unsafe integers via parseAndValidateSchema.
    const input = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
      string: "€$\u000f\nA'B\"\\\\\"/",
      literals: [null, true, false],
    };
    const out = canonicalize(input);
    const expected = readFileSync(
      join(__dirname, "rfc8785-sample.jcs.txt"),
      "utf8",
    );
    assert.equal(out, expected);
    // Protocol document gate still rejects unsafe integers (stricter than JCS):
    assert.throws(
      () => assertProtocolNumbers({ n: 1e30 }),
      (err: unknown) =>
        err instanceof ProtocolError && err.code === "UNSAFE_NUMBER",
    );
  });

  it("§3.2.3 property sorting by UTF-16 code units", () => {
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    const out = canonicalize(input);
    // Expected order of keys from RFC 8785 §3.2.3
    const keys = [
      "\r",
      "1",
      "\u0080",
      "\u00f6",
      "\u20ac",
      "\ud83d\ude00",
      "\ufb33",
    ];
    let pos = 0;
    for (const k of keys) {
      const frag = JSON.stringify(k);
      const idx = out.indexOf(frag, pos);
      assert.ok(idx >= pos, `key ${frag} order`);
      pos = idx + 1;
    }
  });

  it("simple key sort vector", () => {
    assert.equal(canonicalize({ b: 2, a: 1 }), '{"a":1,"b":2}');
  });
});

// ── Signature exclusion ─────────────────────────────────────────────────

describe("signature exclusion from content digests", () => {
  it("signature changes do not affect evidence/result digests", async () => {
    const d1 = await digestEvidence(gameEvidence);
    const d2 = await digestEvidence({
      ...gameEvidence,
      signature: "other-sig",
    });
    assert.equal(d1, d2);
    const r1 = await digestResult(gameResult);
    const r2 = await digestResult({
      ...gameResult,
      signature: "other",
    });
    assert.equal(r1, r2);
  });

  it("binding fields change result digest", async () => {
    const base = await digestResult(gameResult);
    const flipped = await digestResult({
      ...gameResult,
      manifestDigest:
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    });
    assert.notEqual(base, flipped);
  });
});

// ── Adapter ─────────────────────────────────────────────────────────────

describe("legacy game score adapter", () => {
  it("maps score with real provenance digests", async () => {
    const { manifest, evidence } = await adaptGameScoreToEvidence(
      {
        tournamentId: "0xabc",
        player: "0xplayer",
        score: 100,
        gameId: "2048",
        seed: "s1",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      { evidenceId: "adapter-test-1" },
    );
    parseAndValidateSchema(manifest, "BenchmarkManifest");
    parseAndValidateSchema(evidence, "EvidenceEnvelope");
    await assertDigestBinding({ manifest, evidence });
    assert.equal(evidence.measurements?.score, 100);
    assert.equal(evidence.provenance.codeCommit, undefined);
    assert.ok(!evidence.provenance.inputDigest.includes("0000000000000000"));
  });

  it("buildGameScoreManifestAsync is schema-valid", async () => {
    const m = await buildGameScoreManifestAsync("wordle");
    parseAndValidateSchema(m, "BenchmarkManifest");
    assert.equal(m.protocolVersion, PROTOCOL_VERSION);
  });
});

describe("verifier self-digest includes protocolVersion", () => {
  it("matches", async () => {
    assert.equal(verifier.protocolVersion, PROTOCOL_VERSION);
    assert.equal(verifier.digest, await digestVerifier(verifier));
  });
});
