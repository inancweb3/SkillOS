/**
 * Privacy contract types — ADR 0007.
 *
 * Public classification tables are frozen inspection snapshots. The export
 * gate keeps a private always-deny key matrix (see export.ts) so mutating any
 * export cannot reopen private fields (F-001 style).
 */

/** Contract version pin (package surface). */
export const PRIVACY_CONTRACT_VERSION = "0.1.0" as const;

/**
 * Field classifications for private-workspace → SkillOS projection.
 * Inspection-only table is frozen; gate uses private enforcement copy.
 */
export const FIELD_CLASSES = Object.freeze([
  "public",
  "digest",
  "aggregate",
  "private",
] as const);

export type FieldClass = (typeof FIELD_CLASSES)[number];

/**
 * Inspection-only always-private key names (frozen).
 * Gate enforcement uses a private copy in export.ts — mutating this export
 * must not change gate outcomes.
 */
export const ALWAYS_PRIVATE_KEYS: ReadonlyArray<string> = Object.freeze([
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

/**
 * Authority action labels that analytics/export must never grant.
 * Inspection-only; gate uses a private set.
 */
export const FORBIDDEN_AUTHORITY_ACTIONS = Object.freeze([
  "request_execute",
  "issue_promotion_authorization",
  "wallet_spend",
  "x402_funded_spend",
  "control_plane_unpause",
] as const);

export type ForbiddenAuthorityAction =
  (typeof FORBIDDEN_AUTHORITY_ACTIONS)[number];

export type ExportDenyCode =
  | "MISSING_POLICY"
  | "INVALID_INPUT"
  | "UNCLASSIFIED_FIELD"
  | "PRIVATE_FIELD"
  | "SECRET_SHAPED_VALUE"
  | "AGGREGATE_TYPE_MISMATCH"
  | "EXPORT_AUTHORITY_FORBIDDEN"
  | "RAW_PRIVATE_EXPORT";

/**
 * Versioned export policy — allowlist of field → classification.
 * Absent fields in the workspace that are not in the policy are fine;
 * present workspace fields without a policy entry fail closed.
 */
export interface ExportPolicy {
  readonly contractVersion: typeof PRIVACY_CONTRACT_VERSION;
  readonly fields: Readonly<Record<string, FieldClass>>;
}

/**
 * Private workspace record held outside SkillOS (local / fixture).
 * SkillOS never receives this structure whole — only projected exports.
 */
export interface PrivateWorkspaceRecord {
  readonly workspaceId: string;
  /** Opaque local fields; classification is owned by ExportPolicy. */
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Successful SkillOS-bound export body (digests + public projections only). */
export interface SkillOSIngressExport {
  readonly contractVersion: typeof PRIVACY_CONTRACT_VERSION;
  readonly workspaceIdDigest: string;
  /** Projected fields after classification (public values or digests). */
  readonly projected: Readonly<Record<string, unknown>>;
  /** Field names that were digested (for provenance). */
  readonly digestedFields: ReadonlyArray<string>;
  /** Field names that were exported as public (for provenance). */
  readonly publicFields: ReadonlyArray<string>;
}

export interface ExportDecision {
  readonly contractVersion: typeof PRIVACY_CONTRACT_VERSION;
  readonly admit: boolean;
  readonly workspaceIdDigest: string | null;
  readonly export: SkillOSIngressExport | null;
  readonly denyCode: ExportDenyCode | null;
  readonly reason: string;
}

/**
 * Analytics summary safe to retain on SkillOS surfaces.
 * Numbers + digests only — never raw private payloads.
 * Hard-false authority flags cover the full FORBIDDEN_AUTHORITY_ACTIONS set
 * (AR-3); digests map is accompanied by provenance lists (AR-2).
 */
export interface AnalyticsSummary {
  readonly contractVersion: typeof PRIVACY_CONTRACT_VERSION;
  readonly workspaceIdDigest: string;
  readonly fieldCount: number;
  readonly aggregates: Readonly<Record<string, number>>;
  /**
   * SHA-256 digests of fields classified `digest` or `public`.
   * Public fields are digested — never raw-projected — into analytics (ADR 0007 D3).
   */
  readonly digests: Readonly<Record<string, string>>;
  /** Provenance: field names classified `digest` that appear in `digests` (AR-2). */
  readonly digestedFields: ReadonlyArray<string>;
  /**
   * Provenance: field names classified `public` that appear in `digests`
   * (one-way; not raw public projection) (AR-2).
   */
  readonly publicDigestedFields: ReadonlyArray<string>;
  /** Always false — analytics is never an authority grant (full deny-set coverage). */
  readonly grantsExecutionAuthority: false;
  readonly grantsPromotionAuthority: false;
  readonly grantsWalletAuthority: false;
  /** Always false — x402_funded_spend never granted (AR-3). */
  readonly grantsFundedSpendAuthority: false;
  /** Always false — control_plane_unpause never granted (AR-3). */
  readonly grantsControlPlaneAuthority: false;
}

export interface AnalyticsDecision {
  readonly contractVersion: typeof PRIVACY_CONTRACT_VERSION;
  readonly admit: boolean;
  readonly summary: AnalyticsSummary | null;
  readonly denyCode: ExportDenyCode | null;
  readonly reason: string;
}

export function isFieldClass(v: unknown): v is FieldClass {
  return (
    typeof v === "string" &&
    (FIELD_CLASSES as readonly string[]).includes(v)
  );
}

export function isForbiddenAuthorityAction(
  v: unknown,
): v is ForbiddenAuthorityAction {
  return (
    typeof v === "string" &&
    (FORBIDDEN_AUTHORITY_ACTIONS as readonly string[]).includes(v)
  );
}

/** Deep-freeze a policy snapshot for safe registry-like handoff (null-proto fields). */
export function freezeExportPolicy(policy: ExportPolicy): ExportPolicy {
  const fields = Object.create(null) as Record<string, FieldClass>;
  for (const [k, v] of Object.entries(policy.fields)) {
    Object.defineProperty(fields, k, {
      value: v,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
  return Object.freeze({
    contractVersion: PRIVACY_CONTRACT_VERSION,
    fields: Object.freeze(fields),
  });
}
