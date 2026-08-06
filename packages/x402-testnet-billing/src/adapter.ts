/**
 * Rail-neutral billing adapter — quote / authorize / settle (dry-run only).
 * ADR 0009 D2–D3. No network, facilitator, or USDC.
 */

import { parseBillingConfig } from "./config.js";
import {
  BILLING_CONTRACT_VERSION,
  isBillingAsset,
  type BillingAuthorization,
  type BillingConfig,
  type BillingConfigInput,
  type BillingQuote,
  type BillingReceipt,
  type BillingRequest,
  type BillingResult,
} from "./types.js";

/**
 * Module-private mint registries (same pattern as monorepo configPromotion / F-1).
 * Shape-only forgeries never pass type guards; skip-chain predecessors fail closed.
 * X-1: quote → authorize → settle is integrity-bound by object identity.
 */
const QUOTE_REGISTRY = new WeakSet<object>();
const AUTH_REGISTRY = new WeakSet<object>();
const RECEIPT_REGISTRY = new WeakSet<object>();

function deny<T>(
  denyCode: import("./types.js").BillingDenyCode,
  reason: string,
): BillingResult<T> {
  return { ok: false, denyCode, reason };
}

function resolveConfig(
  config: BillingConfig | BillingConfigInput | null | undefined,
): BillingResult<BillingConfig> {
  if (
    config != null &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    (config as BillingConfig).kind === "skillos.billing.config"
  ) {
    const c = config as BillingConfig;
    // Re-validate sealed flags — never trust a hand-built shape
    if (
      c.production !== false ||
      c.mainnet !== false ||
      c.funded !== false ||
      c.liveSettle !== false
    ) {
      return deny("CONFIG_INVALID", "config flags must remain hard-false");
    }
    if (c.mode !== "dry_run" && c.mode !== "fixture") {
      return deny("MODE_FORBIDDEN", "mode not allowed");
    }
    return { ok: true, value: c };
  }
  return parseBillingConfig(config as BillingConfigInput | null | undefined);
}

function validateRequest(req: BillingRequest | null | undefined): BillingResult<BillingRequest> {
  if (req == null || typeof req !== "object") {
    return deny("REQUEST_INVALID", "request is required");
  }
  if (typeof req.requestId !== "string" || req.requestId.trim().length === 0) {
    return deny("REQUEST_INVALID", "requestId must be non-empty");
  }
  if (typeof req.amountAtomic !== "bigint" || req.amountAtomic <= 0n) {
    return deny("AMOUNT_INVALID", "amountAtomic must be a positive bigint");
  }
  if (!isBillingAsset(req.asset)) {
    return deny("REQUEST_INVALID", "asset must be USDC");
  }
  return {
    ok: true,
    value: {
      requestId: req.requestId.trim(),
      amountAtomic: req.amountAtomic,
      asset: req.asset,
      subjectDigest:
        typeof req.subjectDigest === "string" && req.subjectDigest.trim()
          ? req.subjectDigest.trim()
          : undefined,
    },
  };
}

/**
 * Produce a price quote — no network, never funded.
 */
export function quoteBilling(
  request: BillingRequest,
  config: BillingConfig | BillingConfigInput | null | undefined,
): BillingResult<BillingQuote> {
  const cfg = resolveConfig(config);
  if (!cfg.ok) return cfg;
  const req = validateRequest(request);
  if (!req.ok) return req;

  const quote: BillingQuote = Object.freeze({
    kind: "skillos.billing.quote",
    contractVersion: BILLING_CONTRACT_VERSION,
    requestId: req.value.requestId,
    amountAtomic: req.value.amountAtomic,
    asset: req.value.asset,
    mode: cfg.value.mode,
    subjectDigest: req.value.subjectDigest ?? null,
    funded: false,
    liveSettle: false,
  });
  QUOTE_REGISTRY.add(quote);
  return { ok: true, value: quote };
}

/**
 * Authorize a dry-run/fixture quote for simulated settle.
 */
export function authorizeBilling(
  quote: BillingQuote | BillingResult<BillingQuote>,
  config: BillingConfig | BillingConfigInput | null | undefined,
): BillingResult<BillingAuthorization> {
  const cfg = resolveConfig(config);
  if (!cfg.ok) return cfg;

  const q =
    quote != null &&
    typeof quote === "object" &&
    "ok" in quote &&
    (quote as BillingResult<BillingQuote>).ok === true
      ? (quote as { ok: true; value: BillingQuote }).value
      : (quote as BillingQuote);

  if (q == null || typeof q !== "object" || Array.isArray(q) || q.kind !== "skillos.billing.quote") {
    return deny("QUOTE_INVALID", "quote is required");
  }
  // X-1: only quotes minted by quoteBilling may authorize (hand-built bags fail closed).
  if (!QUOTE_REGISTRY.has(q)) {
    return deny(
      "QUOTE_INVALID",
      "quote not minted by quoteBilling (chain provenance)",
    );
  }
  if (q.contractVersion !== BILLING_CONTRACT_VERSION) {
    return deny("QUOTE_INVALID", "quote contract version mismatch");
  }
  // Defensive: untrusted quote bags may lie at runtime despite typed false
  if ((q as { funded?: unknown }).funded === true || (q as { liveSettle?: unknown }).liveSettle === true) {
    return deny("FUNDED_PATH_UNREACHABLE", "funded quote cannot be authorized");
  }
  if (q.mode !== cfg.value.mode) {
    return deny("AUTH_DENIED", "quote mode does not match config mode");
  }
  if (q.mode !== "dry_run" && q.mode !== "fixture") {
    return deny("MODE_FORBIDDEN", "mode not allowed for authorize");
  }
  if (typeof q.amountAtomic !== "bigint" || q.amountAtomic <= 0n) {
    return deny("AMOUNT_INVALID", "quote amount invalid");
  }

  const auth: BillingAuthorization = Object.freeze({
    kind: "skillos.billing.authorization",
    contractVersion: BILLING_CONTRACT_VERSION,
    requestId: q.requestId,
    amountAtomic: q.amountAtomic,
    asset: q.asset,
    mode: q.mode,
    authorized: true,
    funded: false,
    liveSettle: false,
  });
  AUTH_REGISTRY.add(auth);
  return { ok: true, value: auth };
}

