/**
 * SkillOS-owned fail-closed redaction for portable toolTrace defense-in-depth.
 *
 * Not a Simpl3 import. Mirrors the public producer contract that toolTrace must
 * already be fully redacted (canonical equality after recursive redaction).
 * Used only to reject unredacted secret-shaped material in consumer checks.
 */

const SENSITIVE_KEY_RE =
  /^(authorization|password|passwd|secret|token|bearer|cookie|set-cookie)$|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|wallet[_-]?secret|jwt|mnemonic|seed[_-]?phrase/i;

/**
 * Whole-string secret shapes (exact match after trim).
 * Auth schemes are case-insensitive per HTTP (RFC 9110); match with /i.
 */
const SECRET_VALUE_WHOLE_RE =
  /^(?:Bearer\s+\S+|Basic\s+\S+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*|-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|(?:0x)?[a-fA-F0-9]{64})$/i;

/**
 * Embedded credential material anywhere in a string (bounded, fail-closed).
 * Catches log/error lines such as `… Authorization: Bearer <token> …`.
 * Bare Bearer/Basic scheme tokens are case-insensitive.
 */
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

const REDACTED = "[REDACTED]";
const EXOTIC = "[NON_IJSON]";

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key);
}

export function isSecretValue(value: string): boolean {
  if (typeof value !== "string") return false;
  // Bound work: oversize strings are treated as secret-bearing (fail closed).
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

function isPlainRecord(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-clone with sensitive keys/values replaced. Accessor-safe, cycle-safe.
 */
export function redactDeep(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || value === undefined) return value;

  const t = typeof value;
  if (t === "string") {
    return isSecretValue(value as string) ? REDACTED : value;
  }
  if (t === "number") {
    return Number.isFinite(value as number) ? value : EXOTIC;
  }
  if (t === "boolean") return value;
  if (t === "bigint" || t === "function" || t === "symbol") return EXOTIC;

  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACTED;
    seen.add(value);
    try {
      let descriptors: Record<string, PropertyDescriptor>;
      try {
        descriptors = Object.getOwnPropertyDescriptors(value);
      } catch {
        return REDACTED;
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
        lengthDesc.value >= 0
      ) {
        len = Math.min(Math.floor(lengthDesc.value), 1_000_000);
      } else if (
        lengthDesc &&
        (lengthDesc.get !== undefined || lengthDesc.set !== undefined)
      ) {
        return [];
      }
      const out: unknown[] = new Array(len);
      for (let i = 0; i < len; i += 1) {
        const key = String(i);
        const desc = descriptors[key];
        if (!desc) continue;
        if (isSensitiveKey(key)) {
          out[i] = REDACTED;
          continue;
        }
        if (desc.get !== undefined || desc.set !== undefined) {
          out[i] = REDACTED;
          continue;
        }
        if (!("value" in desc)) {
          out[i] = REDACTED;
          continue;
        }
        out[i] = redactDeep(desc.value, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  if (t === "object") {
    if (!isPlainRecord(value as object)) return EXOTIC;
    if (seen.has(value as object)) return REDACTED;
    seen.add(value as object);
    try {
      let descriptors: Record<string, PropertyDescriptor>;
      try {
        descriptors = Object.getOwnPropertyDescriptors(value as object);
      } catch {
        return REDACTED;
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(descriptors)) {
        if (isSensitiveKey(key)) {
          out[key] = REDACTED;
          continue;
        }
        const desc = descriptors[key]!;
        if (desc.get !== undefined || desc.set !== undefined) {
          out[key] = REDACTED;
          continue;
        }
        if (!("value" in desc)) {
          out[key] = REDACTED;
          continue;
        }
        out[key] = redactDeep(desc.value, seen);
      }
      return out;
    } finally {
      seen.delete(value as object);
    }
  }

  return EXOTIC;
}
