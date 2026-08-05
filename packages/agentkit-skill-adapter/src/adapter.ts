/**
 * Dry-run invoke surface — live AgentKit actions unreachable by construction.
 */

import { getSkill, type SkillRegistry } from "./registry.js";
import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterResult,
  type SkillInvokeReceipt,
  type SkillInvokeRequest,
} from "./types.js";

/** Module-private mint registry for invoke receipts. */
const RECEIPT_REGISTRY = new WeakSet<object>();

function deny<T>(
  denyCode: import("./types.js").AdapterDenyCode,
  reason: string,
): AdapterResult<T> {
  return { ok: false, denyCode, reason };
}

/**
 * Invoke a registered tool in dry_run|fixture mode only.
 * Produces a simulated receipt — never calls wallet/CDP/x402/network.
 */
export function invokeSkillTool(
  registry: SkillRegistry,
  request: SkillInvokeRequest,
  opts?: { invokedAt?: string },
): AdapterResult<SkillInvokeReceipt> {
  if (
    registry == null ||
    typeof registry !== "object" ||
    registry.kind !== "skillos.agentkit.skill.registry"
  ) {
    return deny("REGISTRY_UNAVAILABLE", "skill registry is required");
  }
  if (request == null || typeof request !== "object") {
    return deny("TOOL_INVALID", "invoke request is required");
  }
  if (typeof request.skillId !== "string" || request.skillId.trim().length === 0) {
    return deny("SKILL_INVALID", "skillId must be non-empty");
  }
  if (typeof request.toolId !== "string" || request.toolId.trim().length === 0) {
    return deny("TOOL_INVALID", "toolId must be non-empty");
  }

  const mode = registry.config.mode;
  if (mode !== "dry_run" && mode !== "fixture") {
    return deny("MODE_FORBIDDEN", "mode not allowed for invoke");
  }
  if (
    (registry.config as { live?: unknown }).live === true ||
    (registry.config as { funded?: unknown }).funded === true
  ) {
    return deny("LIVE_PATH_UNREACHABLE", "live/funded registry cannot invoke");
  }

  const skill = getSkill(registry, request.skillId);
  if (!skill.ok) return skill;

  const toolId = request.toolId.trim();
  const tool = skill.value.tools.find((t) => t.toolId === toolId);
  if (!tool) {
    return deny(
      "TOOL_MISSING",
      `tool ${toolId} not on skill ${skill.value.skillId}`,
    );
  }

  // Reject secret-shaped input keys (fail closed)
  const input =
    request.input && typeof request.input === "object" && !Array.isArray(request.input)
      ? request.input
      : {};
  for (const key of Object.keys(input)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("privatekey") ||
      lower.includes("private_key") ||
      lower.includes("apikey") ||
      lower.includes("api_key") ||
      lower.includes("secret") ||
      lower.includes("mnemonic") ||
      lower.includes("seed")
    ) {
      return deny("SECRETS_FORBIDDEN", `input key forbidden: ${key}`);
    }
  }

  const invokedAt =
    typeof opts?.invokedAt === "string" && opts.invokedAt.length >= 10
      ? opts.invokedAt
      : new Date(0).toISOString();

  const simulatedOutput = Object.freeze({
    dryRun: true,
    skillId: skill.value.skillId,
    skillVersion: skill.value.version,
    toolId,
    mode,
    echo: Object.freeze({ ...input }),
    note: "simulated invoke — no network, wallet, CDP, or x402",
  });

  const receipt: SkillInvokeReceipt = Object.freeze({
    kind: "skillos.agentkit.skill.invoke.receipt",
    contractVersion: ADAPTER_CONTRACT_VERSION,
    skillId: skill.value.skillId,
    skillVersion: skill.value.version,
    toolId,
    mode,
    simulatedOutput,
    invokedAt,
    live: false,
    funded: false,
    promoteAuthorized: false,
    executeEnabled: false,
  });
  RECEIPT_REGISTRY.add(receipt);
  return { ok: true, value: receipt };
}

/**
 * Live AgentKit invoke entry — always denied.
 */
export function invokeSkillToolLive(
  _registry: SkillRegistry | null | undefined,
  _request: SkillInvokeRequest | null | undefined,
): AdapterResult<never> {
  void _registry;
  void _request;
  return deny(
    "LIVE_PATH_UNREACHABLE",
    "live AgentKit invoke is unreachable by construction",
  );
}

export function isSkillInvokeReceipt(
  value: unknown,
): value is SkillInvokeReceipt {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!RECEIPT_REGISTRY.has(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.kind === "skillos.agentkit.skill.invoke.receipt" &&
    v.live === false &&
    v.funded === false &&
    v.promoteAuthorized === false &&
    v.executeEnabled === false
  );
}