/**
 * Simulated settle — dry_run/fixture only. Never opens network or spends USDC.
 */
export function settleBilling(
  authorization: BillingAuthorization | BillingResult<BillingAuthorization>,
  config: BillingConfig | BillingConfigInput | null | undefined,
  opts?: { decidedAt?: string },
): BillingResult<BillingReceipt> {
  const cfg = resolveConfig(config);
  if (!cfg.ok) return cfg;

  const a =
    authorization != null &&
    typeof authorization === "object" &&
    "ok" in authorization &&
    (authorization as BillingResult<BillingAuthorization>).ok === true
      ? (authorization as { ok: true; value: BillingAuthorization }).value
      : (authorization as BillingAuthorization);

  if (
    a == null ||
    typeof a !== "object" ||
    Array.isArray(a) ||
    a.kind !== "skillos.billing.authorization"
  ) {
    return deny("AUTH_DENIED", "authorization is required");
  }
  // X-1: only authorizations minted by authorizeBilling may settle.
  if (!AUTH_REGISTRY.has(a)) {
    return deny(
      "AUTH_DENIED",
      "authorization not minted by authorizeBilling (chain provenance)",
    );
  }
  if (a.authorized !== true) {
    return deny("AUTH_DENIED", "authorization not granted");
  }
  if ((a as { funded?: unknown }).funded === true || (a as { liveSettle?: unknown }).liveSettle === true) {
    return deny("FUNDED_PATH_UNREACHABLE", "funded authorization cannot settle");
  }
  if (a.mode !== cfg.value.mode) {
    return deny("AUTH_DENIED", "authorization mode does not match config");
  }
  if (a.mode !== "dry_run" && a.mode !== "fixture") {
    return deny("MODE_FORBIDDEN", "mode not allowed for settle");
  }

  const settledAt =
    typeof opts?.decidedAt === "string" && opts.decidedAt.length >= 10
      ? opts.decidedAt
      : new Date(0).toISOString(); // deterministic default for tests

  const receipt: BillingReceipt = Object.freeze({
    kind: "skillos.billing.receipt",
    contractVersion: BILLING_CONTRACT_VERSION,
    requestId: a.requestId,
    amountAtomic: a.amountAtomic,
    asset: a.asset,
    mode: a.mode,
    simulatedTxId: `sim_${a.mode}_${a.requestId}`,
    settledAt,
    funded: false,
    liveSettle: false,
    promoteAuthorized: false,
    executeEnabled: false,
  });
  RECEIPT_REGISTRY.add(receipt);
  return { ok: true, value: receipt };
}

/**
 * Live / funded settle entry — always denied. Unreachable success path.
 * Exists so call sites cannot invent a "live" success by omitting dry-run.
 */
export function settleLiveFundedBilling(
  _request: BillingRequest | null | undefined,
  _config: BillingConfigInput | null | undefined,
): BillingResult<never> {
  void _request;
  void _config;
  return deny(
    "FUNDED_PATH_UNREACHABLE",
    "live funded settle is unreachable by construction (ADR 0009)",
  );
}

/** Type guard: only quotes minted by quoteBilling (X-1). */
export function isBillingQuote(value: unknown): value is BillingQuote {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!QUOTE_REGISTRY.has(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.kind === "skillos.billing.quote" &&
    v.funded === false &&
    v.liveSettle === false
  );
}

/** Type guard: only authorizations minted by authorizeBilling (X-1). */
export function isBillingAuthorization(
  value: unknown,
): value is BillingAuthorization {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!AUTH_REGISTRY.has(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.kind === "skillos.billing.authorization" &&
    v.authorized === true &&
    v.funded === false &&
    v.liveSettle === false
  );
}

/** Type guard: only receipts minted by settleBilling. */
export function isBillingReceipt(value: unknown): value is BillingReceipt {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!RECEIPT_REGISTRY.has(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.kind === "skillos.billing.receipt" &&
    v.funded === false &&
    v.liveSettle === false &&
    v.promoteAuthorized === false &&
    v.executeEnabled === false
  );
}

/**
 * End-to-end dry-run helper: quote → authorize → settle.
 * Still never funds a rail.
 */
export function dryRunBilling(
  request: BillingRequest,
  config: BillingConfig | BillingConfigInput | null | undefined,
  opts?: { decidedAt?: string },
): BillingResult<BillingReceipt> {
  const q = quoteBilling(request, config);
  if (!q.ok) return q;
  const a = authorizeBilling(q.value, config);
  if (!a.ok) return a;
  return settleBilling(a.value, config, opts);
}
