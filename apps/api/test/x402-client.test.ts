// X15.6 unit tests — server-side x402 client.
//
// Coverage:
//   - EIP-3009 typed-data layout (buildAuthorization output shape).
//   - Settle round-trip success → returns tx hash + atomic amount.
//   - Facilitator failure → throws X402SettlementError with reason.
//   - Malformed facilitator response → throws X402SettlementError.
//   - Signer address mismatch → throws before any signing happens.
//
// On-chain settlement is NOT exercised here; the smoke test in Phase D
// of the X15.6 sprint covers the live x402.org facilitator round-trip.
//
// Convention: node:test + node:assert/strict, matches games.test.ts.
// Run: npx tsx --test apps/api/test/x402-client.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_MATCH_RETRY_ATOMIC,
  X402SettlementError,
  buildAuthorization,
  settleX402Payment,
  type X402Signer,
} from '../src/lib/x402-client.js';

// A stable agent + receiver pair. The on-chain check (signer.address ===
// args.agentAddress, case-insensitive via getAddress) means the signer
// stub MUST return a checksummed address.
const AGENT_ADDR = '0xefF6386c91a39821Eee187391d0C8f73AbE198b5' as const;
const RECEIVER_ADDR = '0xb9b141b6bE44c07c9D38b2B3dF9eB165C68358Eb' as const;
const FAKE_SIGNATURE =
  '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef1b' as const;
const FAKE_TX_HASH =
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as const;
const FAKE_NONCE =
  '0xabbacafe00000000000000000000000000000000000000000000000000000000' as const;
const FIXED_NOW_MS = 1_700_000_000_000;
const USDC_ADDR = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

