/**
 * Foundations-local deterministic digest for private-workspace projections.
 * Strict finite I-JSON domain only (F-004) — no coerce of exotic inputs to a
 * shared "null" encoding. SHA-256 over stable sorted-key JSON.
 *
 * F-005: encode produces one detached snapshot used for both scan and emit.
 * F-006: all reflective traps fail closed as structured Result (never throw).
 * F-007: array/depth/node/property/UTF-8-byte caps reject; never truncate.
 * F-007 residual: public encoder is one-arg only (extra args ignored);
 *   request-scoped budgets are shared across a whole export/analytics decision.
 * F-007A: budget construction / *WithBudget helpers are package-internal only
 *   (not re-exported from package root); counters validated on every charge.
 * F-007B: array own keys limited to length + dense indices from one descriptor
 *   snapshot; symbols and named extras rejected (never silently omitted).
 * F-007B residual: never re-query hostile value after descriptor capture —
 *   symbols/strings come only from Reflect.ownKeys(descriptors) (one source
 *   ownKeys pass inside getOwnPropertyDescriptors).
 * F-008: plain-object branch same one-snapshot rule (no getOwnPropertyNames
 *   re-query); symbols rejected and charged before success.
 *
 * Not a protocol catalog digest binding — see ADR 0007 residual.
 */

import { createHash } from "node:crypto";

/** Max dense array length accepted by the I-JSON encoder (F-007). */
export const IJSON_MAX_ARRAY_LENGTH = 10_000;

/** Max nesting depth accepted by the I-JSON encoder (F-007). */
export const IJSON_MAX_DEPTH = 64;

/**
 * Max nodes (scalars + containers) per encode or per request budget (F-007).
 * Sized so dense array-at-cap (length 10_000 → 10_001 nodes) still fits.
 */
export const IJSON_MAX_NODES = 50_000;

/** Max own-property count charged against a budget (F-007 residual). */
export const IJSON_MAX_PROPERTIES = 4_000;

/**
 * Max cumulative UTF-8 bytes of string values (+ key names) charged against
 * a budget (F-007 residual).
 */
export const IJSON_MAX_UTF8_BYTES = 256_000;

/** Structured failure from the digest domain (never throws for expected rejects). */
export type DigestEncodeFailure = {
  readonly ok: false;
  readonly reason: string;
};

export type DigestEncodeSuccess = {
  readonly ok: true;
  /** Canonical JSON text of the validated I-JSON value. */
  readonly canonical: string;
  /** Detached deep clone of the validated I-JSON value (no caller aliases). */
  readonly snapshot: unknown;
};

export type DigestEncodeResult = DigestEncodeSuccess | DigestEncodeFailure;

export type DigestValueResult =
  | { readonly ok: true; readonly digest: string; readonly snapshot: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Brand key for package-internal budgets (F-007A).
 * Not re-exported from package root; public consumers cannot mint a valid brand.
 */
const RESOURCE_BUDGET_BRAND: unique symbol = Symbol("ResourceBudget");

/**
 * Mutable request-scoped resource counters (F-007 residual / F-007A).
 * Package-internal only — shared across workspace, policy, and field work.
 * Prefer createResourceBudget(); forged plain objects fail brand check.
 */
export type ResourceBudget = {
  readonly [RESOURCE_BUDGET_BRAND]: true;
  nodes: number;
  bytes: number;
  properties: number;
};

/** Fresh zeroed budget for a new encode or request (package-internal). */
export function createResourceBudget(): ResourceBudget {
  return {
    [RESOURCE_BUDGET_BRAND]: true,
    nodes: 0,
    bytes: 0,
    properties: 0,
  };
}

function utf8ByteLength(s: string): number {
  // Node Buffer is available in package engines (>=20).
  return Buffer.byteLength(s, "utf8");
}

/**
 * Fail closed if budget is missing brand or counters are not finite safe
 * non-negative integers already within caps (F-007A).
 */
function validateBudgetState(
  budget: ResourceBudget,
): DigestEncodeFailure | null {
  if (
    budget == null ||
    typeof budget !== "object" ||
    budget[RESOURCE_BUDGET_BRAND] !== true
  ) {
    return { ok: false, reason: "invalid resource budget state" };
  }
  for (const key of ["nodes", "bytes", "properties"] as const) {
    const v = budget[key];
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      !Number.isSafeInteger(v) ||
      v < 0
    ) {
      return { ok: false, reason: "invalid resource budget state" };
    }
  }
  if (budget.nodes > IJSON_MAX_NODES) {
    return { ok: false, reason: "node count exceeds cap" };
  }
  if (budget.bytes > IJSON_MAX_UTF8_BYTES) {
    return { ok: false, reason: "UTF-8 byte count exceeds cap" };
  }
  if (budget.properties > IJSON_MAX_PROPERTIES) {
    return { ok: false, reason: "property count exceeds cap" };
  }
  return null;
}

