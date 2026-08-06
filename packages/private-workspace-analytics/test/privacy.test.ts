/**
 * ADR 0007 compliance tests — private workspace + analytics privacy foundations.
 * Includes leak-class and fail-closed export regressions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as pkg from "../src/index.js";
import {
  ALWAYS_PRIVATE_KEYS,
  FORBIDDEN_AUTHORITY_ACTIONS,
  IJSON_MAX_ARRAY_LENGTH,
  IJSON_MAX_DEPTH,
  IJSON_MAX_NODES,
  IJSON_MAX_PROPERTIES,
  IJSON_MAX_UTF8_BYTES,
  PRIVACY_CONTRACT_VERSION,
  attemptRawPrivateExport,
  buildAnalyticsSummary,
  containsSecretShaped,
  denyAuthorityAction,
  digestValue,
  digestWorkspaceId,
  encodeIJson,
  exportForSkillOSIngress,
  freezeExportPolicy,
  isAlwaysPrivateKey,
  isAuthorityActionForbidden,
  isSensitiveKey,
  isSecretValue,
  type ExportPolicy,
  type PrivateWorkspaceRecord,
} from "../src/index.js";

/** Dense zero array of given length (for node-budget tests). */
function zeros(n: number): number[] {
  return new Array(n).fill(0);
}

/** Object whose own keys hold dense zero arrays (node-heavy). */
function multiArrayBag(count: number, arrLen = IJSON_MAX_ARRAY_LENGTH): Record<string, number[]> {
  const o: Record<string, number[]> = {};
  for (let i = 0; i < count; i += 1) {
    o[`a${i}`] = zeros(arrLen);
  }
  return o;
}

function policy(
  fields: Record<string, "public" | "digest" | "aggregate" | "private">,
): ExportPolicy {
  return freezeExportPolicy({
    contractVersion: PRIVACY_CONTRACT_VERSION,
    fields,
  });
}

function workspace(
  fields: Record<string, unknown>,
  workspaceId = "ws-test-1",
): PrivateWorkspaceRecord {
  return { workspaceId, fields };
}

function mustDigest(value: unknown): string {
  const r = digestValue(value);
  if (!r.ok) {
    assert.fail(`digest failed: ${r.reason}`);
  }
  return r.digest;
}

describe("privacy contract pins", () => {
  it("exports contract version 0.1.0", () => {
    assert.equal(PRIVACY_CONTRACT_VERSION, "0.1.0");
  });

  it("always-private keys include portfolio and privateKey", () => {
    assert.ok(ALWAYS_PRIVATE_KEYS.includes("portfolio"));
    assert.ok(ALWAYS_PRIVATE_KEYS.includes("privateKey"));
    assert.ok(isAlwaysPrivateKey("portfolio"));
  });

  it("forbidden authority actions include execute and promotion", () => {
    assert.ok(FORBIDDEN_AUTHORITY_ACTIONS.includes("request_execute"));
    assert.ok(
      FORBIDDEN_AUTHORITY_ACTIONS.includes("issue_promotion_authorization"),
    );
    assert.ok(isAuthorityActionForbidden("request_execute"));
  });

  // AR-5 — inspection table must not advertise protection the gate lacks.
  it("inspection ALWAYS_PRIVATE_KEYS is a subset of enforcement (parity)", () => {
    for (const key of ALWAYS_PRIVATE_KEYS) {
      assert.equal(
        isAlwaysPrivateKey(key),
        true,
        `inspection key "${key}" must be enforced by isAlwaysPrivateKey`,
      );
    }
  });

  it("inspection FORBIDDEN_AUTHORITY_ACTIONS is a subset of enforcement (parity)", () => {
    for (const action of FORBIDDEN_AUTHORITY_ACTIONS) {
      assert.equal(
        isAuthorityActionForbidden(action),
        true,
        `inspection action "${action}" must be enforced by isAuthorityActionForbidden`,
      );
    }
  });
});

describe("happy-path SkillOS ingress export", () => {
  it("admits allowlisted public + digest fields only", () => {
    const pol = policy({
      suiteId: "public",
      scenarioBody: "digest",
      runCount: "aggregate",
    });
    const ws = workspace({
      suiteId: "offline-eval-v1",
      scenarioBody: { steps: 3, name: "alpha" },
      runCount: 12,
    });
    const d = exportForSkillOSIngress(ws, pol);
    assert.equal(d.admit, true);
    assert.equal(d.denyCode, null);
    assert.ok(d.export);
    assert.equal(d.export!.projected.suiteId, "offline-eval-v1");
    assert.equal(
      d.export!.projected.scenarioBody,
      mustDigest({ steps: 3, name: "alpha" }),
    );
    assert.equal(d.export!.projected.runCount, undefined);
    assert.deepEqual(d.export!.publicFields, ["suiteId"]);
    assert.deepEqual(d.export!.digestedFields, ["scenarioBody"]);
    assert.equal(d.workspaceIdDigest, digestWorkspaceId("ws-test-1"));
    // Must not leak raw scenario body.
    assert.equal(
      JSON.stringify(d.export).includes("alpha"),
      false,
    );
  });
});

describe("happy-path analytics summary", () => {
  it("emits aggregates and digests only; never authority", () => {
    const pol = policy({
      suiteId: "public",
      scenarioBody: "digest",
      runCount: "aggregate",
      passRate: "aggregate",
    });
    const ws = workspace({
      suiteId: "offline-eval-v1",
      scenarioBody: { steps: 3 },
      runCount: 12,
      passRate: 0.95,
    });
    const d = buildAnalyticsSummary(ws, pol);
    assert.equal(d.admit, true);
    assert.ok(d.summary);
    assert.equal(d.summary!.aggregates.runCount, 12);
    assert.equal(d.summary!.aggregates.passRate, 0.95);
    assert.equal(d.summary!.digests.suiteId, mustDigest("offline-eval-v1"));
    assert.equal(d.summary!.digests.scenarioBody, mustDigest({ steps: 3 }));
    // AR-2: provenance split distinguishes public vs digest classification.
    assert.deepEqual(d.summary!.publicDigestedFields, ["suiteId"]);
    assert.deepEqual(d.summary!.digestedFields, ["scenarioBody"]);
    // AR-3: hard-false flags cover full FORBIDDEN_AUTHORITY_ACTIONS set.
    assert.equal(d.summary!.grantsExecutionAuthority, false);
    assert.equal(d.summary!.grantsPromotionAuthority, false);
    assert.equal(d.summary!.grantsWalletAuthority, false);
    assert.equal(d.summary!.grantsFundedSpendAuthority, false);
    assert.equal(d.summary!.grantsControlPlaneAuthority, false);
    // Raw suite string must not appear as a free-text retained field.
    assert.equal(
      Object.prototype.hasOwnProperty.call(d.summary!.aggregates, "suiteId"),
      false,
    );
  });
});

