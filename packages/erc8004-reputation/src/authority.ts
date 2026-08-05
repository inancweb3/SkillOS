/**
 * One-way non-grants — reputation never becomes promote / EXECUTE / spend.
 * ADR 0010 D3.
 */

import type { ReputationAuthorityFlags, ReputationResult } from "./types.js";

const HARD_FALSE: ReputationAuthorityFlags = Object.freeze({
  promoteAuthorized: false,
  executeEnabled: false,
  x402FundedSpend: false,
  walletSpend: false,
  cdpSpend: false,
  controlPlaneUnpause: false,
  policyBypass: false,
  reputationInboundAuthority: false,
});

export function reputationAuthorityFlags(): ReputationAuthorityFlags {
  return HARD_FALSE;
}

export function authorizePromotionFromReputation(
  _projection: unknown,
): ReputationResult<never> {
  void _projection;
  return {
    ok: false,
    denyCode: "ONE_WAY_VIOLATION",
    reason: "reputation projection never authorizes promotion (ADR 0010)",
  };
}

export function authorizeExecuteFromReputation(
  _projection: unknown,
): ReputationResult<never> {
  void _projection;
  return {
    ok: false,
    denyCode: "ONE_WAY_VIOLATION",
    reason: "reputation projection never enables EXECUTE (ADR 0010)",
  };
}

export function authorizePolicyFromReputation(
  _projection: unknown,
): ReputationResult<never> {
  void _projection;
  return {
    ok: false,
    denyCode: "AUTHORITY_NON_GRANT",
    reason: "reputation projection never bypasses Policy Engine",
  };
}

export function authorizeWalletSpendFromReputation(
  _projection: unknown,
): ReputationResult<never> {
  void _projection;
  return {
    ok: false,
    denyCode: "FUNDED_PATH_UNREACHABLE",
    reason: "reputation never grants wallet/CDP/x402 spend",
  };
}
