/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) with full I-JSON fail-closed input.
 *
 * Rejects: undefined, non-plain objects, cycles (active stack only), lone UTF-16
 * surrogates, NaN/±Infinity/-0 (JCS number rules), functions, symbols, bigint,
 * accessors, non-enumerable own properties, and symbol keys.
 *
 * Values are snapshotted once (own data property values) before serialization so
 * mutating getters cannot TOCTOU validate-vs-hash.
 *
 * Duplicate JSON keys are rejected at parse time via parseJsonStrict (json-parse.ts).
 */

import { assertJcsNumber } from "./numbers.js";
import { ProtocolError } from "./types.js";

/** True iff value is a plain object (Object.prototype or null prototype), not Array/Date/Map/…. */
export function isPlainObject(value: object): boolean {
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject lone UTF-16 surrogates (RFC 8785 §3.2.2.2).
 */
export function assertNoLoneSurrogates(s: string, path = "string"): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) {
        throw new ProtocolError(
          "LONE_SURROGATE",
          `${path}: lone high surrogate at index ${i}`,
        );
      }
      const c2 = s.charCodeAt(i + 1);
      if (c2 < 0xdc00 || c2 > 0xdfff) {
        throw new ProtocolError(
          "LONE_SURROGATE",
          `${path}: lone high surrogate at index ${i}`,
        );
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new ProtocolError(
        "LONE_SURROGATE",
        `${path}: lone low surrogate at index ${i}`,
      );
    }
  }
}

/**
 * Define an own enumerable data property (safe for `__proto__` keys).
 */
function defineDataProp(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Deep I-JSON validation + single-pass snapshot of own enumerable data properties.
 * Active recursion stack: shared DAG refs are allowed; true cycles fail closed.
 */
export function snapshotIJsonValue(
  value: unknown,
  path = "$",
  stack = new WeakSet<object>(),
): unknown {
  if (value === undefined) {
    throw new ProtocolError(
      "INVALID_INPUT",
      `${path}: undefined is not permitted (I-JSON / JCS fail-closed)`,
    );
  }
  if (value === null) {
    return null;
  }
  const t = typeof value;
  if (t === "boolean") {
    return value;
  }
  if (t === "number") {
    assertJcsNumber(value as number, path);
    return value;
  }
  if (t === "string") {
    assertNoLoneSurrogates(value as string, path);
    return value;
  }
  if (t === "bigint" || t === "function" || t === "symbol") {
    throw new ProtocolError(
      "INVALID_INPUT",
      `${path}: unsupported type ${t}`,
    );
  }
  if (t !== "object") {
    throw new ProtocolError(
      "INVALID_INPUT",
      `${path}: unsupported type ${t}`,
    );
  }

  const obj = value as object;
  if (stack.has(obj)) {
    throw new ProtocolError(
      "CYCLE",
      `${path}: cyclic structure is not permitted`,
    );
  }
  stack.add(obj);
  try {
    if (Array.isArray(value)) {
      // Arrays may only carry non-enumerable `length` plus canonical dense
      // indices "0".."length-1". Do NOT allocate O(length) structures — a sparse
      // array with huge .length must fail closed without scanning length times.
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new ProtocolError(
          "INVALID_INPUT",
          `${path}: symbol properties are not permitted on arrays`,
        );
      }
      const len = value.length;
      const names = Object.getOwnPropertyNames(value);
      // Dense array: exactly `length` index props + `length` itself.
      // Sparse (e.g. length=2^32-1 with no elements) has names === ["length"] only.
      if (names.length !== len + 1) {
        throw new ProtocolError(
          "INVALID_INPUT",
          `${path}: array must be dense (own property count must be length + 1); sparse or extra properties are not permitted`,
        );
      }
      for (const name of names) {
        if (name === "length") continue;
        // Canonical index only: String(index) === name, integer, 0 <= index < length.
        // Rejects "01", "extra", "-1", "1.5", etc. without an O(length) allow-set.
        const index = Number(name);
        if (
          !Number.isInteger(index) ||
          String(index) !== name ||
          index < 0 ||
          index >= len
        ) {
          throw new ProtocolError(
            "INVALID_INPUT",
            `${path}: non-index own property ${JSON.stringify(name)} is not permitted on arrays`,
          );
        }
        const desc = Object.getOwnPropertyDescriptor(value, name)!;
        if (desc.get !== undefined || desc.set !== undefined) {
          throw new ProtocolError(
            "INVALID_INPUT",
            `${path}[${name}]: accessor properties are not permitted`,
          );
        }
        if (!desc.enumerable) {
          throw new ProtocolError(
            "INVALID_INPUT",
            `${path}[${name}]: non-enumerable index properties are not permitted`,
          );
        }
      }
      const out: unknown[] = [];
      for (let i = 0; i < len; i++) {
        // Dense check above guarantees every index exists; still fail closed.
        if (!Object.hasOwn(value, i)) {
          throw new ProtocolError(
            "INVALID_INPUT",
            `${path}[${i}]: array hole / undefined element is not permitted`,
          );
        }
        const desc = Object.getOwnPropertyDescriptor(value, String(i))!;
        out.push(snapshotIJsonValue(desc.value, `${path}[${i}]`, stack));
      }
      return out;
    }

    if (!isPlainObject(obj)) {
      throw new ProtocolError(
        "INVALID_INPUT",
        `${path}: non-plain object is not permitted (got ${Object.prototype.toString.call(obj)})`,
      );
    }

    if (Object.getOwnPropertySymbols(obj).length > 0) {
      throw new ProtocolError(
        "INVALID_INPUT",
        `${path}: symbol properties are not permitted`,
      );
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(obj)) {
      const desc = Object.getOwnPropertyDescriptor(obj, key)!;
      if (desc.get !== undefined || desc.set !== undefined) {
        throw new ProtocolError(
          "INVALID_INPUT",
          `${path}.${key}: accessor properties are not permitted`,
        );
      }
      if (!desc.enumerable) {
        throw new ProtocolError(
          "INVALID_INPUT",
          `${path}.${key}: non-enumerable properties are not permitted`,
        );
      }
      assertNoLoneSurrogates(key, `${path}.<key>`);
      // Single read of own data property value
      const v = desc.value;
      if (v === undefined) {
        throw new ProtocolError(
          "INVALID_INPUT",
          `${path}.${key}: undefined property value is not permitted`,
        );
      }
      defineDataProp(out, key, snapshotIJsonValue(v, `${path}.${key}`, stack));
    }
    return out;
  } finally {
    stack.delete(obj);
  }
}

/**
 * Deep I-JSON / protocol structural validation (snapshot side-effect free for callers).
 */
export function assertIJsonValue(
  value: unknown,
  path = "$",
  stack = new WeakSet<object>(),
): void {
  snapshotIJsonValue(value, path, stack);
}

/**
 * Canonicalize a JSON value per RFC 8785.
 * Snapshots first so serialization never re-invokes accessors.
 */
export function canonicalize(value: unknown): string {
  return serialize(snapshotIJsonValue(value));
}

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  const t = typeof value;
  if (t === "boolean") {
    return value ? "true" : "false";
  }
  if (t === "number") {
    return JSON.stringify(value);
  }
  if (t === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      parts.push(serialize(item));
    }
    return `[${parts.join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    // Lexicographic order by UTF-16 code units.
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const key of keys) {
      // Snapshot used defineProperty; read own data only.
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      const v = desc?.value;
      parts.push(`${JSON.stringify(key)}:${serialize(v)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new ProtocolError("INVALID_INPUT", `unsupported JSON type: ${t}`);
}

/** Encode a JS string as UTF-8 bytes. */
export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
