/**
 * Fail-closed SkillOS ingress export + analytics summary (ADR 0007).
 *
 * Security rebuild (ChatGPT F-001…F-007 + F-007 residual):
 * - F-001: top-level isSensitiveKey before policy
 * - F-002: detached deep JSON snapshot + deep-freeze
 * - F-003: null-prototype maps + own-property lookup
 * - F-004: strict finite I-JSON digest domain
 * - F-005: snapshot-then-scan on the same detached value
 * - F-006: outer descriptor-safe ingress; structured INVALID_INPUT
 * - F-007: array/depth caps fail closed (no truncation)
 * - F-007 residual: one request-scoped ResourceBudget shared across
 *   workspace + policy + all field encode/digest work; public encoder
 *   cannot be weakened via extra runtime args
 * - F-007A: budget helpers internal to this gate (not package-root exports)
 * - F-007B: array named/symbol own keys fail closed in shared encoder
 *
 * Private enforcement matrices are module-local — public ALWAYS_PRIVATE_KEYS /
 * FORBIDDEN_AUTHORITY_ACTIONS are inspection-only.
 */

import {
  chargeOwnPropertyNames,
  createResourceBudget,
  digestValueWithBudget,
  encodeIJsonWithBudget,
  type ResourceBudget,
} from "./digest.js";
import { containsSecretShaped, isSecretValue, isSensitiveKey } from "./secrets.js";
import {
  FORBIDDEN_AUTHORITY_ACTIONS,
  PRIVACY_CONTRACT_VERSION,
  type AnalyticsDecision,
  type AnalyticsSummary,
  type ExportDecision,
  type ExportPolicy,
  type FieldClass,
  type ForbiddenAuthorityAction,
  type PrivateWorkspaceRecord,
  type SkillOSIngressExport,
  isFieldClass,
} from "./types.js";

/**
 * Private always-deny key matrix — not exported. Mutating public
 * ALWAYS_PRIVATE_KEYS must not change gate outcomes.
 * Exact names only; F-001 also applies isSensitiveKey for variants.
 */
const PRIVATE_ALWAYS_DENY_KEYS: ReadonlySet<string> = new Set([
  "privateKey",
  "private_key",
  "mnemonic",
  "seedPhrase",
  "seed_phrase",
  "walletSecret",
  "wallet_secret",
  "portfolio",
  "portfolioRaw",
  "portfolio_raw",
  "rawTrace",
  "raw_trace",
  "unredactedTrace",
  "unredacted_trace",
  "authorization",
  "password",
  "passwd",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "clientSecret",
  "client_secret",
]);

/** Private authority deny set — not exported. */
const PRIVATE_FORBIDDEN_ACTIONS: ReadonlySet<string> = new Set([
  "request_execute",
  "issue_promotion_authorization",
  "wallet_spend",
  "x402_funded_spend",
  "control_plane_unpause",
]);

function denyExport(
  code: ExportDecision["denyCode"],
  reason: string,
  workspaceIdDigest: string | null = null,
): ExportDecision {
  return {
    contractVersion: PRIVACY_CONTRACT_VERSION,
    admit: false,
    workspaceIdDigest,
    export: null,
    denyCode: code,
    reason,
  };
}

function denyAnalytics(
  code: AnalyticsDecision["denyCode"],
  reason: string,
): AnalyticsDecision {
  return {
    contractVersion: PRIVACY_CONTRACT_VERSION,
    admit: false,
    summary: null,
    denyCode: code,
    reason,
  };
}

