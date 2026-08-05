/**
 * Hard non-grants — adapter never becomes EXECUTE / promote / funded spend.
 */

import type { AdapterAuthorityFlags, AdapterResult } from "./types.js";

const HARD_FALSE: AdapterAuthorityFlags = Object.freeze({
  promoteAuthorized: false,
  executeEnabled: false,
  x402FundedSpend: false,
  walletSpend: false,
  cdpSpend: false,
  controlPlaneUnpause: false,
  policyBypass: false,
});

export function adapterAuthorityFlags(): AdapterAuthorityFlags {
  return HARD_FALSE;
}

export function authorizePromotionFromAdapter(
  _success: unknown,
): AdapterResult<never> {
  void _success;
  return {
    ok: false,
    denyCode: "AUTHORITY_NON_GRANT",
    reason: "adapter success never authorizes promotion",
  };
}

export function authorizeExecuteFromAdapter(
  _success: unknown,
): AdapterResult<never> {
  void _success;
  return {
    ok: false,
    denyCode: "AUTHORITY_NON_GRANT",
    reason: "adapter success never enables EXECUTE",
  };
}

export function authorizeWalletSpendFromAdapter(
  _success: unknown,
): AdapterResult<never> {
  void _success;
  return {
    ok: false,
    denyCode: "FUNDED_PATH_UNREACHABLE",
    reason: "wallet/CDP/x402 spend is non-grantable from this adapter",
  };
}
