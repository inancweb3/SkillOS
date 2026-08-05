/**
 * Reputation adapter config — fail closed on live/broadcast/funded/secrets.
 */

import {
  isReputationMode,
  type ReputationConfig,
  type ReputationConfigInput,
  type ReputationResult,
} from "./types.js";

export function parseReputationConfig(
  input: ReputationConfigInput | null | undefined,
): ReputationResult<ReputationConfig> {
  if (input == null) {
    return {
      ok: false,
      denyCode: "CONFIG_MISSING",
      reason: "reputation config is required",
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      denyCode: "CONFIG_INVALID",
      reason: "reputation config must be an object",
    };
  }

  if (input.live === true || input.broadcast === true) {
    return {
      ok: false,
      denyCode: "LIVE_PATH_UNREACHABLE",
      reason: "live/broadcast reputation mode is unreachable by construction",
    };
  }
  if (input.funded === true) {
    return {
      ok: false,
      denyCode: "FUNDED_PATH_UNREACHABLE",
      reason: "funded reputation broadcast is unreachable by construction",
    };
  }
  if (input.production === true || input.mainnet === true) {
    return {
      ok: false,
      denyCode: "MODE_FORBIDDEN",
      reason: "production/mainnet modes are not success modes",
    };
  }
  if (input.privateKey != null && input.privateKey !== "") {
    return {
      ok: false,
      denyCode: "SECRETS_FORBIDDEN",
      reason: "private keys are not accepted in reputation config",
    };
  }
  if (typeof input.rpcUrl === "string" && input.rpcUrl.trim().length > 0) {
    return {
      ok: false,
      denyCode: "CONFIG_INVALID",
      reason: "rpcUrl is not accepted in dry-run reputation adapter",
    };
  }

  if (!isReputationMode(input.mode)) {
    if (
      input.mode === "live" ||
      input.mode === "broadcast" ||
      input.mode === "mainnet" ||
      input.mode === "production" ||
      input.mode === "funded"
    ) {
      return {
        ok: false,
        denyCode: "MODE_FORBIDDEN",
        reason: `mode ${String(input.mode)} is not a success mode`,
      };
    }
    return {
      ok: false,
      denyCode: "CONFIG_INVALID",
      reason: "mode must be dry_run or fixture",
    };
  }

  const config: ReputationConfig = Object.freeze({
    kind: "skillos.erc8004.reputation.config",
    mode: input.mode,
    live: false,
    funded: false,
    broadcast: false,
    production: false,
    mainnet: false,
  });
  return { ok: true, value: config };
}

export function createReputationConfig(input: {
  mode: "dry_run" | "fixture";
}): ReputationConfig {
  const r = parseReputationConfig(input);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