/** Own-property has check that never walks prototypes. */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function safeGetPrototypeOf(
  value: object,
): { ok: true; proto: object | null } | { ok: false } {
  try {
    return { ok: true, proto: Object.getPrototypeOf(value) as object | null };
  } catch {
    return { ok: false };
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const proto = safeGetPrototypeOf(value);
  if (!proto.ok) return false;
  return proto.proto === Object.prototype || proto.proto === null;
}

/**
 * Enumerate own data properties only (F-003 / F-006 / F-008).
 * Never invokes getters: values come only from data descriptors.
 * One source ownKeys inside getOwnPropertyDescriptors; keys derived only from
 * Reflect.ownKeys(descriptors) — never re-query hostile source (F-008).
 * Symbols fail closed. Charges property/key-byte budget (F-007 residual).
 */
function ownDataFieldMap(
  obj: object,
  budget: ResourceBudget,
):
  | { ok: true; map: Record<string, unknown>; names: string[] }
  | { ok: false; reason: string } {
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(obj);
  } catch {
    return { ok: false, reason: "property descriptors unavailable" };
  }
  let snapshotKeys: Array<string | symbol>;
  try {
    snapshotKeys = Reflect.ownKeys(descriptors);
  } catch {
    return { ok: false, reason: "property descriptors unavailable" };
  }
  const symbolKeys: symbol[] = [];
  const names: string[] = [];
  for (const k of snapshotKeys) {
    if (typeof k === "symbol") {
      symbolKeys.push(k);
    } else {
      names.push(k);
    }
  }
  if (symbolKeys.length > 0) {
    // Charge symbol flood against property cap before structured reject (F-008).
    // Empty names: property count only (symbols have no UTF-8 key names).
    const charged = chargeOwnPropertyNames(
      symbolKeys.map(() => ""),
      budget,
    );
    if (!charged.ok) {
      return { ok: false, reason: charged.reason };
    }
    return { ok: false, reason: "symbol own properties are not allowed" };
  }
  const charged = chargeOwnPropertyNames(names, budget);
  if (!charged.ok) {
    return { ok: false, reason: charged.reason };
  }
  const map = Object.create(null) as Record<string, unknown>;
  const outNames: string[] = [];
  for (const name of names) {
    const desc = descriptors[name];
    if (!desc) {
      return { ok: false, reason: `missing descriptor for "${name}"` };
    }
    if (desc.get !== undefined || desc.set !== undefined) {
      return {
        ok: false,
        reason: `field "${name}" is an accessor and is not allowed`,
      };
    }
    if (!("value" in desc)) {
      return { ok: false, reason: `field "${name}" has no data value` };
    }
    Object.defineProperty(map, name, {
      value: desc.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    outNames.push(name);
  }
  return { ok: true, map, names: outNames };
}

/**
 * F-006: validate outer workspace via one descriptor capture — never
 * `workspace.workspaceId` / `workspace.fields` property reads (getters).
 */
function validateWorkspace(
  workspace: unknown,
  budget: ResourceBudget,
):
  | { ok: true; record: PrivateWorkspaceRecord; fieldNames: string[] }
  | { ok: false; reason: string } {
  try {
    if (!isPlainRecord(workspace)) {
      return { ok: false, reason: "workspace must be a plain object" };
    }
    const outer = ownDataFieldMap(workspace, budget);
    if (!outer.ok) {
      return { ok: false, reason: outer.reason };
    }
    if (!hasOwn(outer.map, "workspaceId")) {
      return {
        ok: false,
        reason: "workspace.workspaceId must be a non-empty string",
      };
    }
    const workspaceId = outer.map.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      return {
        ok: false,
        reason: "workspace.workspaceId must be a non-empty string",
      };
    }
    if (workspaceId.length > 512) {
      return { ok: false, reason: "workspace.workspaceId exceeds max length" };
    }
    if (!hasOwn(outer.map, "fields")) {
      return { ok: false, reason: "workspace.fields must be a plain object" };
    }
    const fields = outer.map.fields;
    if (!isPlainRecord(fields)) {
      return { ok: false, reason: "workspace.fields must be a plain object" };
    }
    const own = ownDataFieldMap(fields, budget);
    if (!own.ok) {
      return { ok: false, reason: own.reason };
    }
    return {
      ok: true,
      record: {
        workspaceId,
        fields: own.map as Readonly<Record<string, unknown>>,
      },
      fieldNames: own.names,
    };
  } catch {
    return { ok: false, reason: "workspace reflection failed" };
  }
}

/**
 * F-006: validate outer policy via one descriptor capture — never
 * `policy.contractVersion` / `policy.fields` property reads (getters).
 */
function validatePolicy(
  policy: unknown,
  budget: ResourceBudget,
):
  | { ok: true; policy: ExportPolicy }
  | { ok: false; code: "MISSING_POLICY" | "INVALID_INPUT"; reason: string } {
  try {
    if (policy === null || policy === undefined) {
      return {
        ok: false,
        code: "MISSING_POLICY",
        reason: "export policy is required",
      };
    }
    if (!isPlainRecord(policy)) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        reason: "export policy must be a plain object",
      };
    }
    const outer = ownDataFieldMap(policy, budget);
    if (!outer.ok) {
      return { ok: false, code: "INVALID_INPUT", reason: outer.reason };
    }
    if (!hasOwn(outer.map, "contractVersion")) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        reason: `export policy.contractVersion must be ${PRIVACY_CONTRACT_VERSION}`,
      };
    }
    if (outer.map.contractVersion !== PRIVACY_CONTRACT_VERSION) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        reason: `export policy.contractVersion must be ${PRIVACY_CONTRACT_VERSION}`,
      };
    }
    if (!hasOwn(outer.map, "fields")) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        reason: "export policy.fields must be a plain object",
      };
    }
    const fieldsObj = outer.map.fields;
    if (!isPlainRecord(fieldsObj)) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        reason: "export policy.fields must be a plain object",
      };
    }
    const fields = Object.create(null) as Record<string, FieldClass>;
    const own = ownDataFieldMap(fieldsObj, budget);
    if (!own.ok) {
      return { ok: false, code: "INVALID_INPUT", reason: own.reason };
    }
    for (const name of own.names) {
      if (typeof name !== "string" || name.length === 0) {
        return {
          ok: false,
          code: "INVALID_INPUT",
          reason: "export policy field names must be non-empty strings",
        };
      }
      const v = own.map[name];
      if (!isFieldClass(v)) {
        return {
          ok: false,
          code: "INVALID_INPUT",
          reason: `export policy field "${name}" has invalid classification`,
        };
      }
      Object.defineProperty(fields, name, {
        value: v,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
    return {
      ok: true,
      policy: {
        contractVersion: PRIVACY_CONTRACT_VERSION,
        fields: fields as Readonly<Record<string, FieldClass>>,
      },
    };
  } catch {
    return {
      ok: false,
      code: "INVALID_INPUT",
      reason: "policy reflection failed",
    };
  }
}

/**
 * Classify a field using private denylist + isSensitiveKey (F-001) + policy.
 * Own-property lookup only on null-proto policy map (F-003).
 */
function effectiveClass(
  fieldName: string,
  policy: ExportPolicy,
): FieldClass | "unclassified" | "always_private" {
  if (isSensitiveKey(fieldName)) {
    return "always_private";
  }
  if (PRIVATE_ALWAYS_DENY_KEYS.has(fieldName)) {
    return "always_private";
  }
  if (!hasOwn(policy.fields as object, fieldName)) {
    return "unclassified";
  }
  const cls = (policy.fields as Record<string, FieldClass>)[fieldName];
  if (!isFieldClass(cls)) {
    return "unclassified";
  }
  return cls;
}

/** Deep-freeze a detached I-JSON snapshot in place (F-002). */
function deepFreeze(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      deepFreeze(value[i], seen);
    }
    return Object.freeze(value);
  }
  for (const k of Object.getOwnPropertyNames(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, k);
    if (desc && "value" in desc) {
      deepFreeze(desc.value, seen);
    }
  }
  return Object.freeze(value);
}

