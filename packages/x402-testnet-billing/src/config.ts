/**
 * Billing config — fail closed on missing/invalid/production/mainnet/funded.
 * ADR 0009 D3.
 */

import {
  isBillingMode,
  type BillingConfig,
  type BillingConfigInput,
  type BillingResult,
} from "./types.js";

/**
 * Parse untrusted input into a sealed BillingConfig.
 * Rejects production / mainnet / funded / liveSettle truthy flags by construction.
 */
export function parseBillingConfig(
  input: BillingConfigInput | null | undefined,
): BillingResult<BillingConfig> {
  if (input == null) {
    return {
      ok: false,
      denyCode: "CONFIG_MISSING",
      reason: "billing config is required",
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      denyCode: "CONFIG_INVALID",
      reason: "billing config must be an object",
    };
  }

  // Forbidden flags — hard deny (not "unset env defaults to allow")
  if (input.production === true) {
    return {
      ok: false,
      denyCode: "PRODUCTION_FORBIDDEN",
      reason: "production billing mode is unreachable in this package",
    };
  }
  if (input.mainnet === true) {
    return {
      ok: false,
      denyCode: "MAINNET_FORBIDDEN",
      reason: "mainnet billing mode is unreachable in this package",
    };
  }
  if (input.funded === true) {
    return {
      ok: false,
      denyCode: "FUNDED_PATH_UNREACHABLE",
      reason: "funded billing is unreachable by construction",
    };
  }
  if (input.liveSettle === true) {
    return {
      ok: false,
      denyCode: "FUNDED_PATH_UNREACHABLE",
      reason: "live settle is unreachable by construction",
    };
  }

  // Secrets must not appear in adapter config (fail closed)
  if (input.privateKey != null && input.privateKey !== "") {
    return {
      ok: false,
      denyCode: "CONFIG_INVALID",
      reason: "private keys are not accepted in billing config",
    };
  }
  if (
    typeof input.facilitatorUrl === "string" &&
    input.facilitatorUrl.trim().length > 0
  ) {
    return {
      ok: false,
      denyCode: "CONFIG_INVALID",
      reason:
        "facilitator URLs are not accepted in this dry-run adapter (rail-neutral)",
    };
  }

  if (!isBillingMode(input.mode)) {
    if (
      input.mode === "mainnet" ||
      input.mode === "funded" ||
      input.mode === "live" ||
      input.mode === "production" ||
      input.mode === "live_settle"
    ) {
      return {
        ok: false,
        denyCode: "MODE_FORBIDDEN",
        reason: `mode ${String(input.mode)} is not representable as a success mode`,
      };
    }
    return {
      ok: false,
      denyCode: "CONFIG_INVALID",
      reason: "mode must be dry_run or fixture",
    };
  }

  const config: BillingConfig = Object.freeze({
    kind: "skillos.billing.config",
    mode: input.mode,
    production: false,
    mainnet: false,
    funded: false,
    liveSettle: false,
  });
  return { ok: true, value: config };
}

/** Create a sealed dry_run|fixture config. */
export function createBillingConfig(input: {
  mode: "dry_run" | "fixture";
}): BillingConfig {
  const r = parseBillingConfig(input);
  if (!r.ok) {
    throw new Error(r.reason);
  }
  return r.value;
}
