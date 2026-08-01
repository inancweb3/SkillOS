// Sprint X20 — Solo match orchestrator.
//
// Runs a single agent-vs-deterministic-2048 match end-to-end:
//   1. Hydrate initial board from seed
//   2. Loop: agent.getNextMove → engine.move → engine.spawnTile → INSERT duel_moves
//   3. Loop exits on: win (2048 tile) | no legal moves (game_over) | 5x same
//      move (stuck) | wall-clock timeout | Claude error (error)
//   4. UPDATE duel_runs status + end_reason + final_score
//   5. If X20_DEMO_TOURNAMENT_ID env set + endReason ∈ {win, game_over, stuck}:
//      submit on-chain via X10 wire (signSoloSubmitAttestation + dataSuffix +
//      writeContract). Timeout and error skip submit — timeout is mid-function
//      so the wallet write may not finish; error means state is corrupted.
//
// Called from /v1/agents/matches/start-solo via c.executionCtx.waitUntil so
// the HTTP response returns the runId immediately while the match runs in the
// background of the same function invocation.

import { randomBytes } from 'node:crypto';
import {
  type Address,
  type Hex,
  BaseError,
  ContractFunctionRevertedError,
} from 'viem';

import {
  TOURNAMENT_POOL_ABI,
  TOURNAMENT_POOL_V21_ADDRESS,
} from '../contracts.js';
import { signSoloSubmitAttestation } from '../contracts-vendored/attestation.js';
import { getWalletClient } from '../contracts-vendored/wallet-client.js';
import { dataSuffixForGame } from '../games.js';
import { getSupabaseClient } from '../supabase.js';
import {
  type AgentMoveContext,
  getNextMove,
} from './anthropic-agent.js';
import {
  type Board,
  BOARD_SIZE,
  canMove,
  createInitialBoard,
  type Direction,
  move as applyMove,
  spawnTile,
} from './game-2048.js';

// Match budget. Phase 2 readiness: play to authentic game-end, not an
// arbitrary 24-move cap. Vercel function maxDuration is 240s (vercel.json);
// MATCH_TIMEOUT_MS fires 20s before that so finalizeRun + maybeSubmitOnChain
// land before the runtime kills the function. STUCK_THRESHOLD detects an
// agent looping the same legal direction (e.g. repeated 'down') — 5 in a row
// forfeits, since 2048 rarely needs 5 identical moves to make progress.
// MAX_DEFENSIVE_MOVES is a sanity bound that should never trip given the
// terminal checks above; if it does, the run is recorded as 'error'.
const MAX_DURATION_SECONDS = 240;
const MATCH_TIMEOUT_MS = (MAX_DURATION_SECONDS - 20) * 1000;
const STUCK_THRESHOLD = 5;
const MAX_DEFENSIVE_MOVES = 10_000;
const WINNING_TILE = 2048;
const CHALLENGE_ESCROW_ADDRESS = '0x52e5E45456DeC882048b430a968Cda6061575be0';

type EndReason = 'win' | 'game_over' | 'timeout' | 'stuck' | 'error';

export interface StartSoloInput {
  game: '2048';
  /** SIWA-authenticated agent that owns and pays for this run. */
  agentAddress: Address;
}

export interface StartSoloResult {
  runId: string;
  seed: string;
  agentAddress: Address;
}

/**
 * Inserts a duel_runs row in 'pending' status and returns the runId for the
 * client to navigate to /watch/[runId]. Caller is responsible for kicking
 * off `runSoloMatch` in the background (waitUntil).
 */
