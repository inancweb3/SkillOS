// Lazy OpenRouter (Hermes 3) client singleton, scoped to apps/api.
//
// Mirrors ./anthropic-client.ts intentionally — apps/api stays a standalone
// deploy unit (zero @skillos/* workspace deps), so the OpenRouter client lives
// here rather than pulling in @skillos/hermes-mcp-wrapper. The wrapper's
// run()/MCP surface is the wrong shape for the per-move runner loop (it owns
// game state in an MCP session_store and loops multiple turns internally —
// see the Hermes brain feasibility report). B-direct: the `openai` SDK pointed
// at OpenRouter's base URL gives us one chat.completions.create per move,
// matching getNextMove's one-call-one-move contract.

import OpenAI from 'openai';

let cached: OpenAI | null = null;

/** OpenRouter is OpenAI-wire-compatible; the SDK just needs the base URL. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function getOpenRouterClient(): OpenAI {
  if (cached) return cached;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Required when AGENT_BRAIN=hermes for /v1/agents/matches/start-solo.',
    );
  }
  cached = new OpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL });
  return cached;
}

// Hermes 3 405B (Nous Research) via OpenRouter — the strongest variant we've
// validated (docs/hermes-mcp-validation.md). Swap path mirrors the Claude
// constant in anthropic-client.ts: edit this one line.
export const AGENT_MATCH_MODEL = 'nousresearch/hermes-3-llama-3.1-405b';

// Gate-driven fallback (B4): the 70B variant is ~3x cheaper and faster. If the
// 405B per-move latency blows the wall-clock move budget, flip AGENT_MATCH_MODEL
// to this. Left commented so the choice is explicit and reviewed, not silent.
// export const FALLBACK_MODEL = 'nousresearch/hermes-3-llama-3.1-70b';

export const AGENT_MATCH_MODEL_DISPLAY = 'Hermes 3 405B (Nous)';