function addressTopic(address: string): `0x${string}` {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

function amountData(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function successfulReceipt() {
  return {
    status: 'success',
    logs: [
      {
        address: USDC_ADDR,
        topics: [
          TRANSFER_TOPIC,
          addressTopic(AGENT_ADDR),
          addressTopic(RECEIVER_ADDR),
        ],
        data: amountData(AGENT_MATCH_RETRY_ATOMIC),
      },
    ],
  };
}

interface CapturedSignCall {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

interface CapturedSettleCall {
  payload: unknown;
  requirements: unknown;
}

function makeSigner(opts?: { address?: `0x${string}` }): {
  signer: X402Signer;
  calls: CapturedSignCall[];
} {
  const calls: CapturedSignCall[] = [];
  const signer: X402Signer = {
    address: opts?.address ?? AGENT_ADDR,
    async signTypedData(m) {
      calls.push(m);
      return FAKE_SIGNATURE;
    },
  };
  return { signer, calls };
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('buildAuthorization produces canonical EIP-3009 typed-data', async () => {
  const { signer, calls } = makeSigner();
  const result = await buildAuthorization({
    signer,
    receiver: RECEIVER_ADDR,
    value: AGENT_MATCH_RETRY_ATOMIC,
    validAfter: 0n,
    validBefore: 1_700_000_600n,
    nonce: FAKE_NONCE,
  });

  assert.equal(calls.length, 1, 'signer.signTypedData called exactly once');
  const c = calls[0]!;
  assert.equal(c.primaryType, 'TransferWithAuthorization');

  // EIP-712 domain — USDC on Base Sepolia.
  assert.equal(c.domain.name, 'USDC');
  assert.equal(c.domain.version, '2');
  assert.equal(c.domain.chainId, 84532);
  assert.equal(
    (c.domain.verifyingContract as string).toLowerCase(),
    '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
  );

  // Message fields preserve numeric types for viem.
  assert.equal(c.message.from, AGENT_ADDR);
  assert.equal(c.message.to, RECEIVER_ADDR);
  assert.equal(c.message.value, AGENT_MATCH_RETRY_ATOMIC);
  assert.equal(c.message.validAfter, 0n);
  assert.equal(c.message.validBefore, 1_700_000_600n);
  assert.equal(c.message.nonce, FAKE_NONCE);

  // Types include TransferWithAuthorization with all six fields.
  const types = c.types as { TransferWithAuthorization: { name: string; type: string }[] };
  assert.ok(types.TransferWithAuthorization, 'types include TransferWithAuthorization');
  const fields = types.TransferWithAuthorization.map((f) => f.name).join(',');
  assert.equal(fields, 'from,to,value,validAfter,validBefore,nonce');

  // Authorization output stringifies numerics (facilitator wire format).
  assert.equal(result.authorization.from, AGENT_ADDR);
  assert.equal(result.authorization.to, RECEIVER_ADDR);
  assert.equal(result.authorization.value, '1050000');
  assert.equal(result.authorization.validAfter, '0');
  assert.equal(result.authorization.validBefore, '1700000600');
  assert.equal(result.authorization.nonce, FAKE_NONCE);
  assert.equal(result.signature, FAKE_SIGNATURE);
});

test('settleX402Payment success returns tx hash + atomic amount + settledAt', async () => {
  const { signer } = makeSigner();
  const settleCalls: CapturedSettleCall[] = [];
  const facilitator = {
    async settle(payload: unknown, requirements: unknown) {
      settleCalls.push({ payload, requirements });
      return {
        success: true,
        transaction: FAKE_TX_HASH,
        network: 'eip155:84532',
        amount: '1050000',
      };
    },
  };

  const result = await withEnv(
    { X402_RECEIVER_ADDRESS: RECEIVER_ADDR },
    () =>
      settleX402Payment(
        {
          runId: '11111111-1111-1111-1111-111111111111',
          agentAddress: AGENT_ADDR,
          priorSolo: 2,
        },
        {
          signer,
          facilitator,
          publicClient: {
            async waitForTransactionReceipt() {
              return successfulReceipt();
            },
          },
          now: () => FIXED_NOW_MS,
          randomNonce: () => FAKE_NONCE,
        },
      ),
  );

  assert.equal(result.x402TxHash, FAKE_TX_HASH);
  assert.equal(result.x402AmountAtomic, AGENT_MATCH_RETRY_ATOMIC);
  assert.equal(result.settledAt.getTime(), FIXED_NOW_MS);

  // Inspect what we sent to the facilitator — payload shape is
  // contractually visible.
  assert.equal(settleCalls.length, 1);
  const sent = settleCalls[0]!;
  const payload = sent.payload as {
    x402Version: number;
    accepted: { scheme: string; network: string; amount: string };
    payload: {
      signature: string;
      authorization: { from: string; to: string; value: string; nonce: string };
    };
  };
  assert.equal(payload.x402Version, 2);
  assert.equal(payload.accepted.scheme, 'exact');
  assert.equal(payload.accepted.network, 'eip155:84532');
  assert.equal(payload.accepted.amount, '1050000');
  assert.equal(payload.payload.signature, FAKE_SIGNATURE);
  assert.equal(payload.payload.authorization.from, AGENT_ADDR);
  assert.equal(payload.payload.authorization.to, RECEIVER_ADDR);
  assert.equal(payload.payload.authorization.value, '1050000');
  assert.equal(payload.payload.authorization.nonce, FAKE_NONCE);
});

test('settleX402Payment rejects a reverted facilitator transaction', async () => {
  const { signer } = makeSigner();
  await assert.rejects(
    () =>
      withEnv({ X402_RECEIVER_ADDRESS: RECEIVER_ADDR }, () =>
        settleX402Payment(
          { runId: 'r', agentAddress: AGENT_ADDR, priorSolo: 1 },
          {
            signer,
            facilitator: {
              async settle() {
                return { success: true, transaction: FAKE_TX_HASH };
              },
            },
            publicClient: {
              async waitForTransactionReceipt() {
                return { status: 'reverted', logs: [] };
              },
            },
          },
        ),
      ),
    (err: unknown) => {
      assert.ok(err instanceof X402SettlementError);
      assert.equal((err as X402SettlementError).reason, 'transaction_reverted');
      return true;
    },
  );
});

test('settleX402Payment rejects a receipt without the authorized USDC transfer', async () => {
  const { signer } = makeSigner();
  await assert.rejects(
    () =>
      withEnv({ X402_RECEIVER_ADDRESS: RECEIVER_ADDR }, () =>
        settleX402Payment(
          { runId: 'r', agentAddress: AGENT_ADDR, priorSolo: 1 },
          {
            signer,
            facilitator: {
              async settle() {
                return { success: true, transaction: FAKE_TX_HASH };
              },
            },
            publicClient: {
              async waitForTransactionReceipt() {
                return { status: 'success', logs: [] };
              },
            },
          },
        ),
      ),
    (err: unknown) => {
      assert.ok(err instanceof X402SettlementError);
      assert.equal((err as X402SettlementError).reason, 'transfer_not_found');
      return true;
    },
  );
});

test('settleX402Payment throws X402SettlementError when facilitator rejects', async () => {
  const { signer } = makeSigner();
  const facilitator = {
    async settle() {
      return {
        success: false,
        errorReason: 'insufficient_balance',
        errorMessage: 'from-address balance < value',
      };
    },
  };

  await assert.rejects(
    () =>
      withEnv({ X402_RECEIVER_ADDRESS: RECEIVER_ADDR }, () =>
        settleX402Payment(
          { runId: 'r', agentAddress: AGENT_ADDR, priorSolo: 1 },
          {
            signer,
            facilitator,
            now: () => FIXED_NOW_MS,
            randomNonce: () => FAKE_NONCE,
          },
        ),
      ),
    (err: unknown) => {
      assert.ok(err instanceof X402SettlementError, 'X402SettlementError');
      assert.equal((err as X402SettlementError).reason, 'insufficient_balance');
      assert.match((err as Error).message, /from-address balance/);
      return true;
    },
  );
});

test('settleX402Payment throws on malformed facilitator response (no tx hash)', async () => {
  const { signer } = makeSigner();
  const facilitator = {
    async settle() {
      return { success: true, transaction: 'not-a-hex' };
    },
  };

  await assert.rejects(
    () =>
      withEnv({ X402_RECEIVER_ADDRESS: RECEIVER_ADDR }, () =>
        settleX402Payment(
          { runId: 'r', agentAddress: AGENT_ADDR, priorSolo: 0 },
          {
            signer,
            facilitator,
            now: () => FIXED_NOW_MS,
            randomNonce: () => FAKE_NONCE,
          },
        ),
      ),
    (err: unknown) => {
      assert.ok(err instanceof X402SettlementError);
      assert.equal((err as X402SettlementError).reason, 'malformed_response');
      return true;
    },
  );
});

test('settleX402Payment refuses when signer address ≠ args.agentAddress', async () => {
  // Signer is configured for one address; caller logs another. This is a
  // misconfig that we want to catch loudly instead of silently signing
  // from the wrong wallet.
  const { signer } = makeSigner({
    address: '0x000000000000000000000000000000000000dEaD',
  });
  const facilitator = {
    async settle() {
      throw new Error('facilitator should not be called');
    },
  };

  await assert.rejects(
    () =>
      withEnv({ X402_RECEIVER_ADDRESS: RECEIVER_ADDR }, () =>
        settleX402Payment(
          { runId: 'r', agentAddress: AGENT_ADDR, priorSolo: 0 },
          {
            signer,
            facilitator,
            now: () => FIXED_NOW_MS,
            randomNonce: () => FAKE_NONCE,
          },
        ),
      ),
    (err: unknown) => {
      assert.ok(err instanceof X402SettlementError);
      assert.equal((err as X402SettlementError).reason, 'signer_mismatch');
      return true;
    },
  );
});

test('settleX402Payment fails fast when X402_RECEIVER_ADDRESS is missing', async () => {
  const { signer } = makeSigner();
  await assert.rejects(
    () =>
      withEnv({ X402_RECEIVER_ADDRESS: undefined }, () =>
        settleX402Payment(
          { runId: 'r', agentAddress: AGENT_ADDR, priorSolo: 0 },
          { signer, now: () => FIXED_NOW_MS, randomNonce: () => FAKE_NONCE },
        ),
      ),
    (err: unknown) => {
      assert.match((err as Error).message, /X402_RECEIVER_ADDRESS/);
      return true;
    },
  );
});
