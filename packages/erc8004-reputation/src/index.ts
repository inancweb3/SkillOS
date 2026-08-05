/**
 * @skillos/erc8004-reputation — one-way digest/summary reputation projection.
 *
 * ADR 0010:
 * - Outbound: digests + allowlisted summary only
 * - Never raw evidence, secrets, portfolio
 * - Reputation never promotes/EXECUTE/spend
 * - Dry-run/fixture only; live broadcast unreachable
 */

export {
  REPUTATION_CONTRACT_VERSION,
  REPUTATION_MODES,
  SUMMARY_CODES,
  isReputationMode,
  isSummaryCode,
  isDigestHex,
  type ReputationMode,
  type SummaryCode,
  type ReputationDenyCode,
  type ReputationOk,
  type ReputationErr,
  type ReputationResult,
  type ReputationProjectionInput,
  type ReputationProjection,
  type ReputationAuthorityFlags,
  type ReputationConfigInput,
  type ReputationConfig,
} from "./types.js";

export { parseReputationConfig, createReputationConfig } from "./config.js";

export {
  reputationAuthorityFlags,
  authorizePromotionFromReputation,
  authorizeExecuteFromReputation,
  authorizePolicyFromReputation,
  authorizeWalletSpendFromReputation,
} from "./authority.js";

export {
  projectReputation,
  broadcastReputationLive,
  isReputationProjection,
} from "./project.js";
