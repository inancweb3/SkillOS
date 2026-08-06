/**
 * AgentKit skill adapter — dry-run + fail-closed tests.
 * Run: npx tsx --test packages/agentkit-skill-adapter/test/adapter.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_MODES,
  adapterAuthorityFlags,
  authorizeExecuteFromAdapter,
  authorizePromotionFromAdapter,
  authorizeWalletSpendFromAdapter,
  createSkillRegistryOrThrow,
  getSkill,
  invokeSkillTool,
  invokeSkillToolLive,
  isSkillInvokeReceipt,
  listSkills,
  parseAdapterConfig,
  registerSkill,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const NOW = "2026-08-05T20:00:00.000Z";

function regWithEcho() {
  const reg = createSkillRegistryOrThrow("dry_run");
  const r = registerSkill(
    reg,
    {
      skillId: "skillos.demo.echo",
      version: "0.1.0",
      tools: [{ toolId: "echo", description: "echo input" }],
      description: "demo",
    },
    { registeredAt: NOW },
  );
  assert.equal(r.ok, true);
  return reg;
}

describe("contract pins", () => {
  it("exports version and dry_run|fixture only", () => {
    assert.equal(ADAPTER_CONTRACT_VERSION, "0.1.0");
    assert.deepEqual([...ADAPTER_MODES], ["dry_run", "fixture"]);
  });

  it("authority flags always hard-false", () => {
    const f = adapterAuthorityFlags();
    assert.equal(f.promoteAuthorized, false);
    assert.equal(f.executeEnabled, false);
    assert.equal(f.x402FundedSpend, false);
    assert.equal(f.walletSpend, false);
    assert.equal(f.cdpSpend, false);
    assert.equal(f.controlPlaneUnpause, false);
    assert.equal(f.policyBypass, false);
  });
});

describe("config fail-closed", () => {
  it("missing config denied", () => {
    const r = parseAdapterConfig(null);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "CONFIG_MISSING");
  });

  it("live true denied", () => {
    const r = parseAdapterConfig({ mode: "dry_run", live: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "LIVE_PATH_UNREACHABLE");
  });

  it("funded true denied", () => {
    const r = parseAdapterConfig({ mode: "dry_run", funded: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "FUNDED_PATH_UNREACHABLE");
  });

  it("privateKey / apiKey denied", () => {
    const r = parseAdapterConfig({ mode: "dry_run", privateKey: "0xabc" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "SECRETS_FORBIDDEN");
  });

  it("agentKitSdk instance denied", () => {
    const r = parseAdapterConfig({ mode: "dry_run", agentKitSdk: {} });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "CONFIG_INVALID");
  });

  it("mode live string denied", () => {
    const r = parseAdapterConfig({ mode: "live" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "MODE_FORBIDDEN");
  });
});

describe("skill registry", () => {
  it("registers and lists skills", () => {
    const reg = regWithEcho();
    const list = listSkills(reg);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.skillId, "skillos.demo.echo");
    assert.equal(list[0]?.version, "0.1.0");
    const g = getSkill(reg, "skillos.demo.echo");
    assert.equal(g.ok, true);
  });

  it("rejects invalid version", () => {
    const reg = createSkillRegistryOrThrow("fixture");
    const r = registerSkill(reg, {
      skillId: "x",
      version: "v1",
      tools: [{ toolId: "t", description: "d" }],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "VERSION_INVALID");
  });

  it("rejects empty tools", () => {
    const reg = createSkillRegistryOrThrow("dry_run");
    const r = registerSkill(reg, {
      skillId: "x",
      version: "1.0.0",
      tools: [],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "TOOL_INVALID");
  });

  it("missing skill fails closed", () => {
    const reg = createSkillRegistryOrThrow("dry_run");
    const g = getSkill(reg, "nope");
    assert.equal(g.ok, false);
    if (!g.ok) assert.equal(g.denyCode, "SKILL_MISSING");
  });
});

/**
 * A-1 — registry skill storage encapsulation (architect residual).
 * External `_skills` mutation must be unrepresentable / ignored.
 */
