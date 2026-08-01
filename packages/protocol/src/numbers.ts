/**
 * Number rules:
 * - JCS / I-JSON layer: finite IEEE-754, reject NaN/±Infinity/-0
 * - Protocol documents (ADR 0005 D3.0): additionally integers MUST be Number.isSafeInteger
 */

import { ProtocolError } from "./types.js";

/**
 * JCS/I-JSON number gate (used by canonicalize).
 * Allows exact IEEE doubles outside the safe-integer range (e.g. 1e30 in RFC 8785 samples).
 */
export function assertJcsNumber(value: number, path = "number"): void {
  if (typeof value !== "number") {
    throw new ProtocolError(
      "INVALID_INPUT",
      `${path}: expected number, got ${typeof value}`,
    );
  }
  if (Object.is(value, -0)) {
    throw new ProtocolError(
      "NEGATIVE_ZERO",
      `${path}: negative zero (-0) is rejected`,
    );
  }
  if (Number.isNaN(value)) {
    throw new ProtocolError("NON_FINITE_NUMBER", `${path}: NaN is rejected`);
  }
  if (!Number.isFinite(value)) {
    throw new ProtocolError(
      "NON_FINITE_NUMBER",
      `${path}: non-finite number is rejected`,
    );
  }
}

/**
 * Protocol document number gate: JCS rules + safe integers for whole numbers.
 */
export function assertProtocolNumber(value: number, path = "number"): void {
  assertJcsNumber(value, path);
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new ProtocolError(
      "UNSAFE_NUMBER",
      `${path}: integer must satisfy Number.isSafeInteger`,
      { value },
    );
  }
}

/**
 * Deep-walk a JSON value and enforce protocol number rules on every number.
 * Prefer assertIJsonValue for full structural checks; this remains for number-only walks.
 */
export function assertProtocolNumbers(value: unknown, path = "$"): void {
  if (typeof value === "number") {
    assertProtocolNumber(value, path);
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertProtocolNumbers(value[i], `${path}[${i}]`);
    }
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertProtocolNumbers(v, `${path}.${k}`);
  }
}

/**
 * Parse a finite protocol number from adapter input (string | number).
 * Rejects NaN, non-finite, -0, unsafe integers, empty/non-numeric strings.
 */
export function parseProtocolNumberInput(
  raw: string | number,
  path: string,
): number {
  if (typeof raw === "number") {
    assertProtocolNumber(raw, path);
    return raw;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ProtocolError(
      "INVALID_INPUT",
      `${path}: expected finite number or numeric string`,
    );
  }
  // Reject hex/binary/octal and trailing junk
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw.trim())) {
    throw new ProtocolError(
      "INVALID_INPUT",
      `${path}: invalid numeric string ${JSON.stringify(raw)}`,
    );
  }
  const n = Number(raw);
  assertProtocolNumber(n, path);
  return n;
}
