/**
 * Adapter config — fail closed on live/funded/production/secrets.
 */

import {
  isAdapterMode,
  type AdapterConfig,
  type AdapterConfigInput,
  type AdapterResult,
} from "./types.js";

export function parseAdapterConfig(
  input: AdapterConfigInput | null | undefined,
): AdapterResult<AdapterConfig> {
  if (input == null) {
    return {
      ok: false,
      denyCode: "CONFIG_MISSING",
      reason: "adapter config is required",
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      denyCode: "CONFIG_INVALID",
      reason: "adapter config must be an object",
    };
  }

  if (input.live === true) {
    return {
      ok: false,
      denyCode: "LIVE_PATH_UNREACHABLE",
      reason: "live AgentKit mode is unreachable by construction",
    };
  }
  if (input.funded === true) {
    return {
      ok: false,
      denyCode: "FUNDED_PATH_UNREACHABLE",
      reason: "funded mode is unreachable by construction",
    };
  }
  if (input.production === true || input.mainnet === true) {
    return {
      ok: false,
      denyCode: "MODE_FORBIDDEN",
      reason: "production/mainnet adapter modes are not representable as success",
    };
  }
  if (
    (input.privateKey != null && input.privateKey !== "") ||
    (input.apiKey != null && input.apiKey !== "")
  ) {
    return {
      ok: false,
      denyCode: "SECRETS_FORBIDDEN",
      reason: "secrets are not accepted in adapter config",
    };
  }
  if (input.agentKitSdk != null) {
    return {
      ok: false,
      denyCode: "CONFIG_INVALID",
      reason:
        "third-party AgentKit SDK instances are not accepted (rail-neutral dry-run only)",
    };
  }

  if (!isAdapterMode(input.mode)) {
    if (
      input.mode === "live" ||
      input.mode === "funded" ||
      input.mode === "mainnet" ||
      input.mode === "production"
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

  const config: AdapterConfig = Object.freeze({
    kind: "skillos.agentkit.adapter.config",
    mode: input.mode,
    live: false,
    funded: false,
    production: false,
    mainnet: false,
  });
  return { ok: true, value: config };
}

export function createAdapterConfig(input: {
  mode: "dry_run" | "fixture";
}): AdapterConfig {
  const r = parseAdapterConfig(input);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}