function isValidCharge(n: number): boolean {
  return typeof n === "number" && Number.isFinite(n) && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Overflow-safe pre-charge: reject when current + n would exceed cap
 * without relying on post-increment wrap or forgeable negative counters.
 */
function wouldExceed(current: number, n: number, cap: number): boolean {
  // If n alone is over cap, always exceed for non-negative current.
  if (n > cap) return true;
  return current > cap - n;
}

function chargeBytes(
  budget: ResourceBudget,
  n: number,
): DigestEncodeFailure | null {
  const stateFail = validateBudgetState(budget);
  if (stateFail) return stateFail;
  if (!isValidCharge(n)) {
    return { ok: false, reason: "invalid byte charge" };
  }
  if (wouldExceed(budget.bytes, n, IJSON_MAX_UTF8_BYTES)) {
    return { ok: false, reason: "UTF-8 byte count exceeds cap" };
  }
  budget.bytes += n;
  return null;
}

function chargeProperties(
  budget: ResourceBudget,
  n: number,
): DigestEncodeFailure | null {
  const stateFail = validateBudgetState(budget);
  if (stateFail) return stateFail;
  if (!isValidCharge(n)) {
    return { ok: false, reason: "invalid property charge" };
  }
  if (wouldExceed(budget.properties, n, IJSON_MAX_PROPERTIES)) {
    return { ok: false, reason: "property count exceeds cap" };
  }
  budget.properties += n;
  return null;
}

function chargeNode(budget: ResourceBudget): DigestEncodeFailure | null {
  const stateFail = validateBudgetState(budget);
  if (stateFail) return stateFail;
  if (wouldExceed(budget.nodes, 1, IJSON_MAX_NODES)) {
    return { ok: false, reason: "node count exceeds cap" };
  }
  budget.nodes += 1;
  return null;
}

/** True if key is the exact decimal form of a dense index in [0, len). */
function isDenseIndexKey(key: string, len: number): boolean {
  if (key === "0") return len > 0;
  if (!/^[1-9]\d*$/.test(key)) return false;
  // Reject keys that would lose precision as Number.
  if (key.length > 15) return false;
  const idx = Number(key);
  return Number.isSafeInteger(idx) && idx >= 0 && idx < len && String(idx) === key;
}

function safeGetPrototypeOf(
  value: object,
): { ok: true; proto: object | null } | { ok: false; reason: string } {
  try {
    return { ok: true, proto: Object.getPrototypeOf(value) as object | null };
  } catch {
    return { ok: false, reason: "prototype reflection failed" };
  }
}

function isPlainRecord(value: object): boolean {
  const proto = safeGetPrototypeOf(value);
  if (!proto.ok) return false;
  return proto.proto === Object.prototype || proto.proto === null;
}

function safeOwnPropertyDescriptors(
  value: object,
):
  | { ok: true; descriptors: Record<string, PropertyDescriptor> }
  | { ok: false; reason: string } {
  try {
    return {
      ok: true,
      descriptors: Object.getOwnPropertyDescriptors(value),
    };
  } catch {
    return { ok: false, reason: "property descriptors unavailable" };
  }
}

/**
 * Private recursive encoder — only called with trusted internal state.
 * Caller-controlled seen/depth/budget cannot be injected via the public API.
 */
function encodeIJsonInternal(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  budget: ResourceBudget,
): DigestEncodeResult {
  try {
    if (depth > IJSON_MAX_DEPTH) {
      return { ok: false, reason: "nesting depth exceeds cap" };
    }
    const nodeFail = chargeNode(budget);
    if (nodeFail) return nodeFail;

    if (value === null) {
      return { ok: true, canonical: "null", snapshot: null };
    }
    const t = typeof value;
    if (t === "string") {
      const s = value as string;
      const byteFail = chargeBytes(budget, utf8ByteLength(s));
      if (byteFail) return byteFail;
      return {
        ok: true,
        canonical: JSON.stringify(s),
        snapshot: s,
      };
    }
    if (t === "boolean") {
      return {
        ok: true,
        canonical: value ? "true" : "false",
        snapshot: value,
      };
    }
    if (t === "number") {
      if (!Number.isFinite(value as number)) {
        return { ok: false, reason: "non-finite number is not I-JSON" };
      }
      return {
        ok: true,
        canonical: String(value),
        snapshot: value,
      };
    }
    if (t === "undefined") {
      return { ok: false, reason: "undefined is not I-JSON" };
    }
    if (t === "bigint" || t === "function" || t === "symbol") {
      return { ok: false, reason: `${t} is not I-JSON` };
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) {
        return { ok: false, reason: "cyclic structure is not I-JSON" };
      }
      seen.add(value);
      try {
        // Single source ownKeys pass inside getOwnPropertyDescriptors only
        // (F-007B residual). Never call ownKeys/getOwnPropertySymbols on
        // hostile `value` again — derive keys from this snapshot alone.
        const descResult = safeOwnPropertyDescriptors(value);
        if (!descResult.ok) {
          return { ok: false, reason: descResult.reason };
        }
        const { descriptors } = descResult;

        // getOwnPropertyDescriptors copies string + symbol keys onto the
        // ordinary descriptors object. Inspect that object only (no re-query).
        let snapshotKeys: Array<string | symbol>;
        try {
          snapshotKeys = Reflect.ownKeys(descriptors);
        } catch {
          return { ok: false, reason: "property descriptors unavailable" };
        }
        const symbolKeys: symbol[] = [];
        const stringKeys: string[] = [];
        for (const k of snapshotKeys) {
          if (typeof k === "symbol") {
            symbolKeys.push(k);
          } else {
            stringKeys.push(k);
          }
        }

        // F-007B: reject all captured symbols before success; charge property
        // budget so a first-pass flood of symbol descriptors cannot bypass caps
        // by hiding on a second ownKeys (which we no longer perform).
        if (symbolKeys.length > 0) {
          const propFail = chargeProperties(budget, symbolKeys.length);
          if (propFail) return propFail;
          return {
            ok: false,
            reason: "symbol own properties are not I-JSON",
          };
        }

        const lengthDesc = descriptors.length;
        if (
          !lengthDesc ||
          lengthDesc.get !== undefined ||
          lengthDesc.set !== undefined ||
          !("value" in lengthDesc) ||
          typeof lengthDesc.value !== "number" ||
          !Number.isFinite(lengthDesc.value) ||
          lengthDesc.value < 0 ||
          !Number.isInteger(lengthDesc.value)
        ) {
          return {
            ok: false,
            reason: "array length must be a finite integer data property",
          };
        }
        // F-007: reject over-cap lengths — never truncate.
        if (lengthDesc.value > IJSON_MAX_ARRAY_LENGTH) {
          return {
            ok: false,
            reason: `array length exceeds cap of ${IJSON_MAX_ARRAY_LENGTH}`,
          };
        }
        const len = lengthDesc.value;

        // F-007B: every own string key from the same snapshot must be
        // `length` or a dense canonical index in [0, len). Named extras and
        // non-index keys are rejected — never silently omitted or uncharged.
        const namedExtras: string[] = [];
        for (const key of stringKeys) {
          if (key === "length") continue;
          if (!isDenseIndexKey(key, len)) {
            namedExtras.push(key);
          }
        }
        if (namedExtras.length > 0) {
          // Charge against request-wide property/key-byte caps first so a short
          // array cannot smuggle unbounded named material past the budget.
          const propFail = chargeProperties(budget, namedExtras.length);
          if (propFail) return propFail;
          let keyBytes = 0;
          for (const k of namedExtras) {
            keyBytes += utf8ByteLength(k);
          }
          const keyByteFail = chargeBytes(budget, keyBytes);
          if (keyByteFail) return keyByteFail;
          return {
            ok: false,
            reason:
              "array own properties other than length and dense indices are not I-JSON",
          };
        }

        const parts: string[] = [];
        const snap: unknown[] = new Array(len);
        for (let i = 0; i < len; i += 1) {
          const key = String(i);
          const desc = descriptors[key];
          if (!desc) {
            return { ok: false, reason: "sparse arrays are not I-JSON" };
          }
          if (desc.get !== undefined || desc.set !== undefined) {
            return { ok: false, reason: "accessor properties are not I-JSON" };
          }
          if (!("value" in desc)) {
            return { ok: false, reason: "array element missing data value" };
          }
          const child = encodeIJsonInternal(desc.value, seen, depth + 1, budget);
          if (!child.ok) return child;
          parts.push(child.canonical);
          snap[i] = child.snapshot;
        }
        return {
          ok: true,
          canonical: `[${parts.join(",")}]`,
          snapshot: snap,
        };
      } finally {
        seen.delete(value);
      }
    }
    if (t === "object") {
      const obj = value as object;
      if (!isPlainRecord(obj)) {
        return { ok: false, reason: "exotic object prototypes are not I-JSON" };
      }
      if (seen.has(obj)) {
        return { ok: false, reason: "cyclic structure is not I-JSON" };
      }
      seen.add(obj);
      try {
        // F-008: one source ownKeys inside getOwnPropertyDescriptors only.
        // Never call getOwnPropertyNames / getOwnPropertySymbols on hostile obj.
        const descResult = safeOwnPropertyDescriptors(obj);
        if (!descResult.ok) {
          return { ok: false, reason: descResult.reason };
        }
        const { descriptors } = descResult;
        let snapshotKeys: Array<string | symbol>;
        try {
          snapshotKeys = Reflect.ownKeys(descriptors);
        } catch {
          return { ok: false, reason: "property descriptors unavailable" };
        }
        const symbolKeys: symbol[] = [];
        const stringKeys: string[] = [];
        for (const k of snapshotKeys) {
          if (typeof k === "symbol") {
            symbolKeys.push(k);
          } else {
            stringKeys.push(k);
          }
        }
        // Reject all captured symbols before success; charge property budget so
        // first-pass symbol floods cannot bypass caps (F-008 / F-007B residual).
        if (symbolKeys.length > 0) {
          const propFail = chargeProperties(budget, symbolKeys.length);
          if (propFail) return propFail;
          return {
            ok: false,
            reason: "symbol own properties are not I-JSON",
          };
        }

        const keys = stringKeys.slice().sort();
        const propFail = chargeProperties(budget, keys.length);
        if (propFail) return propFail;
        // Charge UTF-8 of key names (property-name DoS surface).
        let keyBytes = 0;
        for (const k of keys) {
          keyBytes += utf8ByteLength(k);
        }
        const keyByteFail = chargeBytes(budget, keyBytes);
        if (keyByteFail) return keyByteFail;

        const parts: string[] = [];
        const snap: Record<string, unknown> = Object.create(null) as Record<
          string,
          unknown
        >;
        for (const k of keys) {
          const desc = descriptors[k];
          if (!desc) {
            return { ok: false, reason: `missing descriptor for own key "${k}"` };
          }
          if (desc.get !== undefined || desc.set !== undefined) {
            return { ok: false, reason: "accessor properties are not I-JSON" };
          }
          if (!("value" in desc)) {
            return { ok: false, reason: `key "${k}" missing data value` };
          }
          if (desc.value === undefined) {
            return {
              ok: false,
              reason: `key "${k}" has undefined value (not I-JSON)`,
            };
          }
          const child = encodeIJsonInternal(desc.value, seen, depth + 1, budget);
          if (!child.ok) return child;
          parts.push(`${JSON.stringify(k)}:${child.canonical}`);
          Object.defineProperty(snap, k, {
            value: child.snapshot,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        return {
          ok: true,
          canonical: `{${parts.join(",")}}`,
          snapshot: snap,
        };
      } finally {
        seen.delete(obj);
      }
    }
    return { ok: false, reason: "unsupported type is not I-JSON" };
  } catch {
    return { ok: false, reason: "I-JSON encoding reflection failed" };
  }
}

/**
 * Encode with an explicit shared budget (package-internal; request gates only).
 * Always starts a fresh cycle `seen` set and depth 0 for this value root;
 * counters on `budget` accumulate across calls. Not re-exported from package root.
 */
export function encodeIJsonWithBudget(
  value: unknown,
  budget: ResourceBudget,
): DigestEncodeResult {
  const stateFail = validateBudgetState(budget);
  if (stateFail) return stateFail;
  return encodeIJsonInternal(value, new WeakSet(), 0, budget);
}

/**
 * Public encoder — **one logical argument only** (F-007 residual / F-007A).
 * Extra runtime arguments are ignored so callers cannot inject seen/depth/budget
 * to weaken caps. No public budget parameter.
 */
export function encodeIJson(
  value: unknown,
  ..._ignored: unknown[]
): DigestEncodeResult {
  void _ignored;
  return encodeIJsonWithBudget(value, createResourceBudget());
}

/**
 * Digest with an explicit shared budget (package-internal; request gates only).
 * Not re-exported from package root (F-007A).
 */
export function digestValueWithBudget(
  value: unknown,
  budget: ResourceBudget,
): DigestValueResult {
  const encoded = encodeIJsonWithBudget(value, budget);
  if (!encoded.ok) {
    return { ok: false, reason: encoded.reason };
  }
  const digest = createHash("sha256")
    .update(encoded.canonical, "utf8")
    .digest("hex");
  return { ok: true, digest, snapshot: encoded.snapshot };
}

/**
 * SHA-256 hex digest of a strict I-JSON value, or structured failure.
 * Public API starts a fresh budget (single-value). Extra args ignored.
 * Multi-field gates use digestValueWithBudget internally only.
 */
export function digestValue(
  value: unknown,
  ..._ignored: unknown[]
): DigestValueResult {
  void _ignored;
  return digestValueWithBudget(value, createResourceBudget());
}

/**
 * Digest a workspace id string (public one-arg API — fresh budget only).
 * Request gates that share a budget must call digestValueWithBudget directly.
 *
 * **Throws deliberately** on non-I-JSON / over-budget input (same posture as
 * deprecated `canonicalJson`) so accidental call sites fail loud rather than
 * returning a silent empty digest (AR-4). Production gates never call this —
 * they use `digestValueWithBudget` and return structured `INVALID_INPUT`.
 */
export function digestWorkspaceId(workspaceId: string): string {
  const r = digestValue(workspaceId);
  if (!r.ok) {
    throw new Error(`workspaceId digest failed: ${r.reason}`);
  }
  return r.digest;
}

/**
 * Charge property count (+ key-name UTF-8 bytes) for a shallow own-key map
 * without encoding values. Package-internal; used by export gates for shells.
 */
export function chargeOwnPropertyNames(
  names: readonly string[],
  budget: ResourceBudget,
): { ok: true } | { ok: false; reason: string } {
  const propFail = chargeProperties(budget, names.length);
  if (propFail) return propFail;
  let keyBytes = 0;
  for (const n of names) {
    keyBytes += utf8ByteLength(n);
  }
  const byteFail = chargeBytes(budget, keyBytes);
  if (byteFail) return byteFail;
  return { ok: true };
}

/**
 * @deprecated Prefer digestValue (Result). Kept for inspection only — throws
 * on non-I-JSON so accidental call sites fail loud in tests, not silently.
 */
export function canonicalJson(value: unknown): string {
  const encoded = encodeIJson(value);
  if (!encoded.ok) {
    throw new Error(`canonicalJson rejected non-I-JSON: ${encoded.reason}`);
  }
  return encoded.canonical;
}
