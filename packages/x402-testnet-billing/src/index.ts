/**
 * @skillos/x402-testnet-billing — rail-neutral testnet billing adapter.
 *
 * ADR 0009:
 * - SkillOS owns the adapter surface (quote / authorize / settle dry-run).
 * - Funded / mainnet / live settle are unreachable by construction.
 * - Billing never grants promote, EXECUTE, wallet, or x402_funded_spend.
 * - No network, facilitator, secrets, or apps/api paymentMiddleware expansion.
 */

export {
  BILLING_CONTRACT_VERSION,
  BILLING_MODES,
  BILLING_ASSETS,
  isBillingMode,
  isBillingAsset,
  type BillingMode,
  type BillingAsset,
  type BillingDenyCode,
  type BillingRequest,
  type BillingQuote,
  type BillingAuthorization,
  type BillingReceipt,
  type BillingOk,
  type BillingErr,
  type BillingResult,
  type BillingAuthorityFlags,
  type BillingConfigInput,
  type BillingConfig,
} from "./types.js";

export { parseBillingConfig, createBillingConfig } from "./config.js";

export {
  billingAuthorityFlags,
  authorizePromotionFromBilling,
  authorizeExecuteFromBilling,
  authorizeX402FundedSpend,
} from "./authority.js";

export {
  quoteBilling,
  authorizeBilling,
  settleBilling,
  settleLiveFundedBilling,
  isBillingQuote,
  isBillingAuthorization,
  isBillingReceipt,
  dryRunBilling,
} from "./adapter.js";
