/**
 * Digest format, projections, and compute helpers (ADR 0005 D3).
 */

import {
  canonicalize,
  isPlainObject,
  snapshotIJsonValue,
  utf8Bytes,
} from "./jcs.js";
import {
  type DigestProjection,
  type EvidenceEnvelope,
  type BenchmarkManifest,
  type VerifierDescriptor,
  type VerificationResult,
  ProtocolError,
} from "./types.js";

export const DIGEST_FORMAT_RE = /^sha256:[0-9a-f]{64}$/;

/**
 * assertDigestFormat — enforces sha256: + 64 lowercase hex only.
 */
export function assertDigestFormat(digest: string): void {
  if (typeof digest !== "string" || !DIGEST_FORMAT_RE.test(digest)) {
    throw new ProtocolError(
      "INVALID_DIGEST_FORMAT",
      `invalid digest format: expected sha256:<64 lowercase hex>, got ${JSON.stringify(digest)}`,
    );
  }
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * SHA-256 via Web Crypto (browser + Node 20+). No native addon.
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ProtocolError(
      "INVALID_INPUT",
      "Web Crypto subtle.digest is required (browser or Node >= 20)",
    );
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const hash = await subtle.digest("SHA-256", copy.buffer);
  return bytesToHex(hash);
}

/**
 * Digest of a full JSON value (no field omission) — used for provenance pins.
 * digest = "sha256:" + hex(SHA-256(utf8(JCS(value))))
 */
export async function digestJsonValue(value: unknown): Promise<string> {
  const canonical = canonicalize(value);
  const hex = await sha256Hex(utf8Bytes(canonical));
  const digest = `sha256:${hex}`;
  assertDigestFormat(digest);
  return digest;
}

/**
 * Apply normative projection (D3.1) then return projected JSON value.
 *
 * Requires a plain object at the root; full I-JSON snapshot is taken so Map/Date
 * and accessors cannot collapse to `{}` or TOCTOU the hash.
 */
export function applyProjection(
  value: unknown,
  projection: DigestProjection,
): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isPlainObject(value)
  ) {
    throw new ProtocolError(
      "INVALID_INPUT",
      `projection ${projection} requires a plain object (got ${
        value === null
          ? "null"
          : Array.isArray(value)
            ? "array"
            : typeof value === "object"
              ? Object.prototype.toString.call(value)
              : typeof value
      })`,
    );
  }

  // Snapshot once (rejects non-plain nested values, accessors, cycles, …).
  const snap = snapshotIJsonValue(value) as Record<string, unknown>;

  switch (projection) {
    case "manifest":
      return snap;
    case "evidence": {
      const out = copyOwnData(snap);
      delete out.signature;
      return out;
    }
    case "verifier": {
      const out = copyOwnData(snap);
      delete out.digest;
      return out;
    }
    case "result": {
      const out = copyOwnData(snap);
      delete out.resultDigest;
      delete out.signature;
      return out;
    }
    default: {
      const _exhaustive: never = projection;
      throw new ProtocolError(
        "INVALID_INPUT",
        `unknown projection: ${_exhaustive}`,
      );
    }
  }
}

/** Shallow copy of own enumerable data props via descriptors (safe for __proto__). */
function copyOwnData(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(src)) {
    const desc = Object.getOwnPropertyDescriptor(src, key)!;
    Object.defineProperty(out, key, {
      value: desc.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * computeDigest — apply projection, JCS, SHA-256, format string.
 */
export async function computeDigest(
  value: unknown,
  projection: DigestProjection,
): Promise<string> {
  const projected = applyProjection(value, projection);
  // Projected value is already a safe snapshot; canonicalize re-validates structure.
  return digestJsonValue(projected);
}

export async function digestManifest(
  manifest: BenchmarkManifest,
): Promise<string> {
  return computeDigest(manifest, "manifest");
}

export async function digestEvidence(
  evidence: EvidenceEnvelope,
): Promise<string> {
  return computeDigest(evidence, "evidence");
}

export async function digestVerifier(
  verifier: Omit<VerifierDescriptor, "digest"> | VerifierDescriptor,
): Promise<string> {
  return computeDigest(verifier, "verifier");
}

export async function digestResult(
  result: VerificationResult | Omit<VerificationResult, "resultDigest">,
): Promise<string> {
  return computeDigest(result, "result");
}