/**
 * F-005 + F-007 residual: one detached snapshot charged to the request budget.
 */
function snapshotPublicValue(
  value: unknown,
  budget: ResourceBudget,
): { ok: true; snapshot: unknown } | { ok: false; reason: string } {
  const encoded = encodeIJsonWithBudget(value, budget);
  if (!encoded.ok) {
    return { ok: false, reason: encoded.reason };
  }
  deepFreeze(encoded.snapshot);
  return { ok: true, snapshot: encoded.snapshot };
}

/**
 * F-005: secret-scan a detached snapshot (never a second live traversal).
 * Snapshot is already budget-paid at encode; scan uses a fresh local bound
 * so it cannot weaken request encode caps.
 */
function snapshotContainsSecret(snapshot: unknown): boolean {
  if (typeof snapshot === "string" && isSecretValue(snapshot)) return true;
  return containsSecretShaped(snapshot);
}

/**
 * Sole SkillOS-ingress export gate (ADR 0007 D2).
 * One request-scoped ResourceBudget for the whole decision (F-007 residual).
 */
export function exportForSkillOSIngress(
  workspace: unknown,
  policy: unknown,
): ExportDecision {
  try {
    const budget = createResourceBudget();
    const ws = validateWorkspace(workspace, budget);
    if (!ws.ok) {
      return denyExport("INVALID_INPUT", ws.reason);
    }
    const pol = validatePolicy(policy, budget);
    if (!pol.ok) {
      return denyExport(pol.code, pol.reason);
    }

    let idDigest: string;
    {
      // Share request budget (F-007 residual); public digestWorkspaceId is one-arg only (F-007A).
      const idDig = digestValueWithBudget(ws.record.workspaceId, budget);
      if (!idDig.ok) {
        return denyExport(
          "INVALID_INPUT",
          `workspaceId digest failed: ${idDig.reason}`,
        );
      }
      idDigest = idDig.digest;
    }

    const projected = Object.create(null) as Record<string, unknown>;
    const digestedFields: string[] = [];
    const publicFields: string[] = [];

    for (const name of ws.fieldNames) {
      const value = (ws.record.fields as Record<string, unknown>)[name];
      const cls = effectiveClass(name, pol.policy);

      if (cls === "always_private") {
        return denyExport(
          "PRIVATE_FIELD",
          `field "${name}" is always-private / sensitive-named and cannot enter SkillOS`,
          idDigest,
        );
      }
      if (cls === "unclassified") {
        return denyExport(
          "UNCLASSIFIED_FIELD",
          `field "${name}" has no export policy classification`,
          idDigest,
        );
      }
      if (cls === "private") {
        return denyExport(
          "PRIVATE_FIELD",
          `field "${name}" is classified private and cannot enter SkillOS`,
          idDigest,
        );
      }
      if (cls === "aggregate") {
        continue;
      }
      if (cls === "digest") {
        // Shared request budget — no per-digestValue reset (F-007 residual).
        const dig = digestValueWithBudget(value, budget);
        if (!dig.ok) {
          return denyExport(
            "INVALID_INPUT",
            `field "${name}" digest rejected: ${dig.reason}`,
            idDigest,
          );
        }
        Object.defineProperty(projected, name, {
          value: dig.digest,
          writable: false,
          enumerable: true,
          configurable: false,
        });
        digestedFields.push(name);
        continue;
      }
      if (cls === "public") {
        const snap = snapshotPublicValue(value, budget);
        if (!snap.ok) {
          return denyExport(
            "INVALID_INPUT",
            `field "${name}" public projection rejected: ${snap.reason}`,
            idDigest,
          );
        }
        if (snapshotContainsSecret(snap.snapshot)) {
          return denyExport(
            "SECRET_SHAPED_VALUE",
            `field "${name}" contains secret-shaped or non-IJSON material`,
            idDigest,
          );
        }
        Object.defineProperty(projected, name, {
          value: snap.snapshot,
          writable: false,
          enumerable: true,
          configurable: false,
        });
        publicFields.push(name);
        continue;
      }
      return denyExport(
        "INVALID_INPUT",
        `field "${name}" has unrecognized classification`,
        idDigest,
      );
    }

    const body: SkillOSIngressExport = Object.freeze({
      contractVersion: PRIVACY_CONTRACT_VERSION,
      workspaceIdDigest: idDigest,
      projected: Object.freeze(projected),
      digestedFields: Object.freeze([...digestedFields].sort()),
      publicFields: Object.freeze([...publicFields].sort()),
    });

    return {
      contractVersion: PRIVACY_CONTRACT_VERSION,
      admit: true,
      workspaceIdDigest: idDigest,
      export: body,
      denyCode: null,
      reason: "ok",
    };
  } catch {
    return denyExport("INVALID_INPUT", "export gate reflection failed");
  }
}

