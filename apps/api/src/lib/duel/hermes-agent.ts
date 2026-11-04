// Agent move generator — Hermes 3 (Nous Research) brain via OpenRouter.
//
// B-direct sibling of ./anthropic-agent.ts: identical getNextMove(ctx) contract,
// identical prompt, identical forced-tool structured-output guarantee. Only the
// inference call differs — OpenRouter chat.completions in OpenAI function-tool
// shape, vs Anthropic Messages tool_use. Selected at runtime by the AGENT_BRAIN
// env in runner.ts. The persistence + on-chain path is brain-agnostic and stays
// untouched: this module returns the same { direction, reasoning, latencyMs }.
//
// The board rendering, system prompt, and user message are lifted verbatim from
// anthropic-agent.ts so the two brains see byte-identical context. The only
// post-response divergence (extracting the move from an OpenAI tool_call vs an
// Anthropic tool_use block) is isolated in the pure, exported `parseMoveResponse`
// so it can be exercised without a network round-trip.

import type {
  ChatCompletion,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import type { AgentMoveContext, AgentMoveResult } from './anthropic-agent.js';
import { AGENT_MATCH_MODEL, getOpenRouterClient } from './hermes-client.js';
import { type Board, type Direction, legalMoves } from './game-2048.js';

// Temperature 0.3: between Anthropic's 0.4 (anthropic-agent.ts) and the Hermes
// wrapper's deterministic 0. 2048 move selection is constraint-rich, so we bias
// toward determinism for steadier corner-pinning while keeping a little variety
// to avoid lock-stepping into the stuck-detector. Not 0 — the runner's
// STUCK_THRESHOLD forfeits 5 identical moves in a row.
const HERMES_TEMPERATURE = 0.3;
const HERMES_MAX_TOKENS = 400;

const SYSTEM_PROMPT = `You are an expert 2048 player competing in a verifiable on-chain tournament.

Your goal: maximize the final score (sum of all merge values) before the board fills with no legal moves.

Strategy guidance:
- Keep your largest tile pinned to a corner (canonical: bottom-right).
- Prefer moves that grow a chain along one row/column toward the corner.
- Avoid moves that split your largest tile away from the corner.
- Only break the corner-pinning when forced (no other legal move).

For each turn you will be shown the board, current score, and your recent moves. Call the make_move tool with:
- direction: one of "up", "down", "left", "right" — MUST be a legal move
- reasoning: 1-2 short sentences explaining your choice (will be shown to spectators)`;

const MAKE_MOVE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'make_move',
    description: 'Submit your next 2048 move with a short rationale.',
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'The cardinal direction to slide tiles. Must be a legal move on the current board.',
        },
        reasoning: {
          type: 'string',
          description: 'One or two sentences explaining the choice. Visible to spectators.',
        },
      },
      required: ['direction', 'reasoning'],
    },
  },
};

function renderBoardAscii(board: Board): string {
  const cellW = 5;
  const rule = `+${'-'.repeat(cellW).repeat(4).replace(/-/g, '-')}`.padEnd(
    1 + (cellW + 1) * 4,
    '-',
  ) + '+';
  const lines: string[] = [rule];
  for (const row of board) {
    const cells = row
      .map((v) => (v === 0 ? '.' : String(v)).padStart(cellW - 1).padStart(cellW))
      .join('|');
    lines.push(`|${cells}|`);
    lines.push(rule);
  }
  return lines.join('\n');
}

/**
 * Pure extractor for the move out of an OpenRouter chat completion. Separated
 * from the network call so it is unit-testable without an API key (see
 * scripts/hermes-dryrun.ts --mock). Mirrors the validation + illegal-move
 * fallback semantics of anthropic-agent.ts exactly.
 */
export function parseMoveResponse(
  response: ChatCompletion,
  legal: Direction[],
  latencyMs: number,
): AgentMoveResult {
  const message = response.choices[0]?.message;
  const toolCall = message?.tool_calls?.find((c) => c.type === 'function');
  if (!toolCall || toolCall.type !== 'function' || toolCall.function.name !== 'make_move') {
    throw new Error('OpenRouter response missing make_move tool_call — unexpected for forced tool_choice');
  }

  let input: { direction?: string; reasoning?: string };
  try {
    input = JSON.parse(toolCall.function.arguments || '{}') as { direction?: string; reasoning?: string };
  } catch (err) {
    throw new Error(
      `OpenRouter make_move arguments were not valid JSON: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }

  const direction = input.direction as Direction | undefined;
  const reasoning = (input.reasoning ?? '').slice(0, 4000);

  if (!direction || !['up', 'down', 'left', 'right'].includes(direction)) {
    throw new Error(`OpenRouter returned invalid direction: ${String(direction)}`);
  }
  if (!legal.includes(direction)) {
    // Model picked an illegal move — fall back to first legal direction with a
    // synthesized note. Better than aborting the match.
    return {
      direction: legal[0],
      reasoning: `(Fallback: model picked illegal ${direction}; chose ${legal[0]} instead.) ${reasoning}`,
      latencyMs,
    };
  }

  return { direction, reasoning, latencyMs };
}

export async function getNextMove(ctx: AgentMoveContext): Promise<AgentMoveResult> {
  const legal = legalMoves(ctx.board);
  if (legal.length === 0) {
    throw new Error('No legal moves — orchestrator should detect game-over before calling getNextMove');
  }

  const client = getOpenRouterClient();
  const ascii = renderBoardAscii(ctx.board);
  const matrix = JSON.stringify(ctx.board);
  const recent = ctx.recentMoves.length > 0 ? ctx.recentMoves.join(' → ') : '(first move)';

  const userMessage = `Move ${ctx.moveNumber}. Score: ${ctx.cumulativeScore}.

Board (numeric matrix): ${matrix}

Board (visual):
${ascii}

Legal moves this turn: ${legal.join(', ')}.
Recent moves: ${recent}.

Call make_move with your choice.`;

  const start = Date.now();
  const response = await client.chat.completions.create({
    model: AGENT_MATCH_MODEL,
    max_tokens: HERMES_MAX_TOKENS,
    temperature: HERMES_TEMPERATURE,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    tools: [MAKE_MOVE_TOOL],
    tool_choice: { type: 'function', function: { name: 'make_move' } },
  });
  const latencyMs = Date.now() - start;

  return parseMoveResponse(response, legal, latencyMs);
}
