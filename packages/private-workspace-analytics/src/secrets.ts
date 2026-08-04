/**
 * Secret-shaped value detection for fail-closed SkillOS ingress (ADR 0007 D4).
 * SkillOS-owned; not a Simpl3 import. Mirrors the defense-in-depth posture of
 * @skillos/verifier-runner redaction without coupling packages.
 *
 * F-001: top-level field names are checked with isSensitiveKey *before* policy
 * so mixed-case / hyphen / underscore variants cannot bypass the private gate.
 *
 * F-005: scan is applied to the detached I-JSON snapshot, not a second live walk.
 * F-006: reflective failures fail closed (return true = secret/unsafe).
 * F-007: array length over cap fails closed (no truncation).
 */

import { IJSON_MAX_ARRAY_LENGTH, IJSON_MAX_DEPTH, IJSON_MAX_NODES } from "./digest.js";

/**
 * Normalized sensitive-key predicate (case-insensitive; hyphen or underscore).
 * Matches credential-bearing names even when not in the exact always-deny set.
 */
const SENSITIVE_KEY_RE =
  /^(authorization|password|passwd|secret|token|bearer|cookie|set-cookie)$|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|wallet[_-]?secret|jwt|mnemonic|seed[_-]?phrase|portfolio|raw[_-]?trace|unredacted/i;

const SECRET_VALUE_WHOLE_RE =
  /^(?:Bearer\s+\S+|Basic\s+\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*|-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|(?:0x)?[a-fA-F0-9]{64})$/i;

const SECRET_VALUE_EMBEDDED_RES: readonly RegExp[] = [
  /(?:^|[\s;,])(?:Proxy-)?Authorization\s*:\s*Bearer\s+\S+/i,
  /(?:^|[\s;,])(?:Proxy-)?Authorization\s*:\s*Basic\s+\S+/i,
  /(?:^|[\s;,])Bearer\s+[A-Za-z0-9._\-+/=]{8,}/i,
  /(?:^|[\s;,])Basic\s+[A-Za-z0-9._\-+/=]{8,}/i,
  /(?:^|[\s;,])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*\S{8,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/,
];

/** Cap scan length so adversarial megastrings stay fail-closed without OOM. */
const SECRET_SCAN_MAX_CHARS = 64_000;

/**
 * True when a field name is credential/sensitive shaped (normalized).
 * Used at the top-level gate *before* policy (F-001) and for nested scans.
 */
export function isSensitiveKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0) return false;
  return SENSITIVE_KEY_RE.test(key);
}

export function isSecretValue(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length > SECRET_SCAN_MAX_CHARS) return true;
  const t = value.trim();
  if (t.length < 8) return false;
  if (SECRET_VALUE_WHOLE_RE.test(t)) return true;
  if (/BEGIN [A-Z0-9 ]*PRIVATE KEY/.test(t)) return true;
  for (const re of SECRET_VALUE_EMBEDDED_RES) {
    if (re.test(value)) return true;
  }
  return false;
}

type ScanBudget = {
  nodes: number;
};

/**
 * Recursively detect secret-shaped material in a projected value.
 * Uses own-property descriptors only (no prototype walk, no accessor invoke).
 * Returns true if any secret-shaped string / sensitive key is found, or if
 * reflection fails / resource caps are exceeded (fail closed).
 *
 * Prefer scanning a detached encodeIJson snapshot (F-005) so scan and emit
 * bind to the same value.
 *
 * Public signature is value-only; extra runtime args are ignored so callers
 * cannot inject hostile depth/node state (aligned with F-007 residual encoder).
 */
export function containsSecretShaped(
  value: unknown,
  ..._ignored: unknown[]
): boolean {
  void _ignored;
  return containsSecretShapedInternal(value, new WeakSet(), 0, { nodes: 0 });
}

function containsSecretShapedInternal(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  budget: ScanBudget,
): boolean {
  try {
    if (depth > IJSON_MAX_DEPTH) return true;
    budget.nodes += 1;
    if (budget.nodes > IJSON_MAX_NODES) return true;

    if (value === null || value === undefined) return false;
    const t = typeof value;
    if (t === "string") return isSecretValue(value as string);
    if (t === "number" || t === "boolean") return false;
    if (t === "bigint" || t === "function" || t === "symbol") {
      return true;
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) return true;
      seen.add(value);
      try {
        let descriptors: Record<string, PropertyDescriptor>;
        try {
          descriptors = Object.getOwnPropertyDescriptors(value);
        } catch {
          return true;
        }
        // F-008 / F-007B: one-snapshot only — symbols/named extras fail closed.
        let snapshotKeys: Array<string | symbol>;
        try {
          snapshotKeys = Reflect.ownKeys(descriptors);
        } catch {
          return true;
        }
        for (const k of snapshotKeys) {
          if (typeof k === "symbol") return true;
        }
        const lengthDesc = descriptors.length;
        let len = 0;
        if (
          lengthDesc &&
          lengthDesc.get === undefined &&
          lengthDesc.set === undefined &&
          "value" in lengthDesc &&
          typeof lengthDesc.value === "number" &&
          Number.isFinite(lengthDesc.value) &&
          lengthDesc.value >= 0 &&
          Number.isInteger(lengthDesc.value)
        ) {
          // F-007: over-cap length fails closed — never scan a truncated prefix.
          if (lengthDesc.value > IJSON_MAX_ARRAY_LENGTH) return true;
          len = lengthDesc.value;
        } else {
          return true;
        }
        for (const k of snapshotKeys) {
          if (typeof k !== "string") continue;
          if (k === "length") continue;
          // Named non-index keys fail closed (not silently omitted).
          if (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= len || String(Number(k)) !== k) {
            return true;
          }
        }
        for (let i = 0; i < len; i += 1) {
          const desc = descriptors[String(i)];
          if (!desc) continue;
          if (desc.get !== undefined || desc.set !== undefined) return true;
          if (!("value" in desc)) return true;
          if (
            containsSecretShapedInternal(desc.value, seen, depth + 1, budget)
          ) {
            return true;
          }
        }
        return false;
      } finally {
        seen.delete(value);
      }
    }
    if (t === "object") {
      const obj = value as object;
      if (seen.has(obj)) return true;
      seen.add(obj);
      try {
        let proto: object | null;
        try {
          proto = Object.getPrototypeOf(obj);
        } catch {
          return true;
        }
        if (proto !== Object.prototype && proto !== null) return true;
        let descriptors: Record<string, PropertyDescriptor>;
        try {
          descriptors = Object.getOwnPropertyDescriptors(obj);
        } catch {
          return true;
        }
        // F-008: derive keys only from descriptor snapshot — no second ownKeys.
        let snapshotKeys: Array<string | symbol>;
        try {
          snapshotKeys = Reflect.ownKeys(descriptors);
        } catch {
          return true;
        }
        for (const k of snapshotKeys) {
          if (typeof k === "symbol") {
            // Symbol own properties are unsupported — fail closed (not omit).
            return true;
          }
          if (isSensitiveKey(k)) return true;
          const desc = descriptors[k];
          if (!desc) return true;
          if (desc.get !== undefined || desc.set !== undefined) return true;
          if (!("value" in desc)) return true;
          if (
            containsSecretShapedInternal(desc.value, seen, depth + 1, budget)
          ) {
            return true;
          }
        }
        return false;
      } finally {
        seen.delete(obj);
      }
    }
    return true;
  } catch {
    return true;
  }
}