/**
 * Build a SkillOS-safe analytics summary (ADR 0007 D3).
 * One request-scoped ResourceBudget for the whole decision (F-007 residual).
 */
export function buildAnalyticsSummary(
  workspace: unknown,
  policy: unknown,
): AnalyticsDecision {
  try {
    const budget = createResourceBudget();
    const ws = validateWorkspace(workspace, budget);
    if (!ws.ok) {
      return denyAnalytics("INVALID_INPUT", ws.reason);
    }
    const pol = validatePolicy(policy, budget);
    if (!pol.ok) {
      return denyAnalytics(pol.code, pol.reason);
    }

    let idDigest: string;
    {
      const idDig = digestValueWithBudget(ws.record.workspaceId, budget);
      if (!idDig.ok) {
        return denyAnalytics(
          "INVALID_INPUT",
          `workspaceId digest failed: ${idDig.reason}`,
        );
      }
      idDigest = idDig.digest;
    }

    const aggregates = Object.create(null) as Record<string, number>;
    const digests = Object.create(null) as Record<string, string>;
    const digestedFields: string[] = [];
    const publicDigestedFields: string[] = [];
    let fieldCount = 0;

    for (const name of ws.fieldNames) {
      fieldCount += 1;
      const value = (ws.record.fields as Record<string, unknown>)[name];
      const cls = effectiveClass(name, pol.policy);

      if (cls === "always_private" || cls === "private") {
        return denyAnalytics(
          "PRIVATE_FIELD",
          `field "${name}" is private / sensitive-named and cannot enter analytics`,
        );
      }
      if (cls === "unclassified") {
        return denyAnalytics(
          "UNCLASSIFIED_FIELD",
          `field "${name}" has no export policy classification`,
        );
      }
      if (cls === "aggregate") {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return denyAnalytics(
            "AGGREGATE_TYPE_MISMATCH",
            `field "${name}" aggregate requires a finite number`,
          );
        }
        Object.defineProperty(aggregates, name, {
          value,
          writable: false,
          enumerable: true,
          configurable: false,
        });
        continue;
      }
      // D3 / AR-1: both `digest` and `public` enter analytics as digests only
      // (public is never raw-projected on this surface). Provenance split AR-2.
      if (cls === "digest" || cls === "public") {
        const dig = digestValueWithBudget(value, budget);
        if (!dig.ok) {
          return denyAnalytics(
            "INVALID_INPUT",
            `field "${name}" digest rejected: ${dig.reason}`,
          );
        }
        if (cls === "public" && snapshotContainsSecret(dig.snapshot)) {
          return denyAnalytics(
            "SECRET_SHAPED_VALUE",
            `field "${name}" contains secret-shaped or non-IJSON material`,
          );
        }
        Object.defineProperty(digests, name, {
          value: dig.digest,
          writable: false,
          enumerable: true,
          configurable: false,
        });
        if (cls === "digest") {
          digestedFields.push(name);
        } else {
          publicDigestedFields.push(name);
        }
        continue;
      }
      return denyAnalytics(
        "INVALID_INPUT",
        `field "${name}" has unrecognized classification`,
      );
    }

    const summary: AnalyticsSummary = Object.freeze({
      contractVersion: PRIVACY_CONTRACT_VERSION,
      workspaceIdDigest: idDigest,
      fieldCount,
      aggregates: Object.freeze(aggregates),
      digests: Object.freeze(digests),
      digestedFields: Object.freeze([...digestedFields].sort()),
      publicDigestedFields: Object.freeze([...publicDigestedFields].sort()),
      grantsExecutionAuthority: false,
      grantsPromotionAuthority: false,
      grantsWalletAuthority: false,
      grantsFundedSpendAuthority: false,
      grantsControlPlaneAuthority: false,
    });

    return {
      contractVersion: PRIVACY_CONTRACT_VERSION,
      admit: true,
      summary,
      denyCode: null,
      reason: "ok",
    };
  } catch {
    return denyAnalytics("INVALID_INPUT", "analytics gate reflection failed");
  }
}

