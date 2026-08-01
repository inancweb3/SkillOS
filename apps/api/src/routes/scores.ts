import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { type Hex, BaseError, ContractFunctionRevertedError } from 'viem';
import {
  ErrorEnvelopeSchema,
  PaginationQuerySchema,
  WalletAddressSchema,
} from '../schemas/common.js';
import {
  ScoreHistoryResponseSchema,
  type ScoreEntry,
} from '../schemas/score.js';
import {
  ScoreSubmitRequestSchema,
  ScoreSubmitResponseSchema,
} from '../schemas/auth.js';
import {
  TOURNAMENT_POOL_ABI,
  TOURNAMENT_POOL_V21_ADDRESS,
} from '../lib/contracts.js';
import { signSoloSubmitAttestation } from '../lib/contracts-vendored/attestation.js';
import { getWalletClient } from '../lib/contracts-vendored/wallet-client.js';
import {
  decodeIndexCursor,
  encodeIndexCursor,
} from '../lib/pagination.js';
import { scanContractEvents } from '../lib/scan.js';
import { FROM_BLOCK, getPublicClient } from '../lib/viem.js';
import { getSupabaseClient } from '../lib/supabase.js';
import { ApiError } from '../middleware/errorEnvelope.js';
import { requireBearer } from '../middleware/bearer.js';
import { rateLimit } from '../lib/rate-limit.js';

// On-chain SoloScoreSubmitted log shape (the freshness tail). The pool emits
// SoloScoreSubmitted (NOT ScoreSubmitted) for solo runs — verified on-chain;
// ScoreSubmitted has zero occurrences on the deployed pool.
type SoloScoreRow = {
  args: {
    id?: `0x${string}`;
    player?: `0x${string}`;
    score?: bigint;
    matchCountDelta?: bigint;
    nonce?: `0x${string}`;
  };
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
};

const ZERO_BYTES32 = `0x${'0'.repeat(64)}` as `0x${string}`;

// ─── Pure helpers (unit-tested in test/scores.test.ts) ──────────────────────

/** Unified score-history row across DB + tail; newest-first sortable. */
export type ScoreHistoryItem = {
  tournamentId: `0x${string}`;
  player: `0x${string}`;
  score: string; // uint256 at full precision (no Number() coercion)
  matchCountDelta: string;
  nonce: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
  txHash: `0x${string}`;
  timestamp: number; // unix seconds
};

/** v2_tournament_scores row (score/match_count_delta selected as ::text). */
export type ScoreHistoryDbRow = {
  tournament_on_chain_id: string;
  player_address: string;
  score: string;
  match_count_delta: string;
  nonce: string | null;
  block_number: number | string;
  log_index: number;
  tx_hash: string;
  block_timestamp: string;
};

export function dbRowToScoreHistory(r: ScoreHistoryDbRow): ScoreHistoryItem {
  return {
    tournamentId: r.tournament_on_chain_id as `0x${string}`,
    player: r.player_address as `0x${string}`,
    score: String(r.score),
    matchCountDelta: String(r.match_count_delta),
    // nonce is nullable in the read-model; ScoreEntry.nonce is a required
    // bytes32 — coalesce a null to the zero hash so a missing nonce never
    // fails response validation (SoloScoreSubmitted always emits one, so this
    // is defensive).
    nonce: (r.nonce ?? ZERO_BYTES32) as `0x${string}`,
    blockNumber: BigInt(r.block_number),
    logIndex: r.log_index,
    txHash: r.tx_hash as `0x${string}`,
    timestamp: Math.floor(new Date(r.block_timestamp).getTime() / 1000),
  };
}

