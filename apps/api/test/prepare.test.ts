// SkillOS Base plugin v1 — prepare endpoint pure-helper tests.
//
// Convention: node:test + node:assert/strict, matches tournaments.test.ts.
// The route handler delegates calldata construction to pure helpers exported
// from routes/prepare.ts; these tests target those helpers directly and decode
// the emitted calldata to prove the exact selectors + args an external Base-MCP
// agent will send via send_calls. The route module is side-effect-free at
// import (no Supabase / env requirement), so no env stubs are needed.
//
// Run with: npx tsx --test apps/api/test/prepare.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';

import {
  usdcAtoms,
  buildSponsorPoolCalls,
} from '../src/routes/prepare.js';
import {
  ERC20_ABI,
  SPONSORSHIP_MODULE_ABI,
  SPONSORSHIP_MODULE_ADDRESS,
  USDC_ADDRESS,
} from '../src/lib/contracts.js';
import { ApiError } from '../src/middleware/errorEnvelope.js';

const TID =
  '0x400e64484294f7965bc028cf3ff85c999d360deb1350e5f6f028b5fa0da5b7e5' as const;

// ─── usdcAtoms: decimal USD string → 6-dp atomic units ──────────────────────

test('usdcAtoms: whole, fractional, and max-precision amounts', () => {
  assert.equal(usdcAtoms('5'), 5_000_000n);
  assert.equal(usdcAtoms('0.5'), 500_000n);
  assert.equal(usdcAtoms('12.345'), 12_345_000n);
  assert.equal(usdcAtoms('0.000001'), 1n); // one atom
  assert.equal(usdcAtoms('0'), 0n); // zero parses; rejection happens in build/handler
});

test('usdcAtoms: throws on malformed input (>6 dp, non-numeric, negative)', () => {
  assert.throws(() => usdcAtoms('1.0000001')); // 7 fractional digits
  assert.throws(() => usdcAtoms('abc'));
  assert.throws(() => usdcAtoms('-1'));
  assert.throws(() => usdcAtoms('1e6'));
});

// ─── buildSponsorPoolCalls: the send_calls batch ────────────────────────────

test('buildSponsorPoolCalls: returns [approve, sponsorPool] in order with 0x0 value', () => {
  const { calls, atoms } = buildSponsorPoolCalls({ tournamentId: TID, amount: '5' });
  assert.equal(atoms, 5_000_000n);
  assert.equal(calls.length, 2);

  // Call 0 — USDC.approve(SponsorshipModule, atoms)
  assert.equal(calls[0].to, USDC_ADDRESS);
  assert.equal(calls[0].value, '0x0');
  assert.equal(calls[0].data.slice(0, 10), '0x095ea7b3'); // approve(address,uint256) selector

  // Call 1 — SponsorshipModule.sponsorPool(tournamentId, atoms)
  assert.equal(calls[1].to, SPONSORSHIP_MODULE_ADDRESS);
  assert.equal(calls[1].value, '0x0');
  assert.equal(calls[1].data.slice(0, 10), '0x78e0c649'); // sponsorPool(bytes32,uint256) selector
});

test('buildSponsorPoolCalls: decoded approve grants the module the exact pull', () => {
  const { calls, atoms } = buildSponsorPoolCalls({ tournamentId: TID, amount: '12.345' });
  const decoded = decodeFunctionData({ abi: ERC20_ABI, data: calls[0].data });
  assert.equal(decoded.functionName, 'approve');
  // spender must be the SponsorshipModule (not the pool, not the agent).
  assert.equal(
    (decoded.args[0] as string).toLowerCase(),
    SPONSORSHIP_MODULE_ADDRESS.toLowerCase(),
  );
  assert.equal(decoded.args[1], atoms); // approval == sponsorship amount, no over-grant
});

test('buildSponsorPoolCalls: decoded sponsorPool carries tournamentId + amount', () => {
  const { calls, atoms } = buildSponsorPoolCalls({ tournamentId: TID, amount: '0.5' });
  const decoded = decodeFunctionData({ abi: SPONSORSHIP_MODULE_ABI, data: calls[1].data });
  assert.equal(decoded.functionName, 'sponsorPool');
  assert.equal((decoded.args[0] as string).toLowerCase(), TID.toLowerCase());
  assert.equal(decoded.args[1], atoms);
});

test('buildSponsorPoolCalls: rejects a zero amount with a 422 ApiError', () => {
  assert.throws(
    () => buildSponsorPoolCalls({ tournamentId: TID, amount: '0' }),
    (err: unknown) => err instanceof ApiError && err.status === 422 && err.code === 'INVALID_PARAMS',
  );
});

test('buildSponsorPoolCalls: approval never exceeds the sponsorship amount across amounts', () => {
  // Guards the invariant that the agent grants exactly what it sponsors — no
  // lingering allowance the module could draw on later.
  for (const amount of ['1', '0.25', '1000', '0.000007']) {
    const { calls, atoms } = buildSponsorPoolCalls({ tournamentId: TID, amount });
    const approve = decodeFunctionData({ abi: ERC20_ABI, data: calls[0].data });
    const sponsor = decodeFunctionData({ abi: SPONSORSHIP_MODULE_ABI, data: calls[1].data });
    assert.equal(approve.args[1], atoms);
    assert.equal(sponsor.args[1], atoms);
  }
});
