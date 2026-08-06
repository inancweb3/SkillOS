# @skillos/agentkit-skill-adapter

Versioned **AgentKit / Agent Skill** adapter for SkillOS (Faz 3 · plan #9).

## What it is

- Stable skill + tool registration shapes SkillOS can version
- **Rail-neutral:** no Coinbase AgentKit, CDP, wallet, or x402 client as a runtime dependency
- **Dry-run / fixture** modes only for successful offline invoke
- Hard non-grants: EXECUTE, promote, wallet spend, `x402_funded_spend`, pause override
- **Registry encapsulation (A-1):** skill inventory is module-private (`WeakMap`);
  holders of `SkillRegistry` cannot inject via a public `_skills` Map

## What it is not

- Not a live `@coinbase/agentkit` integration
- Not a promotion or execution authority
- Not a funded rail adapter (see `@skillos/x402-testnet-billing` for dry-run billing)

## Usage

```ts
import {
  createSkillRegistry,
  registerSkill,
  invokeSkillTool,
  adapterAuthorityFlags,
} from "@skillos/agentkit-skill-adapter";

const reg = createSkillRegistry({ mode: "dry_run" });
registerSkill(reg, {
  skillId: "skillos.demo.echo",
  version: "0.1.0",
  tools: [{ toolId: "echo", description: "echo input" }],
});

const result = invokeSkillTool(reg, {
  skillId: "skillos.demo.echo",
  toolId: "echo",
  input: { message: "hi" },
});
// result.ok → dry-run receipt only; never funds a rail

adapterAuthorityFlags(); // all hard-false
```

## Tests

```bash
npm test --workspace=@skillos/agentkit-skill-adapter
npm run typecheck --workspace=@skillos/agentkit-skill-adapter
```