/** Event identity used to dedup the tail against the read-model. */
export function scoreHistoryKey(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}:${logIndex}`;
}

/** Newest-first: block DESC, then logIndex DESC (preserves prior semantics). */
export function compareScoreHistoryNewestFirst(
  a: ScoreHistoryItem,
  b: ScoreHistoryItem,
): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
  return b.logIndex - a.logIndex;
}

/** Merge read-model + freshness tail, dedup by (tx_hash, log_index), sort. */
export function mergeScoreHistory(
  dbItems: ScoreHistoryItem[],
  tailItems: ScoreHistoryItem[],
): ScoreHistoryItem[] {
  const seen = new Set<string>();
  const out: ScoreHistoryItem[] = [];
  for (const s of [...dbItems, ...tailItems]) {
    const k = scoreHistoryKey(s.txHash, s.logIndex);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  out.sort(compareScoreHistoryNewestFirst);
  return out;
}

/** Slice one page and map to the ScoreEntry wire shape. */
export function paginateScoreHistory(
  sorted: ScoreHistoryItem[],
  start: number,
  limit: number,
): { items: ScoreEntry[]; nextStart: number | null } {
  const slice = sorted.slice(start, start + limit);
  const items: ScoreEntry[] = slice.map((s) => ({
    tournamentId: s.tournamentId,
    player: s.player,
    score: s.score,
    matchCountDelta: s.matchCountDelta,
    nonce: s.nonce,
    blockNumber: Number(s.blockNumber),
    transactionHash: s.txHash,
    timestamp: s.timestamp,
  }));
  const nextStart = start + limit < sorted.length ? start + limit : null;
  return { items, nextStart };
}

// Structured error log for the DB / on-chain fallback paths. Replaces the
// opaque "[unhandled]" 500 with a single JSON line carrying the wallet, scan
// window, and cause — so a DB-only degrade (or a 502) is debuggable from logs.
function logScoresFallback(fields: {
  event: string;
  wallet: string;
  floor?: string;
  message: string;
}): void {
  console.error(JSON.stringify({ level: 'error', route: 'scores', ...fields }));
}

// Scores indexer watermark (last fully-indexed block). Non-fatal — null on
// miss so the tail floor falls back to FROM_BLOCK.
async function readScoresWatermark(
  supabase: ReturnType<typeof getSupabaseClient>,
): Promise<bigint | null> {
  const { data } = await supabase
    .from('v2_tournament_scores_indexer_state')
    .select('last_indexed_block')
    .eq('contract_address', TOURNAMENT_POOL_V21_ADDRESS.toLowerCase())
    .maybeSingle<{ last_indexed_block: number | string }>();
  return data?.last_indexed_block != null ? BigInt(data.last_indexed_block) : null;
}

export const scoreRoutes = new OpenAPIHono();

const route = createRoute({
  method: 'get',
  path: '/v1/scores/{wallet}',
  summary: 'Score submissions by wallet',
  description:
    'All SoloScoreSubmitted entries where player == :wallet, across every tournament, sorted newest-first. DB-primary from the v2_tournament_scores read-model, with a bounded on-chain freshness tail.',
  tags: ['scores'],
  request: {
    params: z.object({ wallet: WalletAddressSchema }),
    query: PaginationQuerySchema,
  },
  responses: {
    200: {
      description: 'Score history page',
      content: {
        'application/json': { schema: ScoreHistoryResponseSchema },
      },
    },
    422: {
      description: 'Invalid params',
      content: { 'application/json': { schema: ErrorEnvelopeSchema } },
    },
    502: {
      description: 'Read-model empty and on-chain tail-scan unavailable',
      content: { 'application/json': { schema: ErrorEnvelopeSchema } },
    },
  },
});

scoreRoutes.openapi(route, async (c) => {
  const { wallet } = c.req.valid('param');
  const { cursor, limit } = c.req.valid('query');
  const walletLower = wallet.toLowerCase();
  const supabase = getSupabaseClient();

  // ── DB-primary: the v2_tournament_scores read-model, server-side ordered
  // newest-first. score / match_count_delta selected as ::text so numeric(78,0)
  // keeps full uint256 precision (Number() coercion would lose it).
  const { data: dbData, error: dbError } = await supabase
    .from('v2_tournament_scores')
    .select('tournament_on_chain_id, player_address, score::text, match_count_delta::text, nonce, block_number, log_index, tx_hash, block_timestamp')
    .eq('player_address', walletLower)
    .order('block_number', { ascending: false })
    .order('log_index', { ascending: false });
  if (dbError) {
    logScoresFallback({ event: 'db_read_failed', wallet, message: dbError.message });
    throw new ApiError(
      502,
      'UPSTREAM_UNAVAILABLE',
      `v2_tournament_scores read failed: ${dbError.message}`,
    );
  }
  const dbItems = ((dbData ?? []) as ScoreHistoryDbRow[]).map(dbRowToScoreHistory);

  // ── Bounded freshness tail-scan: SoloScoreSubmitted filtered by player, from
  // the indexer watermark+1 to tip (the genuine freshness gap — the read-model
  // is authoritative ≤ watermark). Wrapped so any RPC failure degrades to
  // DB-only instead of 500-ing.
  let tailItems: ScoreHistoryItem[] = [];
  let tailFailed = false;
  let floor = FROM_BLOCK;
  try {
    const client = getPublicClient();
    const watermark = await readScoresWatermark(supabase);
    floor = watermark != null ? watermark + 1n : FROM_BLOCK;
    const tip = await client.getBlockNumber();
    const tail = await scanContractEvents<SoloScoreRow>({
      address: TOURNAMENT_POOL_V21_ADDRESS,
      abi: TOURNAMENT_POOL_ABI,
      eventName: 'SoloScoreSubmitted',
      args: { player: wallet as `0x${string}` },
      fromBlock: floor,
      toBlock: tip,
    });

    const blocks = [...new Set(tail.map((e) => e.blockNumber))];
    const blockTimes = new Map<bigint, number>();
    await Promise.all(
      blocks.map(async (bn) => {
        const b = await client.getBlock({ blockNumber: bn });
        blockTimes.set(bn, Number(b.timestamp));
      }),
    );
    tailItems = tail.map((ev) => ({
      tournamentId: ev.args.id!,
      player: ev.args.player!,
      score: (ev.args.score ?? 0n).toString(),
      matchCountDelta: (ev.args.matchCountDelta ?? 0n).toString(),
      nonce: ev.args.nonce ?? ZERO_BYTES32,
      blockNumber: ev.blockNumber,
      logIndex: ev.logIndex,
      txHash: ev.transactionHash,
      timestamp: blockTimes.get(ev.blockNumber) ?? 0,
    }));
  } catch (err) {
    tailFailed = true;
    logScoresFallback({
      event: 'tail_scan_failed',
      wallet,
      floor: floor.toString(),
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const merged = mergeScoreHistory(dbItems, tailItems);

  // Empty read-model AND a failed tail → can't confirm the history.
  if (merged.length === 0 && tailFailed) {
    throw new ApiError(
      502,
      'UPSTREAM_UNAVAILABLE',
      `Score history for ${wallet} unavailable: read-model empty and tail-scan failed`,
    );
  }

  const start = decodeIndexCursor(cursor) ?? 0;
  const { items, nextStart } = paginateScoreHistory(merged, start, limit);
  const next = nextStart !== null ? encodeIndexCursor(nextStart) : undefined;

  return c.json(
    { wallet, items, pagination: next ? { next } : {} },
    200,
  );
});

// ─── POST /v1/scores ──────────────────────────────────────────────────────
//
// Trust tier (per project_phase2_mainnet_blocker_plausibility memory):
//   T0 only — server signs whatever score the bearer-authenticated wallet
//   claims, no AI plausibility validation. External devs / agents using
//   this path operate at lower trust tier intentionally; game-app frontends
//   keep using their own backend (with plausibility) via duel-backend's
//   Next.js handlers. Pre-mainnet hard blocker: T1+ verification before
//   real-USDC tournaments can route through this endpoint.
//
// Response headers make the trust tier explicit to consumers (SDK X3, MCP X6):
//   X-SkillOS-Tier: T0
//   X-SkillOS-Verification: signature-only

const submitRoute = createRoute({
  method: 'post',
  path: '/v1/scores',
  summary: 'Submit a score (T0 signature-only)',
  description:
    'Bearer-authenticated. Server signs a submitSoloScore attestation with STUDIO_PRIVATE_KEY and broadcasts on-chain (fire-and-forget; tx hash returned before block inclusion). T0 is signature-only (no plausibility, no DB persistence). T1+ remains disabled until replay or equivalent score plausibility verification is implemented.',
  tags: ['scores'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: ScoreSubmitRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Submission broadcast on-chain',
      content: { 'application/json': { schema: ScoreSubmitResponseSchema } },
      headers: z.object({
        'X-SkillOS-Tier': z.literal('T0'),
        'X-SkillOS-Verification': z.literal('signature-only'),
      }),
    },
    400: {
      description: 'Bearer or input invalid',
      content: { 'application/json': { schema: ErrorEnvelopeSchema } },
    },
    409: {
      description: 'On-chain submitSoloScore reverted.',
      content: { 'application/json': { schema: ErrorEnvelopeSchema } },
    },
    429: {
      description: 'Rate limit exceeded (30/min per wallet, Upstash-backed)',
      content: { 'application/json': { schema: ErrorEnvelopeSchema } },
    },
  },
});

export function assertSupportedScoreTier(
  tier: 'T0' | 'T1' | 'T2' | 'T3',
): asserts tier is 'T0' {
  if (tier !== 'T0') {
    throw new ApiError(
      400,
      'TIER_NOT_IMPLEMENTED',
      `Tier ${tier} requires replay or equivalent score plausibility verification. Only T0 is currently accepted.`,
    );
  }
}

scoreRoutes.use('/v1/scores', requireBearer());
scoreRoutes.openapi(submitRoute, async (c) => {
  const wallet = c.get('walletAddress');

  // X15.5: Upstash-backed submit bucket, 30 req/min per wallet. Throws 429
  // on rejection (rateLimit sets X-RateLimit-* response headers itself).
  await rateLimit('submit', wallet.toLowerCase(), c);

  const body = c.req.valid('json');

  assertSupportedScoreTier(body.tier);

  const soloRunId: Hex = (body.soloRunId as Hex | undefined) ??
    (`0x${randomBytes(32).toString('hex')}` as Hex);
  const onChainNonce = `0x${randomBytes(32).toString('hex')}` as Hex;

  const signature = await signSoloSubmitAttestation({
    tournamentId: body.tournamentId as Hex,
    player: wallet,
    score: BigInt(body.score),
    soloRunId,
    matchCountDelta: BigInt(body.matchCountDelta),
    nonce: onChainNonce,
  });

  const walletClient = getWalletClient();
  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      address: TOURNAMENT_POOL_V21_ADDRESS,
      abi: TOURNAMENT_POOL_ABI,
      functionName: 'submitSoloScore',
      args: [
        body.tournamentId as Hex,
        wallet,
        BigInt(body.score),
        soloRunId,
        BigInt(body.matchCountDelta),
        onChainNonce,
        signature,
      ],
    });
  } catch (err) {
    // Surface contract-revert reasons as actionable client errors. The
    // ContractFunctionRevertedError nests inside a wrapping BaseError; the
    // walk-cause traversal handles both shapes.
    if (err instanceof BaseError) {
      const reverted = err.walk(
        (e) => e instanceof ContractFunctionRevertedError,
      );
      if (reverted instanceof ContractFunctionRevertedError) {
        const errorName = reverted.data?.errorName ?? 'Unknown';
        throw new ApiError(
          409,
          `CHAIN_REVERT_${errorName}`,
          `submitSoloScore reverted on-chain: ${errorName}`,
        );
      }
    }
    throw err;
  }

  c.header('X-SkillOS-Tier', 'T0');
  c.header('X-SkillOS-Verification', 'signature-only');
  return c.json(
    {
      txHash,
      soloRunId,
      submittedAt: new Date().toISOString(),
      tier: 'T0' as const,
    },
    200,
  );
});
