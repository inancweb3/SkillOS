/**
 * Rail-neutral billing types — ADR 0009.
 * Funded / mainnet / live settle are not first-class success modes.
 */

/** Contract version pin. */
export const BILLING_CONTRACT_VERSION = "0.1.0" as const;

/**
 * Only modes that may produce a successful dry-run/fixture settlement.
 * No `mainnet` | `funded` | `live` | `production` in this union.
 */
export const BILLING_MODES = Object.freeze(["dry_run", "fixture"] as const);

export type BillingMode = (typeof BILLING_MODES)[number];

/** Assets allowed in quotes (symbolic — no chain client). */
export const BILLING_ASSETS = Object.freeze(["USDC"] as const);
export type BillingAsset = (typeof BILLING_ASSETS)[number];

export type BillingDenyCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "MODE_FORBIDDEN"
  | "FUNDED_PATH_UNREACHABLE"
  | "MAINNET_FORBIDDEN"
  | "PRODUCTION_FORBIDDEN"
  | "QUOTE_INVALID"
  | "AUTH_DENIED"
  | "AMOUNT_INVALID"
  | "REQUEST_INVALID"
  | "AUTHORITY_NON_GRANT";

export type BillingRequest = {
  readonly requestId: string;
  /** Atomic units (e.g. USDC 6 decimals). Must be > 0n for success paths. */
  readonly amountAtomic: bigint;
  readonly asset: BillingAsset;
  /** Optional subject digest (commit / evidence id) — redacted public id only. */
  readonly subjectDigest?: string;
};

/**
 * Price quote. Object identity is registered in a private WeakSet at mint
 * (quoteBilling). Shape-only forgeries fail isBillingQuote and cannot authorize.
 */
export type BillingQuote = {
  readonly kind: "skillos.billing.quote";
  readonly contractVersion: typeof BILLING_CONTRACT_VERSION;
  readonly requestId: string;
  readonly amountAtomic: bigint;
  readonly asset: BillingAsset;
  readonly mode: BillingMode;
  readonly subjectDigest: string | null;
  /** Always false — quotes never fund a rail. */
  readonly funded: false;
  readonly liveSettle: false;
};

/**
 * Authorization. Minted only from a registry-backed quote (authorizeBilling).
 * Shape-only forgeries fail isBillingAuthorization and cannot settle.
 */
export type BillingAuthorization = {
  readonly kind: "skillos.billing.authorization";
  readonly contractVersion: typeof BILLING_CONTRACT_VERSION;
  readonly requestId: string;
  readonly amountAtomic: bigint;
  readonly asset: BillingAsset;
  readonly mode: BillingMode;
  readonly authorized: true;
  readonly funded: false;
  readonly liveSettle: false;
};

/**
 * Simulated settlement receipt. Object identity is registered in a private
 * WeakSet at mint time — shape-only forgeries are rejected by isBillingReceipt.
 * Settle only accepts authorizations from AUTH mint registry (X-1 chain).
 */
export type BillingReceipt = {
  readonly kind: "skillos.billing.receipt";
  readonly contractVersion: typeof BILLING_CONTRACT_VERSION;
  readonly requestId: string;
  readonly amountAtomic: bigint;
  readonly asset: BillingAsset;
  readonly mode: BillingMode;
  readonly simulatedTxId: string;
  readonly settledAt: string;
  readonly funded: false;
  readonly liveSettle: false;
  readonly promoteAuthorized: false;
  readonly executeEnabled: false;
};

export type BillingOk<T> = {
  readonly ok: true;
  readonly value: T;
};

export type BillingErr = {
  readonly ok: false;
  readonly denyCode: BillingDenyCode;
  readonly reason: string;
};

export type BillingResult<T> = BillingOk<T> | BillingErr;

/**
 * Authority flags that billing must never set true.
 * Aligns with private-workspace-analytics deny labels.
 */
export type BillingAuthorityFlags = {
  readonly promoteAuthorized: false;
  readonly executeEnabled: false;
  readonly x402FundedSpend: false;
  readonly walletSpend: false;
  readonly controlPlaneUnpause: false;
  readonly policyBypass: false;
};

/** Raw untrusted config bag — may contain forbidden keys from env/callers. */
export type BillingConfigInput = {
  readonly mode?: unknown;
  readonly production?: unknown;
  readonly mainnet?: unknown;
  readonly funded?: unknown;
  readonly liveSettle?: unknown;
  readonly facilitatorUrl?: unknown;
  readonly privateKey?: unknown;
};

/**
 * Validated config. Only constructible via createBillingConfig / parseBillingConfig.
 * Forbidden flags are hard-false by type.
 */
export type BillingConfig = {
  readonly kind: "skillos.billing.config";
  readonly mode: BillingMode;
  readonly production: false;
  readonly mainnet: false;
  readonly funded: false;
  readonly liveSettle: false;
};

export function isBillingMode(v: unknown): v is BillingMode {
  return v === "dry_run" || v === "fixture";
}

export function isBillingAsset(v: unknown): v is BillingAsset {
  return v === "USDC";
}