describe("A-1 registry encapsulation (WeakMap store)", () => {
  it("registry has no reachable _skills map property", () => {
    const reg = createSkillRegistryOrThrow("dry_run");
    const bag = reg as unknown as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(bag, "_skills"), false);
    assert.equal(bag._skills, undefined);
    assert.equal(Object.isFrozen(reg), true);
  });

  it("legacy inject path reg._skills.set cannot list or get injected skill", () => {
    const reg = createSkillRegistryOrThrow("dry_run");
    const bag = reg as unknown as {
      _skills?: Map<string, { skillId: string; version: string; tools: readonly unknown[]; description: null; registeredAt: string }>;
    };
    // Pre-A-1 attack: mutate public Map. After A-1, property is absent.
    const inject = Object.freeze({
      skillId: "injected.evil",
      version: "9.9.9",
      tools: Object.freeze([{ toolId: "pwn", description: "inject" }]),
      description: null,
      registeredAt: "2026-08-06T00:00:00.000Z",
    });
    if (bag._skills && typeof bag._skills.set === "function") {
      bag._skills.set("injected.evil", inject);
    } else {
      // Attempt assign + set (frozen registry should block assign).
      try {
        bag._skills = new Map([["injected.evil", inject]]);
      } catch {
        // freeze expected
      }
    }
    const list = listSkills(reg);
    assert.equal(
      list.some((s) => s.skillId === "injected.evil"),
      false,
      "injected skill must not appear in listSkills",
    );
    const g = getSkill(reg, "injected.evil");
    assert.equal(g.ok, false);
    if (!g.ok) assert.equal(g.denyCode, "SKILL_MISSING");
  });

  it("hand-built registry object has empty inventory (no store entry)", () => {
    const forged = Object.freeze({
      kind: "skillos.agentkit.skill.registry" as const,
      config: createSkillRegistryOrThrow("dry_run").config,
      _skills: new Map([
        [
          "forged.skill",
          Object.freeze({
            skillId: "forged.skill",
            version: "1.0.0",
            tools: Object.freeze([{ toolId: "t", description: "d" }]),
            description: null,
            registeredAt: "2026-08-06T00:00:00.000Z",
          }),
        ],
      ]),
    });
    assert.deepEqual(listSkills(forged as never), []);
    const g = getSkill(forged as never, "forged.skill");
    assert.equal(g.ok, false);
    if (!g.ok) assert.equal(g.denyCode, "REGISTRY_UNAVAILABLE");
    const r = registerSkill(forged as never, {
      skillId: "x",
      version: "1.0.0",
      tools: [{ toolId: "t", description: "d" }],
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "REGISTRY_UNAVAILABLE");
  });

  it("legitimate registerSkill still works after encapsulation", () => {
    const reg = createSkillRegistryOrThrow("dry_run");
    const r = registerSkill(reg, {
      skillId: "skillos.legit",
      version: "0.2.0",
      tools: [{ toolId: "ok", description: "ok tool" }],
    });
    assert.equal(r.ok, true);
    assert.equal(listSkills(reg).length, 1);
    assert.equal(listSkills(reg)[0]?.skillId, "skillos.legit");
  });
});

describe("dry-run invoke", () => {
  it("invokes registered tool with simulated receipt", () => {
    const reg = regWithEcho();
    const r = invokeSkillTool(
      reg,
      { skillId: "skillos.demo.echo", toolId: "echo", input: { message: "hi" } },
      { invokedAt: NOW },
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.live, false);
    assert.equal(r.value.funded, false);
    assert.equal(r.value.promoteAuthorized, false);
    assert.equal(r.value.executeEnabled, false);
    assert.equal(r.value.mode, "dry_run");
    assert.equal(isSkillInvokeReceipt(r.value), true);
    assert.equal(
      (r.value.simulatedOutput as { echo?: { message?: string } }).echo
        ?.message,
      "hi",
    );
  });

  it("unknown tool denied", () => {
    const reg = regWithEcho();
    const r = invokeSkillTool(reg, {
      skillId: "skillos.demo.echo",
      toolId: "nope",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "TOOL_MISSING");
  });

  it("secret-shaped input keys denied", () => {
    const reg = regWithEcho();
    const r = invokeSkillTool(reg, {
      skillId: "skillos.demo.echo",
      toolId: "echo",
      input: { privateKey: "0xdead" },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "SECRETS_FORBIDDEN");
  });

  it("forged receipt shape rejected", () => {
    const forged = {
      kind: "skillos.agentkit.skill.invoke.receipt" as const,
      contractVersion: ADAPTER_CONTRACT_VERSION,
      skillId: "x",
      skillVersion: "0.1.0",
      toolId: "t",
      mode: "dry_run" as const,
      simulatedOutput: {},
      invokedAt: NOW,
      live: false as const,
      funded: false as const,
      promoteAuthorized: false as const,
      executeEnabled: false as const,
    };
    assert.equal(isSkillInvokeReceipt(forged), false);
  });

  it("spread clone not registered", () => {
    const reg = regWithEcho();
    const r = invokeSkillTool(
      reg,
      { skillId: "skillos.demo.echo", toolId: "echo" },
      { invokedAt: NOW },
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(isSkillInvokeReceipt({ ...r.value }), false);
  });
});

describe("live path unreachable", () => {
  it("invokeSkillToolLive always denies", () => {
    const reg = regWithEcho();
    const r = invokeSkillToolLive(reg, {
      skillId: "skillos.demo.echo",
      toolId: "echo",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "LIVE_PATH_UNREACHABLE");
  });
});

describe("authority non-grants", () => {
  it("promotion from adapter denied", () => {
    const p = authorizePromotionFromAdapter({ ok: true });
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.denyCode, "AUTHORITY_NON_GRANT");
  });

  it("EXECUTE from adapter denied", () => {
    const e = authorizeExecuteFromAdapter({ ok: true });
    assert.equal(e.ok, false);
    if (!e.ok) assert.equal(e.denyCode, "AUTHORITY_NON_GRANT");
  });

  it("wallet spend from adapter denied", () => {
    const w = authorizeWalletSpendFromAdapter({ ok: true });
    assert.equal(w.ok, false);
    if (!w.ok) assert.equal(w.denyCode, "FUNDED_PATH_UNREACHABLE");
  });
});

describe("docs present", () => {
  it("adapter note documents rail-neutral dry-run", () => {
    const doc = readFileSync(
      join(repoRoot, "docs/adapter-agentkit-skill.md"),
      "utf8",
    );
    assert.match(doc, /agentkit-skill-adapter/);
    assert.match(doc, /dry_run/);
    assert.match(doc, /rail-neutral/i);
  });
});
