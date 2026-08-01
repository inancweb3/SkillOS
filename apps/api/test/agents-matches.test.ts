// Run with: npx tsx --test apps/api/test/agents-matches.test.ts
//
// Hotfix C1 — SIWA auth gate on /v1/agents/matches/*.
//
// Covers the two 401 paths that prove the auth gate is wired:
//   1. anonymous POST (no SIWA receipt, no ERC-8128 sig)
//   2. SIWA receipt present but ERC-8128 per-request sig missing/invalid
//
// The full happy-path (SIWA + ERC-8128 → 202) requires a signed receipt
// fixture, a real waitUntil shim, and Supabase reserveSoloRun mocks — out
// of scope for a hotfix test that needs only to prove the gate exists.
// E2E coverage lives in the X21 matchmaker test suite (TBD).
//
// Convention: node:test + node:assert/strict, matches games.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Must be set BEFORE importing the routes module: requireSiwaAuth() is
// invoked at module-eval time when the wildcard middleware mounts, and
// it calls getReceiptSecret() which throws on a missing/short secret.
process.env.SIWA_RECEIPT_SECRET ??= 'a'.repeat(32);

const { OpenAPIHono } = await import('@hono/zod-openapi');
const { agentMatchesRoutes, assertAgentWalletMatches } = await import(
  '../src/routes/agents-matches.js'
);
const { errorHandler } = await import('../src/middleware/errorEnvelope.js');

function buildApp() {
  const app = new OpenAPIHono();
  app.route('/', agentMatchesRoutes);
  app.onError(errorHandler);
  return app;
}

test('agent wallet binding rejects a different authenticated SIWA address', () => {
  const configured = '0x0000000000000000000000000000000000000001';
  assert.equal(assertAgentWalletMatches(configured, configured), configured);
  assert.throws(
    () =>
      assertAgentWalletMatches(
        '0x0000000000000000000000000000000000000002',
        configured,
      ),
    (err: unknown) =>
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      err.code === 'AGENT_WALLET_MISMATCH',
  );
});

test('POST /v1/agents/matches/start-solo: anonymous request → 401', async () => {
  const app = buildApp();
  const res = await app.request('/v1/agents/matches/start-solo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game: '2048' }),
  });
  assert.equal(
    res.status,
    401,
    `expected 401 for anonymous call, got ${res.status}: ${await res.text()}`,
  );
});

test('POST /v1/agents/matches/start-solo: SIWA receipt only, no ERC-8128 sig → 401', async () => {
  const app = buildApp();
  const res = await app.request('/v1/agents/matches/start-solo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Shape-valid but unverifiable receipt; importantly, no Signature /
      // Signature-Input / Content-Digest headers. Should be rejected
      // before the handler runs.
      'X-SIWA-Receipt': 'eyJhbGciOiJIUzI1NiJ9.bm9uc2Vuc2U.invalid-hmac',
    },
    body: JSON.stringify({ game: '2048' }),
  });
  assert.equal(
    res.status,
    401,
    `expected 401 when ERC-8128 sig is missing, got ${res.status}: ${await res.text()}`,
  );
});
