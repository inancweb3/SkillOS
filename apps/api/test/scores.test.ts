// Fix #4c — scores route DB-primary helpers.
//
// Mirrors tournaments.test.ts (#4a-S4 / #195): the GET /v1/scores/:wallet
// handler delegates DB-row → response mapping, dedup/sort (newest-first), and
// pagination to pure helpers exported from routes/scores.ts. Tests target those
// directly; live DB + on-chain tail plumbing is exercised by post-deploy curl.
//
// Convention: node:test + node:assert/strict, matches games.test.ts.
// Run with: npx tsx --test apps/api/test/scores.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Stub Supabase + bearer env so import-time lazy-loads don't throw when the
// route module is imported (stubs are never called — pure helpers only).
process.env.SUPABASE_URL ??= 'http://supabase.test.local';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'a'.repeat(40);
process.env.API_BEARER_TOKEN ??= 'b'.repeat(40);

const {
  dbRowToScoreHistory,
  mergeScoreHistory,
  compareScoreHistoryNewestFirst,
  paginateScoreHistory,
  assertSupportedScoreTier,
} = await import('../src/routes/scores.js');

import type {
  ScoreHistoryItem,
  ScoreHistoryDbRow,
} from '../src/routes/scores.js';

const ZERO32 = `0x${'0'.repeat(64)}`;

test('assertSupportedScoreTier: accepts T0 and rejects unverified higher tiers', () => {
  assert.doesNotThrow(() => assertSupportedScoreTier('T0'));
  for (const tier of ['T1', 'T2', 'T3'] as const) {
    assert.throws(
      () => assertSupportedScoreTier(tier),
      (err: unknown) =>
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        err.code === 'TIER_NOT_IMPLEMENTED',
    );
  }
});

function dbRow(over: Partial<ScoreHistoryDbRow> = {}): ScoreHistoryDbRow {
  return {
    tournament_on_chain_id: '0x400e64484294f7965bc028cf3ff85c999d360deb1350e5f6f028b5fa0da5b7e5',
    player_address: '0x352774c4f58b09d83e6f6b55b60dc8008342bc09',
    score: '4',
    match_count_delta: '1',
    nonce: '0xabc0000000000000000000000000000000000000000000000000000000000000',
    block_number: 42279936,
    log_index: 44,
    tx_hash: '0x09c11eda0803627ab806d19eb6d9bf53b989136255619bca17a9f8d1b0a3b394',
    block_timestamp: '2026-06-01T15:36:00.000Z',
    ...over,
  };
}

// ─── dbRowToScoreHistory ────────────────────────────────────────────────────

test('dbRowToScoreHistory: maps DB row, preserves uint256 precision as string', () => {
  const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  const s = dbRowToScoreHistory(dbRow({ score: huge, match_count_delta: '10', block_number: '42279936' }));
  assert.equal(s.score, huge); // string carried through, no Number() coercion
  assert.equal(s.matchCountDelta, '10');
  assert.equal(s.blockNumber, 42279936n); // string block_number → bigint
  assert.equal(s.tournamentId, '0x400e64484294f7965bc028cf3ff85c999d360deb1350e5f6f028b5fa0da5b7e5');
  assert.equal(s.timestamp, Math.floor(Date.parse('2026-06-01T15:36:00.000Z') / 1000));
});

test('dbRowToScoreHistory: null nonce coalesces to zero bytes32 (schema-safe)', () => {
  const s = dbRowToScoreHistory(dbRow({ nonce: null }));
  assert.equal(s.nonce, ZERO32);
});

// ─── compareScoreHistoryNewestFirst: block DESC, then logIndex DESC ──────────

test('compareScoreHistoryNewestFirst: newer block first; same block → higher logIndex first', () => {
  const mk = (block: bigint, log: number): ScoreHistoryItem => ({
    tournamentId: '0x00',
    player: '0x352774c4f58b09d83e6f6b55b60dc8008342bc09',
    score: '1',
    matchCountDelta: '0',
    nonce: ZERO32 as `0x${string}`,
    blockNumber: block,
    logIndex: log,
    txHash: '0xtx',
    timestamp: 0,
  });
  assert.ok(compareScoreHistoryNewestFirst(mk(2n, 0), mk(1n, 0)) < 0); // newer block first
  assert.ok(compareScoreHistoryNewestFirst(mk(1n, 5), mk(1n, 0)) < 0); // same block → higher log first
});

// ─── mergeScoreHistory: dedup + newest-first ────────────────────────────────

test('mergeScoreHistory: dedups overlapping tail events vs DB (case-insensitive tx)', () => {
  const db = [dbRowToScoreHistory(dbRow({ tx_hash: '0xABC', log_index: 1 }))];
  const tail = [
    dbRowToScoreHistory(dbRow({ tx_hash: '0xabc', log_index: 1 })), // same event, upper-case tx
    dbRowToScoreHistory(dbRow({ tx_hash: '0xdef', log_index: 0, block_number: 42279999 })), // newer
  ];
  const merged = mergeScoreHistory(db, tail);
  assert.equal(merged.length, 2); // duplicate collapsed
  assert.equal(merged[0].blockNumber, 42279999n); // newest first
});

test('mergeScoreHistory: multi-score wallet ordered newest-first (the curl case)', () => {
  const rows = [
    dbRowToScoreHistory(dbRow({ score: '712', block_number: 41070084, log_index: 2, tx_hash: '0x3' })),
    dbRowToScoreHistory(dbRow({ score: '4', block_number: 42279936, log_index: 44, tx_hash: '0x1' })),
    dbRowToScoreHistory(dbRow({ score: '1240', block_number: 41640867, log_index: 232, tx_hash: '0x2' })),
  ];
  const merged = mergeScoreHistory(rows, []);
  assert.deepEqual(merged.map((m) => m.score), ['4', '1240', '712']); // newest block first
});

// ─── paginateScoreHistory: ScoreEntry shape + cursor ────────────────────────

test('paginateScoreHistory: maps to ScoreEntry and signals nextStart', () => {
  const sorted = Array.from({ length: 5 }, (_, i) =>
    dbRowToScoreHistory(dbRow({ score: String(i), block_number: 42279936 - i, tx_hash: `0x${i}`, log_index: i })),
  );
  const p1 = paginateScoreHistory(sorted, 0, 2);
  assert.equal(p1.items.length, 2);
  assert.equal(p1.items[0].score, '0');
  assert.equal(p1.items[0].transactionHash, '0x0'); // ScoreEntry uses transactionHash, not txHash
  assert.equal(typeof p1.items[0].blockNumber, 'number'); // bigint → number in output
  assert.equal(p1.nextStart, 2);

  const p3 = paginateScoreHistory(sorted, 4, 2);
  assert.equal(p3.items.length, 1);
  assert.equal(p3.nextStart, null); // last page → no cursor
});
