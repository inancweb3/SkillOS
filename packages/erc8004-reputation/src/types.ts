/**
 * ERC-8004 reputation projection types — ADR 0010.
 * Digest/summary outbound only; one-way by construction.
 */

export const REPUTATION_CONTRACT_VERSION = "0.1.0" as const;

/** Success modes only — no live/mainnet/broadcast success path. */
export const REPUTATION_MODES = Object.freeze(["dry_run", "fixture"] as const);
export type ReputationMode = (typeof REPUTATION_MODES)[number];

/** Allowlisted public summary codes (no free-text). */
export const SUMMARY_CODES = Object.freeze([
  "verified_pass",
  "verified_fail",
  "not_ready",
  "invalid_input",
] as const);
export type SummaryCode = (typeof SUMMARY_CODES)[number];

export type ReputationDenyCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "MODE_FORBIDDEN"
  | "LIVE_PATH_UNREACHABLE"
  | "FUNDED_PATH_UNREACHABLE"
  | "INPUT_INVALID"
  | "DIGEST_INVALID"
  | "SUMMARY_INVALID"
  | "PRIVACY_DENYLIST"
  | "SECRETS_FORBIDDEN"
  | "AUTHORITY_NON_GRANT"
  | "ONE_WAY_VIOLATION";

export type ReputationOk<T> = { readonly ok: true; readonly value: T };
export type ReputationErr = {
  readonly ok: false;
  readonly denyCode: ReputationDenyCode;
  readonly reason: string;
};
export type ReputationResult<T> = ReputationOk<T> | ReputationErr;

/**
 * Inbound projection request — digests + summary only.
 * Must not carry raw evidence bodies.
 */
export type ReputationProjectionInput = {
  /** Subject id digest (e.g. agent subject or code commit) — 64 hex preferred. */
  readonly subjectDigest: string;
  /** Digest of redacted evidence/measurement envelope. */
  readonly evidenceDigest: string;
  readonly summaryCode: SummaryCode;
  /** Optional secondary digest (e.g. schema/id). */
  readonly schemaDigest?: string;
};

/** Dry-run projection receipt (minted into private WeakSet). */
export type ReputationProjection = {
  readonly kind: "skillos.erc8004.reputation.projection";
  readonly contractVersion: typeof REPUTATION_CONTRACT_VERSION;
  readonly mode: ReputationMode;
  readonly subjectDigest: string;
  readonly evidenceDigest: string;
  readonly summaryCode: SummaryCode;
  readonly schemaDigest: string | null;
  /** Deterministic simulated onchain ref — not a real tx. */
  readonly simulatedOnchainRef: string;
  readonly projectedAt: string;
  readonly broadcast: false;
  readonly funded: false;
  readonly live: false;
  readonly promoteAuthorized: false;
  readonly executeEnabled: false;
  /** Explicit: one-way export only. */
  readonly oneWayOutbound: true;
};

export type ReputationAuthorityFlags = {
  readonly promoteAuthorized: false;
  readonly executeEnabled: false;
  readonly x402FundedSpend: false;
  readonly walletSpend: false;
  readonly cdpSpend: false;
  readonly controlPlaneUnpause: false;
  readonly policyBypass: false;
  /** Reputation is never an inbound decision authority. */
  readonly reputationInboundAuthority: false;
};

export type ReputationConfigInput = {
  readonly mode?: unknown;
  readonly live?: unknown;
  readonly funded?: unknown;
  readonly broadcast?: unknown;
  readonly production?: unknown;
  readonly mainnet?: unknown;
  readonly privateKey?: unknown;
  readonly rpcUrl?: unknown;
};

export type ReputationConfig = {
  readonly kind: "skillos.erc8004.reputation.config";
  readonly mode: ReputationMode;
  readonly live: false;
  readonly funded: false;
  readonly broadcast: false;
  readonly production: false;
  readonly mainnet: false;
};

export function isReputationMode(v: unknown): v is ReputationMode {
  return v === "dry_run" || v === "fixture";
}

export function isSummaryCode(v: unknown): v is SummaryCode {
  return (
    v === "verified_pass" ||
    v === "verified_fail" ||
    v === "not_ready" ||
    v === "invalid_input"
  );
}

/** 32+ hex chars (SHA-256 full preferred; min 32 for fail-closed floor). */
export function isDigestHex(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-fA-F]{32,128}$/.test(v.trim());
}