export async function reserveSoloRun(input: StartSoloInput): Promise<StartSoloResult> {
  const seed: Hex = `0x${randomBytes(32).toString('hex')}` as Hex;
  const agentAddress = input.agentAddress;

  const sb = getSupabaseClient();
  const { data, error } = await sb
    .from('duel_runs')
    .insert({
      game: input.game,
      seed,
      mode: 'solo',
      agent_address: agentAddress,
      status: 'pending',
      challenge_escrow_address: CHALLENGE_ESCROW_ADDRESS,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to reserve duel_run: ${error?.message ?? 'no row returned'}`);
  }

  return { runId: data.id as string, seed, agentAddress };
}

interface RunSoloMatchArgs {
  runId: string;
  seed: string;
  game: '2048';
  agentAddress: Address;
}

/**
 * Drives the match to completion. Tolerates Anthropic errors per-move (logs +
 * fallback baseline). Updates duel_runs status on exit. Should never throw
 * to its caller (waitUntil) — failures land as status='error' on the row.
 */
export async function runSoloMatch(args: RunSoloMatchArgs): Promise<void> {
  const sb = getSupabaseClient();
  const startedAt = Date.now();
  const agentAddress = args.agentAddress;
  let cumulativeScore = 0;

  try {
    await sb
      .from('duel_runs')
      .update({ status: 'running' })
      .eq('id', args.runId);

    const init = createInitialBoard(args.seed);
    let board: Board = init.board;
    const rng = init.rng;
    const recentMoves: Direction[] = [];

    for (let moveNumber = 1; moveNumber <= MAX_DEFENSIVE_MOVES; moveNumber++) {
      // Terminal: wall-clock timeout. No on-chain submit — wallet write may
      // not finish before maxDuration kills the function.
      if (Date.now() - startedAt > MATCH_TIMEOUT_MS) {
        await finalizeRun(args.runId, 'timeout', cumulativeScore);
        return;
      }

      // Terminal: agent made the 2048 tile.
      if (hasWinningTile(board)) {
        await finalizeRun(args.runId, 'win', cumulativeScore);
        await maybeSubmitOnChain({ runId: args.runId, game: args.game, score: cumulativeScore, agentAddress });
        return;
      }

      // Terminal: board full and no merges available.
      if (!canMove(board)) {
        await finalizeRun(args.runId, 'game_over', cumulativeScore);
        await maybeSubmitOnChain({ runId: args.runId, game: args.game, score: cumulativeScore, agentAddress });
        return;
      }

      // Terminal: agent is looping the same direction. Forfeit.
      if (isStuck(recentMoves)) {
        await finalizeRun(args.runId, 'stuck', cumulativeScore);
        await maybeSubmitOnChain({ runId: args.runId, game: args.game, score: cumulativeScore, agentAddress });
        return;
      }

      const ctx: AgentMoveContext = {
        board,
        cumulativeScore,
        moveNumber,
        recentMoves: recentMoves.slice(-5),
      };

      let direction: Direction;
      let reasoning: string;
      let latencyMs: number;
      try {
        const result = await getNextMove(ctx);
        direction = result.direction;
        reasoning = result.reasoning;
        latencyMs = result.latencyMs;
      } catch (err) {
        // Fallback: pick first legal move. Better than aborting the match.
        const fallback = fallbackMove(board);
        if (!fallback) {
          // Agent threw and engine confirms no legal move — that's game_over.
          await finalizeRun(args.runId, 'game_over', cumulativeScore);
          await maybeSubmitOnChain({ runId: args.runId, game: args.game, score: cumulativeScore, agentAddress });
          return;
        }
        direction = fallback;
        reasoning = `(Fallback: agent error — ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}.)`;
        latencyMs = 0;
      }

      const boardBefore = board;
      const { board: postMove, gained, moved } = applyMove(board, direction);

      if (!moved) {
        // legalMoves filter normally prevents this; defensive only.
        recentMoves.push(direction);
        continue;
      }

      const boardAfter = spawnTile(postMove, rng);
      cumulativeScore += gained;
      recentMoves.push(direction);
      board = boardAfter;

      const { error: insertError } = await sb.from('duel_moves').insert({
        run_id: args.runId,
        move_number: moveNumber,
        direction,
        board_before: boardBefore,
        board_after: boardAfter,
        score_delta: gained,
        cumulative_score: cumulativeScore,
        reasoning,
        latency_ms: latencyMs,
      });

      if (insertError) {
        console.error('[duel-runner] move insert failed', insertError);
        // Continue the match — losing a move-row is bad but bailing is worse.
      }
    }

    // Hit MAX_DEFENSIVE_MOVES without a terminal condition tripping. The
    // terminal checks above should prevent this; reaching here implies a bug.
    await finalizeRun(args.runId, 'error', cumulativeScore, `exceeded MAX_DEFENSIVE_MOVES=${MAX_DEFENSIVE_MOVES} sanity bound`);
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : 'unknown error';
    console.error('[duel-runner] unhandled error', err);
    await finalizeRun(args.runId, 'error', cumulativeScore, message);
  }
}

function hasWinningTile(board: Board): boolean {
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] >= WINNING_TILE) return true;
    }
  }
  return false;
}

function isStuck(recentMoves: Direction[]): boolean {
  if (recentMoves.length < STUCK_THRESHOLD) return false;
  const tail = recentMoves.slice(-STUCK_THRESHOLD);
  return tail.every((d) => d === tail[0]);
}

async function finalizeRun(
  runId: string,
  endReason: EndReason,
  finalScore: number,
  errorMessage?: string,
): Promise<void> {
  const sb = getSupabaseClient();
  const status: 'ended' | 'timeout' | 'error' =
    endReason === 'timeout' ? 'timeout' : endReason === 'error' ? 'error' : 'ended';

  const update: Record<string, unknown> = {
    status,
    end_reason: endReason,
    final_score: finalScore,
    ended_at: new Date().toISOString(),
  };
  if (errorMessage) update.error_message = errorMessage;

  await sb.from('duel_runs').update(update).eq('id', runId);
}

function fallbackMove(board: Board): Direction | null {
  const order: Direction[] = ['down', 'left', 'right', 'up'];
  for (const d of order) {
    if (applyMove(board, d).moved) return d;
  }
  return null;
}

interface SubmitArgs {
  runId: string;
  game: '2048';
  score: number;
  agentAddress: Address;
}

/**
 * On-chain submitSoloScore via the X10 wire. Env-gated:
 * X20_DEMO_TOURNAMENT_ID must be set (bytes32 hex) to a real Base Sepolia
 * tournament that accepts solo submissions for this game. If unset, we log
 * and skip — local dev + first-deploy stay functional.
 */
async function maybeSubmitOnChain(args: SubmitArgs): Promise<void> {
  const tournamentId = process.env.X20_DEMO_TOURNAMENT_ID as Hex | undefined;
  if (!tournamentId || !tournamentId.startsWith('0x')) {
    console.warn('[duel-runner] X20_DEMO_TOURNAMENT_ID unset — skipping on-chain submit');
    return;
  }

  const sb = getSupabaseClient();
  const soloRunId: Hex = `0x${randomBytes(32).toString('hex')}` as Hex;
  const onChainNonce: Hex = `0x${randomBytes(32).toString('hex')}` as Hex;

  try {
    const signature = await signSoloSubmitAttestation({
      tournamentId,
      player: args.agentAddress,
      score: BigInt(args.score),
      soloRunId,
      matchCountDelta: 1n,
      nonce: onChainNonce,
    });

    const walletClient = getWalletClient();
    const dataSuffix = dataSuffixForGame(args.game);

    const txHash = await walletClient.writeContract({
      address: TOURNAMENT_POOL_V21_ADDRESS,
      abi: TOURNAMENT_POOL_ABI,
      functionName: 'submitSoloScore',
      args: [
        tournamentId,
        args.agentAddress,
        BigInt(args.score),
        soloRunId,
        1n,
        onChainNonce,
        signature,
      ],
      dataSuffix,
    });

    await sb
      .from('duel_runs')
      .update({ on_chain_tx_hash: txHash })
      .eq('id', args.runId);
  } catch (err) {
    if (err instanceof BaseError) {
      const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
      if (reverted instanceof ContractFunctionRevertedError) {
        console.error('[duel-runner] on-chain revert', reverted.data?.errorName);
      }
    } else {
      console.error('[duel-runner] on-chain submit failed', err);
    }
    // Don't bubble the failure — the run is otherwise complete; chain submit
    // is opportunistic for X20 MVP. Future X21 retries via a poller job.
  }
}
