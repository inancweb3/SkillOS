// Hermes brain dry-run harness — Hermes-vs-Claude brain swap, B-direct path.
//
//   npm run -w apps/api hermes:dryrun -- --mock   # offline logic check (no key)
//   OPENROUTER_API_KEY=sk-or-... \
//     npm run -w apps/api hermes:dryrun            # LIVE call, prints latency
//
// --mock exercises the pure parseMoveResponse() against synthetic OpenRouter
// completions (valid move / illegal→fallback / missing tool_call / bad JSON /
// invalid direction). No network, no key — provable in CI-like conditions.
//
// LIVE mode calls the real hermes-agent getNextMove() against 3 sample boards,
// confirms each returns a LEGAL Direction + reasoning, and reports per-move +
// median latency (feeds the B4 405B-vs-70B model call). Requires a real
// OPENROUTER_API_KEY in the local env ONLY — never commit it.

import 'dotenv/config';

import type { ChatCompletion } from 'openai/resources/chat/completions';

import { getNextMove, parseMoveResponse } from '../src/lib/duel/hermes-agent.js';
import {
  AGENT_MATCH_MODEL,
  AGENT_MATCH_MODEL_DISPLAY,
} from '../src/lib/duel/hermes-client.js';
import {
  type Board,
  type Direction,
  legalMoves,
} from '../src/lib/duel/game-2048.js';
import type { AgentMoveContext } from '../src/lib/duel/anthropic-agent.js';

const MOCK = process.argv.includes('--mock');

// ── Sample boards: early / mid (corner strategy) / near-full (forced merge) ──
const SAMPLE_BOARDS: Array<{ label: string; board: Board }> = [
  {
    label: 'early game (sparse)',
    board: [
      [2, 0, 0, 0],
      [0, 4, 0, 0],
      [0, 0, 2, 0],
      [0, 0, 0, 0],
    ],
  },
  {
    label: 'mid game (largest pinned bottom-right)',
    board: [
      [0, 0, 2, 4],
      [0, 2, 8, 16],
      [4, 16, 32, 64],
      [8, 32, 128, 256],
    ],
  },
  {
    label: 'near-full (only merges legal)',
    board: [
      [2, 4, 8, 16],
      [4, 8, 16, 32],
      [8, 16, 32, 64],
      [16, 32, 64, 64],
    ],
  },
];

function fakeCompletion(args: string, opts?: { noTool?: boolean; name?: string }): ChatCompletion {
  const tool_calls = opts?.noTool
    ? []
    : [
        {
          id: 'call_1',
          type: 'function' as const,
          function: { name: opts?.name ?? 'make_move', arguments: args },
        },
      ];
  return {
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls } }],
  } as unknown as ChatCompletion;
}

function expectThrow(label: string, fn: () => unknown): boolean {
  try {
    fn();
    console.log(`  ✗ ${label} — expected throw, got none`);
    return false;
  } catch {
    console.log(`  ✓ ${label} — threw as expected`);
    return true;
  }
}

function runMock(): number {
  console.log('── MOCK: parseMoveResponse logic (no network) ──\n');
  let ok = 0;
  let total = 0;

  // 1. Valid legal move passes through.
  total++;
  const legal: Direction[] = ['up', 'down', 'left', 'right'];
  const r1 = parseMoveResponse(
    fakeCompletion('{"direction":"left","reasoning":"slide toward the corner"}'),
    legal,
    42,
  );
  if (r1.direction === 'left' && r1.reasoning.includes('corner') && r1.latencyMs === 42) {
    console.log('  ✓ valid legal move → passthrough'); ok++;
  } else {
    console.log('  ✗ valid legal move →', JSON.stringify(r1));
  }

  // 2. Illegal move → fallback to legal[0] with synthesized note.
  total++;
  const r2 = parseMoveResponse(
    fakeCompletion('{"direction":"up","reasoning":"go up"}'),
    ['left', 'right'],
    7,
  );
  if (r2.direction === 'left' && r2.reasoning.startsWith('(Fallback:') && r2.reasoning.includes('illegal up')) {
    console.log('  ✓ illegal move → fallback to first legal'); ok++;
  } else {
    console.log('  ✗ illegal move →', JSON.stringify(r2));
  }

  // 3-5. Error paths throw.
  if (expectThrow('missing tool_call', () => parseMoveResponse(fakeCompletion('', { noTool: true }), legal, 0))) ok++;
  total++;
  if (expectThrow('malformed JSON args', () => parseMoveResponse(fakeCompletion('{not json'), legal, 0))) ok++;
  total++;
  if (expectThrow('invalid direction', () => parseMoveResponse(fakeCompletion('{"direction":"sideways","reasoning":"x"}'), legal, 0))) ok++;
  total++;

  // 6. Sample boards all expose legal moves (so getNextMove won't pre-throw).
  console.log('\n── MOCK: sample boards expose legal moves ──\n');
  for (const { label, board } of SAMPLE_BOARDS) {
    total++;
    const lm = legalMoves(board);
    if (lm.length > 0) {
      console.log(`  ✓ ${label} → legal: [${lm.join(', ')}]`); ok++;
    } else {
      console.log(`  ✗ ${label} → NO legal moves`);
    }
  }

  console.log(`\nMOCK result: ${ok}/${total} checks passed`);
  return ok === total ? 0 : 1;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

async function runLive(): Promise<number> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY not set. Set it in your local env (NOT committed) or run with --mock.');
    return 2;
  }
  console.log(`── LIVE: ${AGENT_MATCH_MODEL_DISPLAY} (${AGENT_MATCH_MODEL}) ──\n`);
  const latencies: number[] = [];
  let illegalReturned = 0;

  for (let i = 0; i < SAMPLE_BOARDS.length; i++) {
    const { label, board } = SAMPLE_BOARDS[i];
    const legal = legalMoves(board);
    const ctx: AgentMoveContext = {
      board,
      cumulativeScore: 100 * i,
      moveNumber: i + 1,
      recentMoves: [],
    };
    try {
      const res = await getNextMove(ctx);
      const isLegal = legal.includes(res.direction);
      if (!isLegal) illegalReturned++;
      latencies.push(res.latencyMs);
      console.log(`  [${i + 1}] ${label}`);
      console.log(`      legal: [${legal.join(', ')}]`);
      console.log(`      → direction=${res.direction} ${isLegal ? '(LEGAL)' : '(ILLEGAL!)'}  latency=${res.latencyMs}ms`);
      console.log(`      reasoning: ${res.reasoning}\n`);
    } catch (err) {
      console.error(`  [${i + 1}] ${label} → ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
  }

  console.log('── latency summary ──');
  console.log(`  per-move: [${latencies.join(', ')}] ms`);
  console.log(`  median:   ${median(latencies)} ms`);
  console.log(`  illegal-direction returns: ${illegalReturned} (fallback handles these; 0 is ideal)`);
  return 0;
}

const exit = MOCK ? runMock() : await runLive();
process.exit(exit);
