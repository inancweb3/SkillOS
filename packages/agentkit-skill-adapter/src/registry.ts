/**
 * In-process skill registry — versioned registration, no live handlers.
 * A-1: skill storage is module-private (WeakMap), not a mutable map on the registry.
 */

import { createAdapterConfig, parseAdapterConfig } from "./config.js";
import {
  isSkillVersion,
  type AdapterConfig,
  type AdapterConfigInput,
  type AdapterResult,
  type SkillRecord,
  type SkillRegistrationInput,
  type SkillToolDescriptor,
} from "./types.js";

/**
 * Public registry handle. Skill inventory is **not** a property of this object —
 * storage lives in a module-private WeakMap (A-1). Holders cannot inject via
 * `_skills.set(...)` or assign a substitute Map.
 */
export type SkillRegistry = {
  readonly kind: "skillos.agentkit.skill.registry";
  readonly config: AdapterConfig;
};

/**
 * Module-private skill storage keyed by registry object identity.
 * Unreachable from outside this module — makes external map mutation unrepresentable.
 */
const SKILL_STORE = new WeakMap<object, Map<string, SkillRecord>>();

function deny<T>(
  denyCode: import("./types.js").AdapterDenyCode,
  reason: string,
): AdapterResult<T> {
  return { ok: false, denyCode, reason };
}

function skillsOf(registry: SkillRegistry): Map<string, SkillRecord> | null {
  if (
    registry == null ||
    typeof registry !== "object" ||
    registry.kind !== "skillos.agentkit.skill.registry"
  ) {
    return null;
  }
  return SKILL_STORE.get(registry) ?? null;
}

function normalizeTool(
  t: SkillToolDescriptor,
): AdapterResult<SkillToolDescriptor> {
  if (
    typeof t.toolId !== "string" ||
    t.toolId.trim().length === 0 ||
    typeof t.description !== "string" ||
    t.description.trim().length === 0
  ) {
    return deny("TOOL_INVALID", "toolId and description must be non-empty");
  }
  return {
    ok: true,
    value: Object.freeze({
      toolId: t.toolId.trim(),
      description: t.description.trim(),
    }),
  };
}

/**
 * Create an empty skill registry bound to dry_run|fixture config.
 */
export function createSkillRegistry(
  config: AdapterConfig | AdapterConfigInput | { mode: "dry_run" | "fixture" },
): AdapterResult<SkillRegistry> {
  let cfg: AdapterConfig;
  if (
    config != null &&
    typeof config === "object" &&
    (config as AdapterConfig).kind === "skillos.agentkit.adapter.config"
  ) {
    const parsed = parseAdapterConfig(config as AdapterConfigInput);
    // Re-seal via parse to reject forged flags
    if (!parsed.ok) return parsed;
    cfg = parsed.value;
  } else {
    const parsed = parseAdapterConfig(config as AdapterConfigInput);
    if (!parsed.ok) return parsed;
    cfg = parsed.value;
  }

  const reg: SkillRegistry = Object.freeze({
    kind: "skillos.agentkit.skill.registry" as const,
    config: cfg,
  });
  SKILL_STORE.set(reg, new Map());
  return { ok: true, value: reg };
}

/** Convenience that throws only on programmer error for typed dry_run|fixture. */
export function createSkillRegistryOrThrow(mode: "dry_run" | "fixture"): SkillRegistry {
  const r = createSkillRegistry(createAdapterConfig({ mode }));
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

/**
 * Register a versioned skill. Overwrites same skillId (last write wins) with
 * frozen snapshot — no live tool handlers attached.
 */
export function registerSkill(
  registry: SkillRegistry,
  input: SkillRegistrationInput,
  opts?: { registeredAt?: string },
): AdapterResult<SkillRecord> {
  const store = skillsOf(registry);
  if (!store) {
    return deny("REGISTRY_UNAVAILABLE", "skill registry is required");
  }
  if (input == null || typeof input !== "object") {
    return deny("SKILL_INVALID", "skill registration input is required");
  }
  if (typeof input.skillId !== "string" || input.skillId.trim().length === 0) {
    return deny("SKILL_INVALID", "skillId must be non-empty");
  }
  if (!isSkillVersion(input.version)) {
    return deny(
      "VERSION_INVALID",
      "version must be major.minor.patch (e.g. 0.1.0)",
    );
  }
  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    return deny("TOOL_INVALID", "at least one tool is required");
  }

  const tools: SkillToolDescriptor[] = [];
  const seen = new Set<string>();
  for (const t of input.tools) {
    const nt = normalizeTool(t);
    if (!nt.ok) return nt;
    if (seen.has(nt.value.toolId)) {
      return deny("TOOL_INVALID", `duplicate toolId ${nt.value.toolId}`);
    }
    seen.add(nt.value.toolId);
    tools.push(nt.value);
  }

  const registeredAt =
    typeof opts?.registeredAt === "string" && opts.registeredAt.length >= 10
      ? opts.registeredAt
      : new Date(0).toISOString();

  const record: SkillRecord = Object.freeze({
    skillId: input.skillId.trim(),
    version: input.version,
    tools: Object.freeze([...tools]),
    description:
      typeof input.description === "string" && input.description.trim()
        ? input.description.trim()
        : null,
    registeredAt,
  });
  store.set(record.skillId, record);
  return { ok: true, value: record };
}

export function getSkill(
  registry: SkillRegistry,
  skillId: string,
): AdapterResult<SkillRecord> {
  const store = skillsOf(registry);
  if (!store) {
    return deny("REGISTRY_UNAVAILABLE", "skill registry is required");
  }
  if (typeof skillId !== "string" || skillId.trim().length === 0) {
    return deny("SKILL_INVALID", "skillId must be non-empty");
  }
  const rec = store.get(skillId.trim());
  if (!rec) {
    return deny("SKILL_MISSING", `skill not registered: ${skillId.trim()}`);
  }
  return { ok: true, value: rec };
}

export function listSkills(registry: SkillRegistry): readonly SkillRecord[] {
  const store = skillsOf(registry);
  if (!store) {
    return Object.freeze([]);
  }
  return Object.freeze([...store.values()]);
}