/**
 * Explicit deny helper for authority-bearing action labels (inspection / tests).
 * Production gates (`exportForSkillOSIngress`, `buildAnalyticsSummary`) accept
 * **no** authority parameter — stronger than deny-by-parameter (ADR 0007 D3 / AR-4).
 * Call this only when a caller has an action label outside those gates.
 */
export function denyAuthorityAction(
  action: unknown,
): {
  readonly admit: false;
  readonly denyCode: "EXPORT_AUTHORITY_FORBIDDEN" | "INVALID_INPUT";
  readonly reason: string;
  readonly action: string | null;
} {
  if (typeof action !== "string" || action.length === 0) {
    return {
      admit: false,
      denyCode: "INVALID_INPUT",
      reason: "authority action must be a non-empty string",
      action: null,
    };
  }
  if (
    PRIVATE_FORBIDDEN_ACTIONS.has(action) ||
    (FORBIDDEN_AUTHORITY_ACTIONS as readonly string[]).includes(action)
  ) {
    return {
      admit: false,
      denyCode: "EXPORT_AUTHORITY_FORBIDDEN",
      reason: `action "${action}" is never grantable by private-workspace analytics`,
      action,
    };
  }
  return {
    admit: false,
    denyCode: "EXPORT_AUTHORITY_FORBIDDEN",
    reason: `action "${action}" is not an analytics-grantable authority`,
    action,
  };
}

