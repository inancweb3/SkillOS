/**
 * Safe report-label and string handling for multi-axis / hard-failure surfaces.
 * Never copies raw producer measurement strings into reports, logs, or sidecars.
 */

import { isSecretValue } from "./redaction.js";

/** Max length for scenario/decision labels that remain on the report surface. */
export const SAFE_LABEL_MAX_CHARS = 128;

/**
 * Allowlisted printable label charset (no spaces, no control chars).
 * Digests and common scenario ids (kebab-case) fit this set.
 */
const SAFE_LABEL_RE = /^[A-Za-z0-9._:/\-]+$/;

const UNSAFE_OMITTED = "[omitted:unsafe_label]";

/**
 * True if the string contains C0/C1 control characters (excluding TAB which we
 * still reject for single-line report safety).
 */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Sanitize a reportable label (scenarioId, decision). Never returns secret-shaped
 * or control-character content. Fail closed to a fixed omission token.
 */
export function sanitizeReportLabel(raw: unknown): string {
  if (typeof raw !== "string") return UNSAFE_OMITTED;
  if (raw.length === 0) return UNSAFE_OMITTED;
  if (raw.length > SAFE_LABEL_MAX_CHARS) return UNSAFE_OMITTED;
  if (hasControlChars(raw)) return UNSAFE_OMITTED;
  if (isSecretValue(raw)) return UNSAFE_OMITTED;
  // Portfolio / private-ish sentinels (bounded substring, case-insensitive)
  if (/portfolio|private[_-]?key|mnemonic|seed[_-]?phrase/i.test(raw)) {
    return UNSAFE_OMITTED;
  }
  if (!SAFE_LABEL_RE.test(raw)) return UNSAFE_OMITTED;
  return raw;
}

/**
 * Assert a serialized report payload does not contain known sentinel substrings.
 * Used by tests; production paths must never put raw secrets into reports.
 */
export function reportPayloadLooksClean(serialized: string): boolean {
  const lower = serialized.toLowerCase();
  const banned = [
    "authorization: bearer",
    "bearer ",
    "-----begin",
    "private key",
    "api_key=",
    "access_token=",
    "portfolio_id=",
    "\n",
    "\r",
    "\u0000",
  ];
  for (const b of banned) {
    if (lower.includes(b.toLowerCase()) || serialized.includes(b)) {
      // Allow the fixed omission token and catalog ids only — "bearer " in
      // omission path should not appear. Digests use hex only.
      if (serialized.includes(UNSAFE_OMITTED) && b === "\n") {
        // omission token has no newline
      }
      // Newlines in pretty-printed JSON are expected in CLI output of full payload —
      // this helper is for human summary lines and hardGateSignals joined content.
      if (b === "\n" || b === "\r") continue;
      return false;
    }
  }
  return true;
}

export { UNSAFE_OMITTED };
