/**
 * Digest/summary projection + dry-run only. Live broadcast unreachable.
 */

import { parseReputationConfig } from "./config.js";
import {
  REPUTATION_CONTRACT_VERSION,
  isDigestHex,
  isSummaryCode,
  type ReputationConfig,
  type ReputationConfigInput,
  type ReputationProjection,
  type ReputationProjectionInput,
  type ReputationResult,
} from "./types.js";

const PROJECTION_REGISTRY = new WeakSet<object>();

/** Keys that must never appear on inbound projection bags (privacy denylist). */
const DENYLIST_KEY_FRAGMENTS = Object.freeze([
  "evidencebody",
  "rawevidence",
  "trace",
  "rationale",
  "portfolio",
  "privatekey",
  "private_key",
  "apikey",
  "api_key",
  "mnemonic",
  "secret",
  "password",
  "authorization",
  "bearer",
]);

function deny<T>(
  denyCode: import("./types.js").ReputationDenyCode,
  reason: string,
): ReputationResult<T> {
  return { ok: false, denyCode, reason };
}

function resolveConfig(
  config: ReputationConfig | ReputationConfigInput | null | undefined,
): ReputationResult<ReputationConfig> {
  if (
    config != null &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    (config as ReputationConfig).kind === "skillos.erc8004.reputation.config"
  ) {
    const c = config as ReputationConfig;
    if (
      c.live !== false ||
      c.funded !== false ||
      c.broadcast !== false ||
      c.production !== false ||
      c.mainnet !== false
    ) {
      return deny("CONFIG_INVALID", "config flags must remain hard-false");
    }
    if (c.mode !== "dry_run" && c.mode !== "fixture") {
      return deny("MODE_FORBIDDEN", "mode not allowed");
    }
    return { ok: true, value: c };
  }
  return parseReputationConfig(config as ReputationConfigInput | null | undefined);
}

function scanDenylistKeys(obj: object): string | null {
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
    for (const frag of DENYLIST_KEY_FRAGMENTS) {
      if (lower.includes(frag)) {
        return key;
      }
    }
  }
  return null;
}

/**
 * Project digest/summary into a dry-run reputation receipt.
 * Never broadcasts; never grants authority.
 */
export function projectReputation(
  input: ReputationProjectionInput,
  config: ReputationConfig | ReputationConfigInput | null | undefined,
  opts?: { projectedAt?: string },
): ReputationResult<ReputationProjection> {
  const cfg = resolveConfig(config);
  if (!cfg.ok) return cfg;

  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return deny("INPUT_INVALID", "projection input is required");
  }

  const deniedKey = scanDenylistKeys(input as object);
  if (deniedKey) {
    return deny(
      "PRIVACY_DENYLIST",
      `inbound field forbidden for onchain projection: ${deniedKey}`,
    );
  }

  // Also reject unexpected free-form keys beyond allowlist
  const allowed = new Set([
    "subjectDigest",
    "evidenceDigest",
    "summaryCode",
    "schemaDigest",
  ]);
  for (const key of Object.keys(input as object)) {
    if (!allowed.has(key)) {
      return deny(
        "PRIVACY_DENYLIST",
        `unexpected projection field: ${key}`,
      );
    }
  }

  if (!isDigestHex(input.subjectDigest)) {
    return deny("DIGEST_INVALID", "subjectDigest must be hex digest ≥32 chars");
  }
  if (!isDigestHex(input.evidenceDigest)) {
    return deny("DIGEST_INVALID", "evidenceDigest must be hex digest ≥32 chars");
  }
  if (!isSummaryCode(input.summaryCode)) {
    return deny("SUMMARY_INVALID", "summaryCode not in allowlist");
  }
  let schemaDigest: string | null = null;
  if (input.schemaDigest != null) {
    if (!isDigestHex(input.schemaDigest)) {
      return deny("DIGEST_INVALID", "schemaDigest must be hex digest ≥32 chars");
    }
    schemaDigest = input.schemaDigest.trim().toLowerCase();
  }

  const subjectDigest = input.subjectDigest.trim().toLowerCase();
  const evidenceDigest = input.evidenceDigest.trim().toLowerCase();
  const projectedAt =
    typeof opts?.projectedAt === "string" && opts.projectedAt.length >= 10
      ? opts.projectedAt
      : new Date(0).toISOString();

  const projection: ReputationProjection = Object.freeze({
    kind: "skillos.erc8004.reputation.projection",
    contractVersion: REPUTATION_CONTRACT_VERSION,
    mode: cfg.value.mode,
    subjectDigest,
    evidenceDigest,
    summaryCode: input.summaryCode,
    schemaDigest,
    simulatedOnchainRef: `sim_rep_${cfg.value.mode}_${subjectDigest.slice(0, 16)}`,
    projectedAt,
    broadcast: false,
    funded: false,
    live: false,
    promoteAuthorized: false,
    executeEnabled: false,
    oneWayOutbound: true,
  });
  PROJECTION_REGISTRY.add(projection);
  return { ok: true, value: projection };
}

/** Live/onchain broadcast — always denied. */
export function broadcastReputationLive(
  _input: ReputationProjectionInput | null | undefined,
  _config: ReputationConfigInput | null | undefined,
): ReputationResult<never> {
  void _input;
  void _config;
  return deny(
    "LIVE_PATH_UNREACHABLE",
    "live ERC-8004 reputation broadcast is unreachable by construction (ADR 0010)",
  );
}

export function isReputationProjection(
  value: unknown,
): value is ReputationProjection {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!PROJECTION_REGISTRY.has(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.kind === "skillos.erc8004.reputation.projection" &&
    v.broadcast === false &&
    v.live === false &&
    v.funded === false &&
    v.promoteAuthorized === false &&
    v.executeEnabled === false &&
    v.oneWayOutbound === true
  );
}