/**
 * Explicit raw-private export attempt helper for leak-class tests.
 */
export function attemptRawPrivateExport(
  workspace: unknown,
): ExportDecision {
  try {
    const budget = createResourceBudget();
    const ws = validateWorkspace(workspace, budget);
    if (!ws.ok) {
      return denyExport("INVALID_INPUT", ws.reason);
    }
    let idDigest: string;
    {
      const idDig = digestValueWithBudget(ws.record.workspaceId, budget);
      if (!idDig.ok) {
        return denyExport("INVALID_INPUT", "workspaceId digest failed");
      }
      idDigest = idDig.digest;
    }
    return denyExport(
      "RAW_PRIVATE_EXPORT",
      "raw private workspace export is forbidden; use exportForSkillOSIngress with a policy",
      idDigest,
    );
  } catch {
    return denyExport("INVALID_INPUT", "raw-export reflection failed");
  }
}

/** Test/inspection helper: private denylist membership (does not grant override). */
export function isAlwaysPrivateKey(name: string): boolean {
  return PRIVATE_ALWAYS_DENY_KEYS.has(name) || isSensitiveKey(name);
}

/** Test/inspection helper: forbidden authority action membership. */
export function isAuthorityActionForbidden(
  action: ForbiddenAuthorityAction | string,
): boolean {
  return PRIVATE_FORBIDDEN_ACTIONS.has(action);
}