describe("fail-closed — missing / invalid policy", () => {
  it("denies when policy is missing", () => {
    const d = exportForSkillOSIngress(workspace({ a: 1 }), null);
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "MISSING_POLICY");
    assert.equal(d.export, null);
  });

  it("denies when policy version mismatches", () => {
    const d = exportForSkillOSIngress(workspace({ a: 1 }), {
      contractVersion: "9.9.9",
      fields: { a: "public" },
    });
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
  });

  it("denies invalid workspace shape", () => {
    const d = exportForSkillOSIngress({ workspaceId: "", fields: {} }, policy({}));
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
  });
});

describe("fail-closed — unclassified field", () => {
  it("denies present field with no policy entry", () => {
    const d = exportForSkillOSIngress(
      workspace({ known: "ok", mystery: "leak?" }),
      policy({ known: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "UNCLASSIFIED_FIELD");
    assert.match(d.reason, /mystery/);
    assert.equal(d.export, null);
  });

  it("analytics also fails closed on unclassified", () => {
    const d = buildAnalyticsSummary(
      workspace({ mystery: 1 }),
      policy({ known: "aggregate" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "UNCLASSIFIED_FIELD");
  });
});

describe("fail-closed — private field", () => {
  it("denies policy-classified private fields", () => {
    const d = exportForSkillOSIngress(
      workspace({ notes: "local only" }),
      policy({ notes: "private" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "PRIVATE_FIELD");
    assert.equal(d.export, null);
  });
});

describe("fail-closed — always-private denylist (hostile public policy mutation)", () => {
  it("denies portfolio even if public policy claims public", () => {
    // Hostile: public inspection map is mutated / forged to claim public.
    const hostile = {
      contractVersion: PRIVACY_CONTRACT_VERSION,
      fields: {
        portfolio: "public" as const,
        suiteId: "public" as const,
      },
    };
    // Also mutate the public inspection export if possible.
    try {
      (ALWAYS_PRIVATE_KEYS as string[]).length = 0;
    } catch {
      // frozen array may throw; fine
    }

    const d = exportForSkillOSIngress(
      workspace({
        portfolio: { positions: [{ asset: "ETH", qty: 1.5 }] },
        suiteId: "ok",
      }),
      hostile,
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "PRIVATE_FIELD");
    assert.match(d.reason, /portfolio/);
    assert.equal(d.export, null);
    // Private matrix still holds regardless of public list mutation.
    assert.equal(isAlwaysPrivateKey("portfolio"), true);
  });

  it("denies privateKey even when classified digest in policy", () => {
    const d = exportForSkillOSIngress(
      workspace({
        privateKey: "0x" + "ab".repeat(32),
      }),
      policy({ privateKey: "digest" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "PRIVATE_FIELD");
  });
});

describe("fail-closed — secret-shaped public values", () => {
  it("denies Bearer token in public field", () => {
    const d = exportForSkillOSIngress(
      workspace({
        note: "Bearer supersecrettokenvalue99",
      }),
      policy({ note: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "SECRET_SHAPED_VALUE");
    assert.equal(d.export, null);
  });

  it("denies PEM private key in public field", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7\n-----END PRIVATE KEY-----";
    const d = exportForSkillOSIngress(
      workspace({ keyMaterial: pem }),
      policy({ keyMaterial: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "SECRET_SHAPED_VALUE");
  });

  it("denies nested sensitive key inside public object", () => {
    const d = exportForSkillOSIngress(
      workspace({
        meta: { password: "hunter2hunter2" },
      }),
      policy({ meta: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "SECRET_SHAPED_VALUE");
  });

  it("isSecretValue detects 64-hex key material", () => {
    assert.equal(isSecretValue("a".repeat(64)), true);
    assert.equal(isSecretValue("short"), false);
    assert.equal(isSensitiveKey("api_key"), true);
  });
});

describe("fail-closed — raw private export attempt", () => {
  it("attemptRawPrivateExport always denies", () => {
    const d = attemptRawPrivateExport(
      workspace({
        portfolio: { cash: 1_000_000 },
        privateKey: "0x" + "cd".repeat(32),
      }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "RAW_PRIVATE_EXPORT");
    assert.equal(d.export, null);
  });

  it("there is no success path that returns workspace.fields raw", () => {
    const pol = policy({ suiteId: "public" });
    const ws = workspace({ suiteId: "ok" });
    const d = exportForSkillOSIngress(ws, pol);
    assert.equal(d.admit, true);
    // Export shape is projected only — no `fields` bag.
    assert.equal(
      d.export !== null &&
        Object.prototype.hasOwnProperty.call(d.export, "fields"),
      false,
    );
    assert.ok(d.export && "projected" in d.export);
  });
});

describe("fail-closed — authority actions", () => {
  it("denies request_execute", () => {
    const r = denyAuthorityAction("request_execute");
    assert.equal(r.admit, false);
    assert.equal(r.denyCode, "EXPORT_AUTHORITY_FORBIDDEN");
  });

  it("denies issue_promotion_authorization", () => {
    const r = denyAuthorityAction("issue_promotion_authorization");
    assert.equal(r.admit, false);
    assert.equal(r.denyCode, "EXPORT_AUTHORITY_FORBIDDEN");
  });

  it("denies wallet_spend and x402_funded_spend", () => {
    assert.equal(
      denyAuthorityAction("wallet_spend").denyCode,
      "EXPORT_AUTHORITY_FORBIDDEN",
    );
    assert.equal(
      denyAuthorityAction("x402_funded_spend").denyCode,
      "EXPORT_AUTHORITY_FORBIDDEN",
    );
  });

  it("denies unknown authority action labels (fail closed)", () => {
    const r = denyAuthorityAction("grant_all_power");
    assert.equal(r.admit, false);
    assert.equal(r.denyCode, "EXPORT_AUTHORITY_FORBIDDEN");
  });
});

describe("fail-closed — aggregate type mismatch", () => {
  it("analytics rejects non-numeric aggregate", () => {
    const d = buildAnalyticsSummary(
      workspace({ runCount: "twelve" }),
      policy({ runCount: "aggregate" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "AGGREGATE_TYPE_MISMATCH");
  });
});

describe("digest path may one-way hash secret-shaped material", () => {
  it("admits digest of secret-shaped string without leaking raw", () => {
    const secret = "Bearer supersecrettokenvalue99";
    const d = exportForSkillOSIngress(
      workspace({ evidenceBlob: secret }),
      policy({ evidenceBlob: "digest" }),
    );
    assert.equal(d.admit, true);
    assert.equal(d.export!.projected.evidenceBlob, mustDigest(secret));
    assert.equal(JSON.stringify(d.export).includes("Bearer"), false);
    assert.equal(JSON.stringify(d.export).includes("supersecret"), false);
  });
});

describe("F-001 — top-level sensitive-key variants before policy", () => {
  const opaque = "opaque-credential-token-value-99";

  it("denies mixed-case Authorization under hostile public policy", () => {
    const d = exportForSkillOSIngress(
      workspace({ Authorization: opaque }),
      policy({ Authorization: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "PRIVATE_FIELD");
    assert.equal(d.export, null);
  });

  it("denies hyphen api-key under hostile public policy", () => {
    const d = exportForSkillOSIngress(
      workspace({ "api-key": opaque }),
      policy({ "api-key": "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "PRIVATE_FIELD");
    assert.equal(d.export, null);
  });

  it("denies underscore access_token under hostile digest policy", () => {
    const d = exportForSkillOSIngress(
      workspace({ access_token: opaque }),
      policy({ access_token: "digest" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "PRIVATE_FIELD");
    assert.equal(d.export, null);
  });

  it("denies API_KEY mixed case under hostile digest policy", () => {
    const d = exportForSkillOSIngress(
      workspace({ API_KEY: opaque }),
      policy({ API_KEY: "digest" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "PRIVATE_FIELD");
    assert.equal(d.export, null);
  });

  it("isSensitiveKey matches hyphen and mixed-case variants", () => {
    assert.equal(isSensitiveKey("api-key"), true);
    assert.equal(isSensitiveKey("Authorization"), true);
    assert.equal(isSensitiveKey("ACCESS_TOKEN"), true);
    assert.equal(isSensitiveKey("suiteId"), false);
  });
});

describe("F-002 — detached deep snapshot; post-admit mutation safe", () => {
  it("mutating original nested object after admit does not change export", () => {
    const nested: Record<string, unknown> = { label: "ok" };
    const arr: unknown[] = ["a", 1];
    const fields: Record<string, unknown> = { meta: nested, tags: arr };
    const d = exportForSkillOSIngress(
      workspace(fields),
      policy({ meta: "public", tags: "public" }),
    );
    assert.equal(d.admit, true);
    assert.ok(d.export);

    // Hostile post-admit mutation of caller-owned graph.
    nested.api_key = "leaked-secret-token-99";
    nested.portfolio = { cash: 1_000_000 };
    arr.push({ raw_trace: "unredacted" });
    (fields as { poison?: string }).poison = "should-not-appear";

    const projected = d.export!.projected;
    // Snapshots may use null-prototype maps; compare by JSON / own props.
    assert.equal(JSON.stringify(projected.meta), JSON.stringify({ label: "ok" }));
    assert.equal(JSON.stringify(projected.tags), JSON.stringify(["a", 1]));
    assert.equal(
      (projected.meta as Record<string, unknown>).label,
      "ok",
    );
    const json = JSON.stringify(d.export);
    assert.equal(json.includes("leaked-secret"), false);
    assert.equal(json.includes("api_key"), false);
    assert.equal(json.includes("portfolio"), false);
    assert.equal(json.includes("raw_trace"), false);
    assert.equal(json.includes("poison"), false);

    // Export is frozen — assignment must not stick.
    assert.throws(() => {
      (projected as Record<string, unknown>).meta = { hijacked: true };
    });
  });

  it("projected nested objects are not the same reference as caller input", () => {
    const nested = { label: "ok" };
    const d = exportForSkillOSIngress(
      workspace({ meta: nested }),
      policy({ meta: "public" }),
    );
    assert.equal(d.admit, true);
    assert.notEqual(d.export!.projected.meta, nested);
  });
});

describe("F-003 — own-property / null-proto; constructor toString __proto__", () => {
  it("absent constructor own field does not inherit Object.prototype", () => {
    // Workspace with only suiteId — must not auto-admit via prototype constructor.
    const d = exportForSkillOSIngress(
      workspace({ suiteId: "ok" }),
      policy({ suiteId: "public" }),
    );
    assert.equal(d.admit, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(d.export!.projected, "constructor"),
      false,
    );
  });

  it("own constructor field without policy is UNCLASSIFIED_FIELD", () => {
    const fields: Record<string, unknown> = { suiteId: "ok" };
    Object.defineProperty(fields, "constructor", {
      value: "attacker",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const d = exportForSkillOSIngress(
      workspace(fields),
      policy({ suiteId: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "UNCLASSIFIED_FIELD");
    assert.match(d.reason, /constructor/);
    assert.equal(d.export, null);
  });

  it("own toString field without policy is UNCLASSIFIED_FIELD", () => {
    const fields: Record<string, unknown> = { suiteId: "ok" };
    Object.defineProperty(fields, "toString", {
      value: "attacker",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const d = exportForSkillOSIngress(
      workspace(fields),
      policy({ suiteId: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "UNCLASSIFIED_FIELD");
    assert.match(d.reason, /toString/);
  });

  it("own __proto__ field with public policy admits detached string only", () => {
    const fields: Record<string, unknown> = {};
    Object.defineProperty(fields, "__proto__", {
      value: "safe-label",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const polFields: Record<string, "public"> = {};
    Object.defineProperty(polFields, "__proto__", {
      value: "public",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const d = exportForSkillOSIngress(
      workspace(fields),
      {
        contractVersion: PRIVACY_CONTRACT_VERSION,
        fields: polFields,
      },
    );
    assert.equal(d.admit, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(d.export!.projected, "__proto__"),
      true,
    );
    assert.equal(
      (d.export!.projected as Record<string, unknown>)["__proto__"],
      "safe-label",
    );
    // Must not have mutated Object.prototype.
    assert.equal(
      Object.prototype.hasOwnProperty.call(Object.prototype, "safe-label"),
      false,
    );
  });

  it("own constructor classified public admits without prototype pollution", () => {
    const fields: Record<string, unknown> = {};
    Object.defineProperty(fields, "constructor", {
      value: "payload",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const polFields: Record<string, "public"> = {};
    Object.defineProperty(polFields, "constructor", {
      value: "public",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const d = exportForSkillOSIngress(workspace(fields), {
      contractVersion: PRIVACY_CONTRACT_VERSION,
      fields: polFields,
    });
    assert.equal(d.admit, true);
    assert.equal(
      (d.export!.projected as Record<string, unknown>).constructor,
      "payload",
    );
  });
});

describe("F-004 — strict I-JSON digest domain", () => {
  it("rejects cyclic structures with INVALID_INPUT and no export", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const d = exportForSkillOSIngress(
      workspace({ body: cyclic }),
      policy({ body: "digest" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);
    assert.match(d.reason, /cyclic|I-JSON/i);
  });

  it("rejects accessor properties with INVALID_INPUT", () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "x", {
      get() {
        return "invoked";
      },
      enumerable: true,
    });
    const d = exportForSkillOSIngress(
      workspace({ body: obj }),
      policy({ body: "digest" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);
  });

  it("rejects exotic Date with INVALID_INPUT", () => {
    const d = exportForSkillOSIngress(
      workspace({ body: new Date(0) }),
      policy({ body: "digest" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
  });

  it("rejects non-finite numbers without coercing to shared null digest", () => {
    const dNaN = exportForSkillOSIngress(
      workspace({ body: Number.NaN }),
      policy({ body: "digest" }),
    );
    assert.equal(dNaN.admit, false);
    assert.equal(dNaN.denyCode, "INVALID_INPUT");

    const dNull = exportForSkillOSIngress(
      workspace({ body: null }),
      policy({ body: "digest" }),
    );
    assert.equal(dNull.admit, true);
    // null is valid I-JSON — digest must not equal a coerced NaN path.
    const rNull = digestValue(null);
    const rNaN = digestValue(Number.NaN);
    assert.equal(rNull.ok, true);
    assert.equal(rNaN.ok, false);
  });

  it("rejects bigint / function / undefined without shared encoding", () => {
    for (const body of [10n, () => 1, undefined] as unknown[]) {
      const d = exportForSkillOSIngress(
        workspace({ body }),
        policy({ body: "digest" }),
      );
      assert.equal(d.admit, false, `expected deny for ${String(body)}`);
      assert.equal(d.denyCode, "INVALID_INPUT");
      assert.equal(d.export, null);
    }
  });

  it("encodeIJson does not collapse distinct invalid types to the same success", () => {
    assert.equal(encodeIJson(Number.NaN).ok, false);
    assert.equal(encodeIJson(undefined).ok, false);
    assert.equal(encodeIJson(10n).ok, false);
    assert.equal(encodeIJson(null).ok, true);
  });

  it("analytics also rejects cyclic digest fields", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const d = buildAnalyticsSummary(
      workspace({ body: cyclic }),
      policy({ body: "digest" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.summary, null);
  });
});

describe("F-005 — atomic snapshot-then-scan (no second live walk)", () => {
  it("stateful Proxy that flips keys between ownKeys calls never emits secret", () => {
    let ownKeysCalls = 0;
    const nested = new Proxy(
      {},
      {
        ownKeys() {
          ownKeysCalls += 1;
          if (ownKeysCalls === 1) {
            // First reflective capture looks safe.
            return ["label"];
          }
          // Later capture injects a sensitive key — must not be emitted raw.
          return ["label", "api_key"];
        },
        getOwnPropertyDescriptor(_t, prop) {
          if (prop === "label") {
            return {
              value: "ok",
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          if (prop === "api_key") {
            return {
              value: "super-secret-token-value-99",
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return undefined;
        },
        getPrototypeOf() {
          return Object.prototype;
        },
      },
    );

    const d = exportForSkillOSIngress(
      workspace({ body: nested }),
      policy({ body: "public" }),
    );
    // Snapshot-then-scan: inconsistent multi-pass reflection fails closed, or
    // a single safe snapshot admits without secret material — never both.
    assert.equal(JSON.stringify(d).includes("super-secret"), false);
    if (d.admit) {
      assert.ok(d.export);
      assert.equal(
        JSON.stringify(d.export!.projected.body),
        JSON.stringify({ label: "ok" }),
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          d.export!.projected.body as object,
          "api_key",
        ),
        false,
      );
    } else {
      assert.equal(d.export, null);
      assert.ok(
        d.denyCode === "INVALID_INPUT" || d.denyCode === "SECRET_SHAPED_VALUE",
        `unexpected denyCode ${d.denyCode}`,
      );
    }
  });

  it("stateful Proxy flipping values across descriptor reads never admits secret", () => {
    let reads = 0;
    const nested = new Proxy(
      {},
      {
        ownKeys() {
          return ["label"];
        },
        getPrototypeOf() {
          return Object.prototype;
        },
        getOwnPropertyDescriptor(_t, prop) {
          if (prop !== "label") return undefined;
          reads += 1;
          // First capture: safe. Any subsequent capture: secret-shaped string.
          const value =
            reads === 1
              ? "safe-label"
              : "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
          return {
            value,
            writable: true,
            enumerable: true,
            configurable: true,
          };
        },
      },
    );

    const d = exportForSkillOSIngress(
      workspace({ body: nested }),
      policy({ body: "public" }),
    );
    // Single encode binds scan+emit. Never place raw secret in projection.
    const json = JSON.stringify(d);
    assert.equal(json.includes("Bearer"), false);
    assert.equal(json.includes("eyJhbGci"), false);
    if (d.admit) {
      assert.equal(
        JSON.stringify(d.export!.projected.body),
        JSON.stringify({ label: "safe-label" }),
      );
    } else {
      assert.equal(d.export, null);
      assert.ok(
        d.denyCode === "INVALID_INPUT" || d.denyCode === "SECRET_SHAPED_VALUE",
      );
    }
  });
});

describe("F-006 — outer accessors / hostile reflection → structured INVALID_INPUT", () => {
  it("outer workspace getters are never invoked", () => {
    let workspaceIdGets = 0;
    let fieldsGets = 0;
    const fields = { suiteId: "ok" };
    const ws: Record<string, unknown> = {};
    Object.defineProperty(ws, "workspaceId", {
      get() {
        workspaceIdGets += 1;
        return "ws-getter";
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(ws, "fields", {
      get() {
        fieldsGets += 1;
        return fields;
      },
      enumerable: true,
      configurable: true,
    });

    const d = exportForSkillOSIngress(ws, policy({ suiteId: "public" }));
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);
    assert.equal(workspaceIdGets, 0, "workspaceId getter must not run");
    assert.equal(fieldsGets, 0, "fields getter must not run");
  });

  it("outer policy getters are never invoked", () => {
    let versionGets = 0;
    let fieldsGets = 0;
    const pol: Record<string, unknown> = {};
    Object.defineProperty(pol, "contractVersion", {
      get() {
        versionGets += 1;
        return PRIVACY_CONTRACT_VERSION;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(pol, "fields", {
      get() {
        fieldsGets += 1;
        return { suiteId: "public" };
      },
      enumerable: true,
      configurable: true,
    });

    const d = exportForSkillOSIngress(
      workspace({ suiteId: "ok" }),
      pol,
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);
    assert.equal(versionGets, 0);
    assert.equal(fieldsGets, 0);
  });

  it("throwing Proxy at workspace position returns structured denial (no throw)", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("boom-proto");
        },
        ownKeys() {
          throw new Error("boom-keys");
        },
        getOwnPropertyDescriptor() {
          throw new Error("boom-desc");
        },
      },
    );
    assert.doesNotThrow(() => {
      const d = exportForSkillOSIngress(hostile, policy({}));
      assert.equal(d.admit, false);
      assert.equal(d.denyCode, "INVALID_INPUT");
      assert.equal(d.export, null);
    });
  });

  it("throwing Proxy at policy position returns structured denial (no throw)", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("boom-proto");
        },
        ownKeys() {
          throw new Error("boom-keys");
        },
        getOwnPropertyDescriptor() {
          throw new Error("boom-desc");
        },
      },
    );
    assert.doesNotThrow(() => {
      const d = exportForSkillOSIngress(workspace({ a: 1 }), hostile);
      assert.equal(d.admit, false);
      assert.ok(
        d.denyCode === "INVALID_INPUT" || d.denyCode === "MISSING_POLICY",
      );
      assert.equal(d.export, null);
    });
  });

  it("throwing nested field Proxy returns structured denial with no export", () => {
    const nested = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("nested-proto");
        },
        getOwnPropertyDescriptor() {
          throw new Error("nested-desc");
        },
        ownKeys() {
          throw new Error("nested-keys");
        },
      },
    );
    assert.doesNotThrow(() => {
      const d = exportForSkillOSIngress(
        workspace({ body: nested }),
        policy({ body: "public" }),
      );
      assert.equal(d.admit, false);
      assert.equal(d.denyCode, "INVALID_INPUT");
      assert.equal(d.export, null);
    });
  });

  it("throwing array Proxy returns structured denial with no summary", () => {
    const arr = new Proxy([] as unknown[], {
      getOwnPropertyDescriptor() {
        throw new Error("arr-desc");
      },
      ownKeys() {
        throw new Error("arr-keys");
      },
    });
    assert.doesNotThrow(() => {
      const d = buildAnalyticsSummary(
        workspace({ body: arr }),
        policy({ body: "digest" }),
      );
      assert.equal(d.admit, false);
      assert.equal(d.denyCode, "INVALID_INPUT");
      assert.equal(d.summary, null);
    });
  });

  it("revoked Proxy at field position returns structured denial", () => {
    const target = { label: "x" };
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    assert.doesNotThrow(() => {
      const d = exportForSkillOSIngress(
        workspace({ body: proxy }),
        policy({ body: "public" }),
      );
      assert.equal(d.admit, false);
      assert.equal(d.denyCode, "INVALID_INPUT");
      assert.equal(d.export, null);
    });
  });
});

describe("F-007 — fail-closed array / depth caps (no truncation)", () => {
  it("array length at cap encodes successfully", () => {
    const arr = new Array(IJSON_MAX_ARRAY_LENGTH);
    for (let i = 0; i < IJSON_MAX_ARRAY_LENGTH; i += 1) {
      arr[i] = i % 7;
    }
    const enc = encodeIJson(arr);
    assert.equal(enc.ok, true);
    if (enc.ok) {
      assert.equal((enc.snapshot as unknown[]).length, IJSON_MAX_ARRAY_LENGTH);
    }
  });

  it("array length cap+1 is INVALID_INPUT with no export", () => {
    const arr = new Array(IJSON_MAX_ARRAY_LENGTH + 1);
    for (let i = 0; i < IJSON_MAX_ARRAY_LENGTH + 1; i += 1) {
      arr[i] = 0;
    }
    const enc = encodeIJson(arr);
    assert.equal(enc.ok, false);
    if (!enc.ok) {
      assert.match(enc.reason, /array length exceeds cap/i);
    }

    const d = exportForSkillOSIngress(
      workspace({ body: arr }),
      policy({ body: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);
    assert.match(d.reason, /array length exceeds cap|public projection rejected/i);
  });

  it("arrays differing only after the cap never share a successful digest", () => {
    const a = new Array(IJSON_MAX_ARRAY_LENGTH + 1);
    const b = new Array(IJSON_MAX_ARRAY_LENGTH + 1);
    for (let i = 0; i < IJSON_MAX_ARRAY_LENGTH + 1; i += 1) {
      a[i] = 1;
      b[i] = 1;
    }
    a[IJSON_MAX_ARRAY_LENGTH] = 99;
    b[IJSON_MAX_ARRAY_LENGTH] = 100;

    const da = digestValue(a);
    const db = digestValue(b);
    // Both must fail closed — never succeed with a shared truncated digest.
    assert.equal(da.ok, false);
    assert.equal(db.ok, false);

    // At-cap dense prefixes that differ after cap must not be hashable as success
    // via truncation either: the full over-cap input is rejected wholesale.
    const dExportA = exportForSkillOSIngress(
      workspace({ body: a }),
      policy({ body: "digest" }),
    );
    const dExportB = exportForSkillOSIngress(
      workspace({ body: b }),
      policy({ body: "digest" }),
    );
    assert.equal(dExportA.admit, false);
    assert.equal(dExportB.admit, false);
    assert.equal(dExportA.export, null);
    assert.equal(dExportB.export, null);
  });

  it("nesting deeper than depth cap is INVALID_INPUT", () => {
    let cur: unknown = 1;
    for (let i = 0; i < IJSON_MAX_DEPTH + 2; i += 1) {
      cur = { n: cur };
    }
    const enc = encodeIJson(cur);
    assert.equal(enc.ok, false);
    if (!enc.ok) {
      assert.match(enc.reason, /depth exceeds cap/i);
    }
    const d = exportForSkillOSIngress(
      workspace({ body: cur }),
      policy({ body: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);
  });
});

describe("F-007 residual — request-wide budgets + non-injectable public encoder", () => {
  it("per-value node count at budget boundary can succeed; cap+1 fails", () => {
    // 4 × (array 10000) ≈ 40005 nodes — under IJSON_MAX_NODES (50000).
    const atCap = multiArrayBag(4);
    const okEnc = encodeIJson(atCap);
    assert.equal(okEnc.ok, true, "4 dense arrays must fit under node cap");

    // 5 × (array 10000) ≈ 50011 nodes — over.
    const over = multiArrayBag(5);
    const badEnc = encodeIJson(over);
    assert.equal(badEnc.ok, false);
    if (!badEnc.ok) {
      assert.match(badEnc.reason, /node count exceeds cap/i);
    }
  });

  it("cross-field node budget is shared (no per-digestValue reset)", () => {
    // Each field alone is under the cap; both together exceed.
    const heavy = multiArrayBag(3); // ~30004 nodes per field
    const fields: Record<string, unknown> = {
      f1: heavy,
      f2: multiArrayBag(3),
    };
    const pol = policy({ f1: "digest", f2: "digest" });

    // Single field still admits.
    const one = exportForSkillOSIngress(
      workspace({ f1: multiArrayBag(3) }),
      policy({ f1: "digest" }),
    );
    assert.equal(one.admit, true, "single heavy digest field must admit");

    const both = exportForSkillOSIngress(workspace(fields), pol);
    assert.equal(both.admit, false);
    assert.equal(both.denyCode, "INVALID_INPUT");
    assert.equal(both.export, null);
    assert.match(both.reason, /node count exceeds cap|digest rejected/i);

    const bothAnalytics = buildAnalyticsSummary(workspace(fields), pol);
    assert.equal(bothAnalytics.admit, false);
    assert.equal(bothAnalytics.denyCode, "INVALID_INPUT");
    assert.equal(bothAnalytics.summary, null);
  });

  it("oversized string UTF-8 byte cap fails closed (encode + export + analytics)", () => {
    const huge = "x".repeat(IJSON_MAX_UTF8_BYTES + 1);
    const enc = encodeIJson(huge);
    assert.equal(enc.ok, false);
    if (!enc.ok) {
      assert.match(enc.reason, /UTF-8 byte count exceeds cap/i);
    }

    const d = exportForSkillOSIngress(
      workspace({ body: huge }),
      policy({ body: "digest" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);

    const a = buildAnalyticsSummary(
      workspace({ body: huge }),
      policy({ body: "digest" }),
    );
    assert.equal(a.admit, false);
    assert.equal(a.denyCode, "INVALID_INPUT");
    assert.equal(a.summary, null);
  });

  it("multi-field cumulative UTF-8 byte budget is shared", () => {
    const half = "y".repeat(Math.floor(IJSON_MAX_UTF8_BYTES / 2) + 2_000);
    // Each alone may succeed; together must exceed.
    const one = exportForSkillOSIngress(
      workspace({ s1: half }),
      policy({ s1: "digest" }),
    );
    assert.equal(one.admit, true);

    const both = exportForSkillOSIngress(
      workspace({ s1: half, s2: half }),
      policy({ s1: "digest", s2: "digest" }),
    );
    assert.equal(both.admit, false);
    assert.equal(both.denyCode, "INVALID_INPUT");
    assert.equal(both.export, null);
    assert.match(both.reason, /UTF-8 byte count exceeds cap|digest rejected/i);

    const bothA = buildAnalyticsSummary(
      workspace({ s1: half, s2: half }),
      policy({ s1: "digest", s2: "digest" }),
    );
    assert.equal(bothA.admit, false);
    assert.equal(bothA.summary, null);
  });

  it("workspace/policy property cap fails closed with no export", () => {
    // Fields + matching policy entries charge properties twice (fields map +
    // policy.fields map) plus shell keys — exceed IJSON_MAX_PROPERTIES.
    const n = Math.floor(IJSON_MAX_PROPERTIES / 2) + 20;
    const fields: Record<string, unknown> = {};
    const polFields: Record<string, "digest"> = {};
    for (let i = 0; i < n; i += 1) {
      const k = `f${i}`;
      fields[k] = i;
      polFields[k] = "digest";
    }
    const d = exportForSkillOSIngress(workspace(fields), policy(polFields));
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);
    assert.match(d.reason, /property count exceeds cap/i);
  });

  it("public encodeIJson ignores hostile extra args (caps not weakenable)", () => {
    let deep: unknown = 1;
    for (let i = 0; i < IJSON_MAX_DEPTH + 2; i += 1) {
      deep = { n: deep };
    }
    // Hostile: negative depth and negative node counter must not bypass depth cap.
    const hostileBudget = { nodes: -1_000_000, bytes: -1_000_000, properties: -1_000_000 };
    const viaPublic = encodeIJson(
      deep,
      new WeakSet(),
      -999,
      hostileBudget,
    );
    assert.equal(viaPublic.ok, false);
    if (!viaPublic.ok) {
      assert.match(viaPublic.reason, /depth exceeds cap/i);
    }

    const overArr = zeros(IJSON_MAX_ARRAY_LENGTH + 1);
    const viaPublicArr = encodeIJson(overArr, null, 0, { nodes: 0 });
    assert.equal(viaPublicArr.ok, false);
    if (!viaPublicArr.ok) {
      assert.match(viaPublicArr.reason, /array length exceeds cap/i);
    }

    // Public digestValue likewise ignores extra args.
    const dig = digestValue(deep, new WeakSet(), -1, { nodes: -99 });
    assert.equal(dig.ok, false);
  });

  it("request-wide node budget accumulates across fields (no public budget API)", () => {
    // Each field alone is under the cap; both together exceed — proves shared
    // internal budget without exposing createResourceBudget / *WithBudget.
    const fields = {
      a: multiArrayBag(3),
      b: multiArrayBag(3),
    };
    const pol = policy({ a: "digest", b: "digest" });
    const one = exportForSkillOSIngress(
      workspace({ a: multiArrayBag(3) }),
      policy({ a: "digest" }),
    );
    assert.equal(one.admit, true);

    const both = exportForSkillOSIngress(workspace(fields), pol);
    assert.equal(both.admit, false);
    assert.equal(both.denyCode, "INVALID_INPUT");
    assert.equal(both.export, null);
    assert.match(both.reason, /node count exceeds cap|digest rejected/i);
  });

  it("export and analytics both deny over-budget with no artifact", () => {
    const fields = {
      a: multiArrayBag(3),
      b: multiArrayBag(3),
    };
    const pol = policy({ a: "public", b: "public" });
    const exp = exportForSkillOSIngress(workspace(fields), pol);
    assert.equal(exp.admit, false);
    assert.equal(exp.export, null);
    assert.equal(exp.denyCode, "INVALID_INPUT");

    const ana = buildAnalyticsSummary(workspace(fields), pol);
    assert.equal(ana.admit, false);
    assert.equal(ana.summary, null);
    assert.equal(ana.denyCode, "INVALID_INPUT");
  });
});

describe("F-007A — public root has no forgeable budget surface", () => {
  it("package root does not export budget construction or WithBudget helpers", () => {
    const root = pkg as Record<string, unknown>;
    for (const name of [
      "createResourceBudget",
      "encodeIJsonWithBudget",
      "digestValueWithBudget",
      "chargeOwnPropertyNames",
      "ResourceBudget",
    ]) {
      assert.equal(
        name in root,
        false,
        `package root must not export ${name}`,
      );
      assert.equal(root[name], undefined, `${name} must be undefined on root`);
    }
    // Public one-arg surface remains.
    assert.equal(typeof pkg.encodeIJson, "function");
    assert.equal(typeof pkg.digestValue, "function");
    assert.equal(typeof pkg.digestWorkspaceId, "function");
  });

  it("digestWorkspaceId is one-arg only (extra budget arg ignored)", () => {
    const hostile = {
      nodes: -1_000_000,
      bytes: -1_000_000,
      properties: -1_000_000,
    };
    // Runtime extra arg must not be accepted as shared budget authority.
    const a = digestWorkspaceId("ws-test-1");
    const b = (digestWorkspaceId as (id: string, ...rest: unknown[]) => string)(
      "ws-test-1",
      hostile,
    );
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("digestWorkspaceId throws deliberately on non-I-JSON (AR-4)", () => {
    // Public helper fails loud (like canonicalJson); gates use structured Results.
    assert.throws(
      () => digestWorkspaceId(undefined as unknown as string),
      /workspaceId digest failed/,
    );
  });
});

describe("F-007B — array named/symbol own keys fail closed", () => {
  function arrayWithNamedOwn(namedCount: number, keyPrefix = "x"): unknown[] {
    const arr: unknown[] = [];
    for (let i = 0; i < namedCount; i += 1) {
      Object.defineProperty(arr, `${keyPrefix}${i}`, {
        value: i,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return arr;
  }

  it("array with one named own property is rejected (encode + export + analytics)", () => {
    const arr = [1, 2];
    Object.defineProperty(arr, "extra", {
      value: "hidden",
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const enc = encodeIJson(arr);
    assert.equal(enc.ok, false);
    if (!enc.ok) {
      assert.match(enc.reason, /array own properties|dense indices|not I-JSON/i);
    }

    const dig = digestValue(arr);
    assert.equal(dig.ok, false);

    const exp = exportForSkillOSIngress(
      workspace({ body: arr }),
      policy({ body: "public" }),
    );
    assert.equal(exp.admit, false);
    assert.equal(exp.denyCode, "INVALID_INPUT");
    assert.equal(exp.export, null);

    const ana = buildAnalyticsSummary(
      workspace({ body: arr }),
      policy({ body: "digest" }),
    );
    assert.equal(ana.admit, false);
    assert.equal(ana.denyCode, "INVALID_INPUT");
    assert.equal(ana.summary, null);
  });

  it("arrays differing only in an extra own property never both succeed", () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3];
    Object.defineProperty(b, "tag", {
      value: 99,
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const da = digestValue(a);
    const db = digestValue(b);
    assert.equal(da.ok, true, "plain dense array must encode");
    assert.equal(db.ok, false, "named own property must fail closed");
    // Successful digest of a must not equal any success path for b.
    if (da.ok) {
      assert.notEqual(da.digest, undefined);
    }

    const expA = exportForSkillOSIngress(
      workspace({ body: a }),
      policy({ body: "digest" }),
    );
    const expB = exportForSkillOSIngress(
      workspace({ body: b }),
      policy({ body: "digest" }),
    );
    assert.equal(expA.admit, true);
    assert.equal(expB.admit, false);
    assert.equal(expB.export, null);
  });

  it("named own-property count over property cap fails before success", () => {
    // Empty dense array + named extras exceeding IJSON_MAX_PROPERTIES.
    const over = arrayWithNamedOwn(IJSON_MAX_PROPERTIES + 1);
    const enc = encodeIJson(over);
    assert.equal(enc.ok, false);
    if (!enc.ok) {
      assert.match(
        enc.reason,
        /property count exceeds cap|array own properties|not I-JSON/i,
      );
    }

    const d = exportForSkillOSIngress(
      workspace({ body: over }),
      policy({ body: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);

    const a = buildAnalyticsSummary(
      workspace({ body: over }),
      policy({ body: "digest" }),
    );
    assert.equal(a.admit, false);
    assert.equal(a.summary, null);
  });

  it("oversized named own-property key bytes fail closed", () => {
    const arr: unknown[] = [];
    const hugeKey = "k".repeat(IJSON_MAX_UTF8_BYTES + 1);
    Object.defineProperty(arr, hugeKey, {
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const enc = encodeIJson(arr);
    assert.equal(enc.ok, false);
    if (!enc.ok) {
      assert.match(
        enc.reason,
        /UTF-8 byte count exceeds cap|array own properties|not I-JSON/i,
      );
    }
    const d = exportForSkillOSIngress(
      workspace({ body: arr }),
      policy({ body: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.export, null);
  });

  it("symbol own keys on arrays fail closed with no export/summary", () => {
    const arr: unknown[] = [0];
    const sym = Symbol("hidden");
    Object.defineProperty(arr, sym, {
      value: "secret",
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const enc = encodeIJson(arr);
    assert.equal(enc.ok, false);
    if (!enc.ok) {
      assert.match(enc.reason, /symbol own properties/i);
    }

    const dig = digestValue(arr);
    assert.equal(dig.ok, false);

    const exp = exportForSkillOSIngress(
      workspace({ body: arr }),
      policy({ body: "public" }),
    );
    assert.equal(exp.admit, false);
    assert.equal(exp.denyCode, "INVALID_INPUT");
    assert.equal(exp.export, null);

    const ana = buildAnalyticsSummary(
      workspace({ body: arr }),
      policy({ body: "digest" }),
    );
    assert.equal(ana.admit, false);
    assert.equal(ana.summary, null);
  });

  it("stateful array Proxy: symbol on first ownKeys hidden later — deny + exactly one source ownKeys", () => {
    // F-007B residual TOCTOU: getOwnPropertyDescriptors already captures the
    // symbol; a second getOwnPropertySymbols(value) would see ownKeys without
    // it and could fail open. Encoder must use the descriptor snapshot only.
    const sym = Symbol("toctou");
    const target: unknown[] = [1];
    Object.defineProperty(target, sym, {
      value: "attacker-data",
      enumerable: true,
      writable: true,
      configurable: true,
    });

    let ownKeysCalls = 0;
    const proxy = new Proxy(target, {
      ownKeys(t) {
        ownKeysCalls += 1;
        const keys = Reflect.ownKeys(t);
        if (ownKeysCalls === 1) {
          return keys; // expose configurable symbol on first source pass
        }
        // Subsequent ownKeys hide the symbol — second-pass validation would miss it.
        return keys.filter((k) => k !== sym);
      },
      getOwnPropertyDescriptor(t, prop) {
        // After the first ownKeys, pretend the symbol is gone (TOCTOU).
        if (prop === sym && ownKeysCalls > 1) {
          return undefined;
        }
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
    });

    ownKeysCalls = 0;
    const enc = encodeIJson(proxy);
    assert.equal(enc.ok, false, "must reject from first-pass symbol snapshot");
    if (!enc.ok) {
      assert.match(enc.reason, /symbol own properties/i);
    }
    assert.equal(
      ownKeysCalls,
      1,
      "hostile source must receive exactly one ownKeys (no getOwnPropertySymbols re-query)",
    );

    ownKeysCalls = 0;
    const dig = digestValue(proxy);
    assert.equal(dig.ok, false);
    assert.equal(ownKeysCalls, 1);

    ownKeysCalls = 0;
    const exp = exportForSkillOSIngress(
      workspace({ body: proxy }),
      policy({ body: "public" }),
    );
    assert.equal(exp.admit, false);
    assert.equal(exp.denyCode, "INVALID_INPUT");
    assert.equal(exp.export, null);
    // Export path may ownKeys the workspace shell too; field array must still
    // be single-pass. Count only that the encode still denies with no artifact.
    assert.ok(ownKeysCalls >= 1);

    ownKeysCalls = 0;
    const ana = buildAnalyticsSummary(
      workspace({ body: proxy }),
      policy({ body: "digest" }),
    );
    assert.equal(ana.admit, false);
    assert.equal(ana.denyCode, "INVALID_INPUT");
    assert.equal(ana.summary, null);
  });

  it("named own property at property-cap boundary still rejects (not admitted)", () => {
    // Even a single named key on a dense empty array is forbidden structure.
    const arr = arrayWithNamedOwn(1);
    const enc = encodeIJson(arr);
    assert.equal(enc.ok, false);
    const d = exportForSkillOSIngress(
      workspace({ body: arr }),
      policy({ body: "digest" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.export, null);
  });
});

describe("F-008 — plain-object one-snapshot own keys; symbols fail closed", () => {
  it("plain object with symbol own property is rejected (encode + export + analytics)", () => {
    const obj: Record<string, unknown> = { a: 1 };
    const sym = Symbol("hidden");
    Object.defineProperty(obj, sym, {
      value: "attacker",
      enumerable: true,
      writable: true,
      configurable: true,
    });

    const enc = encodeIJson(obj);
    assert.equal(enc.ok, false);
    if (!enc.ok) {
      assert.match(enc.reason, /symbol own properties/i);
    }
    assert.equal(digestValue(obj).ok, false);

    const exp = exportForSkillOSIngress(
      workspace({ body: obj }),
      policy({ body: "public" }),
    );
    assert.equal(exp.admit, false);
    assert.equal(exp.denyCode, "INVALID_INPUT");
    assert.equal(exp.export, null);

    const ana = buildAnalyticsSummary(
      workspace({ body: obj }),
      policy({ body: "digest" }),
    );
    assert.equal(ana.admit, false);
    assert.equal(ana.summary, null);
  });

  it("over-cap symbol properties on plain object fail before success", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < IJSON_MAX_PROPERTIES + 1; i += 1) {
      Object.defineProperty(obj, Symbol(`s${i}`), {
        value: i,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const enc = encodeIJson(obj);
    assert.equal(enc.ok, false);
    if (!enc.ok) {
      assert.match(
        enc.reason,
        /property count exceeds cap|symbol own properties/i,
      );
    }
    const d = exportForSkillOSIngress(
      workspace({ body: obj }),
      policy({ body: "public" }),
    );
    assert.equal(d.admit, false);
    assert.equal(d.export, null);
  });

  it("stateful plain-object Proxy: first ownKeys shows symbol, later hides — deny + exactly one ownKeys", () => {
    const sym = Symbol("toctou-obj");

    function makeProxy(): { proxy: object; getCalls: () => number; reset: () => void } {
      const target: Record<string, unknown> = { ok: true };
      Object.defineProperty(target, sym, {
        value: "secret-data",
        enumerable: true,
        writable: true,
        configurable: true,
      });
      let ownKeysCalls = 0;
      const proxy = new Proxy(target, {
        ownKeys(t) {
          ownKeysCalls += 1;
          const keys = Reflect.ownKeys(t);
          if (ownKeysCalls === 1) return keys;
          return keys.filter((k) => k !== sym);
        },
        getOwnPropertyDescriptor(t, prop) {
          if (prop === sym && ownKeysCalls > 1) return undefined;
          return Reflect.getOwnPropertyDescriptor(t, prop);
        },
      });
      return {
        proxy,
        getCalls: () => ownKeysCalls,
        reset: () => {
          ownKeysCalls = 0;
        },
      };
    }

    {
      const { proxy, getCalls, reset } = makeProxy();
      reset();
      const enc = encodeIJson(proxy);
      assert.equal(enc.ok, false);
      if (!enc.ok) {
        assert.match(enc.reason, /symbol own properties/i);
      }
      assert.equal(
        getCalls(),
        1,
        "plain-object path must not re-query getOwnPropertyNames/Symbols",
      );
    }

    {
      const { proxy, getCalls, reset } = makeProxy();
      reset();
      assert.equal(digestValue(proxy).ok, false);
      assert.equal(getCalls(), 1);
    }

    {
      // Fresh proxy so prior path counters cannot hide the first-pass symbol.
      const { proxy } = makeProxy();
      const exp = exportForSkillOSIngress(
        workspace({ body: proxy }),
        policy({ body: "public" }),
      );
      assert.equal(exp.admit, false);
      assert.equal(exp.export, null);
    }

    {
      const { proxy } = makeProxy();
      const ana = buildAnalyticsSummary(
        workspace({ body: proxy }),
        policy({ body: "digest" }),
      );
      assert.equal(ana.admit, false);
      assert.equal(ana.summary, null);
    }
  });

  it("stateful plain-object Proxy hiding a string key on second ownKeys still denies", () => {
    // First ownKeys exposes extra string; second would hide it → two-pass fail-open.
    const target: Record<string, unknown> = { keep: 1 };
    Object.defineProperty(target, "ephemeral", {
      value: 2,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    let ownKeysCalls = 0;
    const proxy = new Proxy(target, {
      ownKeys(t) {
        ownKeysCalls += 1;
        const keys = Reflect.ownKeys(t);
        if (ownKeysCalls === 1) return keys;
        return keys.filter((k) => k !== "ephemeral");
      },
      getOwnPropertyDescriptor(t, prop) {
        if (prop === "ephemeral" && ownKeysCalls > 1) return undefined;
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
    });

    ownKeysCalls = 0;
    // With one-snapshot: both keep + ephemeral charged/encoded from first pass.
    const enc = encodeIJson(proxy);
    // Success is OK if both keys are included from first snapshot; failure is also
    // OK. Must not succeed with only `keep` after a second ownKeys hide.
    assert.equal(ownKeysCalls, 1);
    if (enc.ok) {
      const snap = enc.snapshot as Record<string, unknown>;
      assert.equal(snap.keep, 1);
      assert.equal(snap.ephemeral, 2);
    }
  });

  it("workspace shell with symbol own property fails closed", () => {
    const ws: Record<string, unknown> = {
      workspaceId: "ws-test-1",
      fields: { a: 1 },
    };
    Object.defineProperty(ws, Symbol("shell"), {
      value: "x",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const d = exportForSkillOSIngress(ws, policy({ a: "public" }));
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);
    assert.match(d.reason, /symbol own properties|not allowed|INVALID/i);
  });

  it("policy shell with symbol own property fails closed", () => {
    const pol: Record<string, unknown> = {
      contractVersion: PRIVACY_CONTRACT_VERSION,
      fields: { a: "public" },
    };
    Object.defineProperty(pol, Symbol("pol"), {
      value: "y",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const d = exportForSkillOSIngress(workspace({ a: 1 }), pol);
    assert.equal(d.admit, false);
    assert.equal(d.denyCode, "INVALID_INPUT");
    assert.equal(d.export, null);
  });

  it("containsSecretShaped fails closed on plain-object symbol own keys", () => {
    const obj: Record<string, unknown> = { a: "ok" };
    Object.defineProperty(obj, Symbol("s"), {
      value: "Bearer sk-hidden",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    // Must not omit the symbol-owned secret and report clean.
    assert.equal(containsSecretShaped(obj), true);
  });

  it("containsSecretShaped fails closed on array symbol own keys", () => {
    const arr: unknown[] = ["ok"];
    Object.defineProperty(arr, Symbol("s"), {
      value: "x",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    assert.equal(containsSecretShaped(arr), true);
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
    assert.ok(text.length > 8_000, "LICENSE must be full Apache-2.0 text");
  });
});

// CI-ORD-1: ordered adjacency for the load-bearing test-ts tail lives solely in
// `packages/private-runner-isolation/test/ci-test-path-order.test.ts`
// (`assertCiTestPathOrderChain`). Do not re-add neighbour guards here.
