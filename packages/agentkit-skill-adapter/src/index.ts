/**
 * @skillos/agentkit-skill-adapter — versioned AgentKit / Agent Skill adapter.
 *
 * Faz 3 plan #9:
 * - Rail-neutral skill/tool registration (no live @coinbase/agentkit dependency)
 * - dry_run | fixture only for successful invoke
 * - Hard non-grants: EXECUTE, promote, wallet/CDP/x402 funded spend
 * - SkillOS remains evidence/digests only — no Simpl3 execution authority
 */

export {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_MODES,
  isAdapterMode,
  isSkillVersion,
  type AdapterMode,
  type AdapterDenyCode,
  type AdapterOk,
  type AdapterErr,
  type AdapterResult,
  type SkillToolDescriptor,
  type SkillRegistrationInput,
  type SkillRecord,
  type SkillInvokeRequest,
  type SkillInvokeReceipt,
  type AdapterAuthorityFlags,
  type AdapterConfigInput,
  type AdapterConfig,
} from "./types.js";

export { parseAdapterConfig, createAdapterConfig } from "./config.js";

export {
  adapterAuthorityFlags,
  authorizePromotionFromAdapter,
  authorizeExecuteFromAdapter,
  authorizeWalletSpendFromAdapter,
} from "./authority.js";

export {
  createSkillRegistry,
  createSkillRegistryOrThrow,
  registerSkill,
  getSkill,
  listSkills,
  type SkillRegistry,
} from "./registry.js";

export {
  invokeSkillTool,
  invokeSkillToolLive,
  isSkillInvokeReceipt,
} from "./adapter.js";
