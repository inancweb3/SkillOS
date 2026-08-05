/**
 * Hard non-grants — billing never becomes promotion / EXECUTE / funded spend.
 * ADR 0009 D4.
 */

import type { BillingAuthorityFlags, BillingResult } from "./types.js";

const HARD_FALSE_FLAGS: BillingAuthorityFlags = Object.freeze({
  promoteAuthorized: false,
  executeEnabled: false,
  x402FundedSpend: false,
  walletSpend: false,
  controlPlaneUnpause: false,
  policyBypass: false,
});

/** Always hard-false authority flags (immutable). */
export function billingAuthorityFlags(): BillingAuthorityFlags {
  return HARD_FALSE_FLAGS;
}

/**
 * Any attempt to treat billing success as promotion authorization fails closed.
 */
export function authorizePromotionFromBilling(
  _billingSuccess: unknown,
): BillingResult<never> {
  void _billingSuccess;
  return {
    ok: false,
    denyCode: "AUTHORITY_NON_GRANT",
    reason: "billing success never authorizes promotion (ADR 0009 / ADR 0008)",
  };
}

/**
 * Any attempt to arm EXECUTE from billing fails closed.
 */
export function authorizeExecuteFromBilling(
  _billingSuccess: unknown,
): BillingResult<never> {
  void _billingSuccess;
  return {
    ok: false,
    denyCode: "AUTHORITY_NON_GRANT",
    reason: "billing success never enables EXECUTE (ADR 0009)",
  };
}

/**
 * Structural non-grant for funded x402 spend labels.
 */
export function authorizeX402FundedSpend(
  _billingSuccess: unknown,
): BillingResult<never> {
  void _billingSuccess;
  return {
    ok: false,
    denyCode: "FUNDED_PATH_UNREACHABLE",
    reason: "x402_funded_spend is non-grantable from this adapter",
  };
}
