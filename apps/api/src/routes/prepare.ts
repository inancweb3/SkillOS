// SkillOS Base plugin v1 — prepare unsigned calldata for permissionless
// tournament prize-pool sponsorship.
//
// Why this exists: external Base-MCP agents (Claude Desktop / ChatGPT / coding
// harness) already hold a wallet via base-mcp but will not install @skillos/mcp.
// This auth-less, read-only endpoint hands them the exact send_calls batch
// ([USDC.approve, SponsorshipModule.sponsorPool]) so any base-mcp agent can
// permissionlessly sponsor a prize pool with one
// send_calls(chain="base-sepolia", calls=[...]) call — no SkillOS-specific MCP
// install required.
//
// It signs NOTHING and holds NO key — it only viem-encodes calldata, mirroring
// packages/mcp/src/tools/fund_pool.ts (the @skillos/mcp prepare_fund_pool tool)
// so the HTTP surface and the MCP surface stay byte-for-byte identical.
//
// Architectural invariant (CLAUDE.md #1/#2): sponsorship lands in the
// segregated prize-pool slot via the SponsorshipModule permissionless path
// (the sanctions oracle is the only on-chain gate); no other entry point funds
// pools. This endpoint never moves money — the agent's own wallet does, on the
// agent's own approval — so it adds no custody or settlement surface.

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { encodeFunctionData } from 'viem';
import {
  CHAIN_ID,
  ERC20_ABI,
  SPONSORSHIP_MODULE_ABI,
  SPONSORSHIP_MODULE_ADDRESS,
  USDC_ADDRESS,
} from '../lib/contracts.js';
import { ApiError } from '../middleware/errorEnvelope.js';
import {
  Bytes32HexSchema,
  ErrorEnvelopeSchema,
  WalletAddressSchema,
} from '../schemas/common.js';

// defaultHook remaps Hono OpenAPI's default 400-on-validation-fail to 422 and
// shapes the payload into the canonical ErrorEnvelope (same convention as
// ratings.ts) so external clients get one error format.
export const prepareRoutes = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'INVALID_PARAMS',
            message: 'Request validation failed',
            details: result.error.issues,
          },
        },
        422,
      );
    }
  },
});

// ─── Pure helpers (extracted for unit-testability) ─────────────────────────

const USDC_DECIMAL_RE = /^[0-9]+(\.[0-9]{1,6})?$/;

/**
 * USDC has 6 decimals on Base. Convert a decimal USD string to atomic units.
 * Mirrors usdcAtoms in @skillos/sdk (packages/sdk/src/contracts.ts) — inlined
 * because apps/api does not depend on @skillos/sdk. Throws on malformed input
 * (defence in depth; the zod query schema already rejects these with a 422).
 */
export function usdcAtoms(amountUsdc: string): bigint {
  const s = amountUsdc.trim();
  if (!USDC_DECIMAL_RE.test(s)) {
    throw new Error(
      `Invalid USDC amount "${s}" — must be a non-negative decimal with ≤6 fractional digits`,
    );
  }
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '000000').slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(padded);
}

export interface PreparedCall {
  /** Target contract address. */
  to: `0x${string}`;
  /** Native value in hex wei. Always 0x0 — sponsorship moves USDC, not ETH. */
  value: '0x0';
  /** ABI-encoded calldata. */
  data: `0x${string}`;
}

export interface SponsorPoolBatch {
  calls: PreparedCall[];
  atoms: bigint;
}

/**
 * Build the [USDC.approve, SponsorshipModule.sponsorPool] two-call batch that
 * permissionlessly sponsors `tournamentId` with `amount` USDC. The two calls
 * MUST execute in order: approve grants the module the USDC pull, then
 * sponsorPool pulls it into the segregated prize pool. Pure — no key, no RPC,
 * only viem ABI encoding (identical to packages/mcp prepare_fund_pool).
 */
export function buildSponsorPoolCalls(params: {
  tournamentId: `0x${string}`;
  amount: string;
}): SponsorPoolBatch {
  const atoms = usdcAtoms(params.amount);
  if (atoms === 0n) {
    throw new ApiError(422, 'INVALID_PARAMS', 'amount must be greater than 0');
  }

  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [SPONSORSHIP_MODULE_ADDRESS, atoms],
  });
  const sponsorData = encodeFunctionData({
    abi: SPONSORSHIP_MODULE_ABI,
    functionName: 'sponsorPool',
    args: [params.tournamentId, atoms],
  });

  return {
    atoms,
    calls: [
      { to: USDC_ADDRESS, value: '0x0', data: approveData },
      { to: SPONSORSHIP_MODULE_ADDRESS, value: '0x0', data: sponsorData },
    ],
  };
}

// ─── schemas ────────────────────────────────────────────────────────────────

const PreparedCallSchema = z
  .object({
    to: z.string().openapi({
      description: 'Target contract address.',
      example: USDC_ADDRESS,
    }),
    value: z.string().openapi({
      description: 'Native value (hex wei). Always 0x0 — sponsorship moves USDC, not ETH.',
      example: '0x0',
    }),
    data: z.string().openapi({
      description: 'ABI-encoded calldata.',
      example: '0x095ea7b3',
    }),
  })
  .openapi('PreparedCall');

const QuerySchema = z.object({
  tournamentId: Bytes32HexSchema,
  amount: z
    .string()
    .regex(USDC_DECIMAL_RE, 'amount must be a non-negative decimal with ≤6 fractional digits')
    .openapi({
      description: 'USDC amount as a decimal string (e.g. "5", "0.5", "12.345"). Six fractional digits = USDC atomic precision.',
      example: '5',
    }),
  from: WalletAddressSchema.optional().openapi({
    description:
      "Optional sponsoring wallet (the agent's base-mcp address). Echoed into the hint; not required to build calldata, which is sender-agnostic.",
  }),
});

const PrepareSponsorPoolResponseSchema = z
  .object({
    action: z.literal('sponsor-pool'),
    chainId: z.number().openapi({ example: 84532 }),
    network: z.literal('base-sepolia'),
    calls: z.array(PreparedCallSchema),
    tournamentId: z.string(),
    amount: z.string(),
    atoms: z.string().openapi({
      description: 'amount in USDC atomic units (6 decimals).',
      example: '5000000',
    }),
    from: z.string().optional(),
    hint: z.string(),
  })
  .openapi('PrepareSponsorPoolResponse');

// ─── GET /v1/prepare/sponsor-pool ───────────────────────────────────────────

const route = createRoute({
  method: 'get',
  path: '/v1/prepare/sponsor-pool',
  summary: 'Prepare send_calls for permissionless prize-pool sponsorship',
  description:
    'Auth-less, read-only. Returns the [USDC.approve, SponsorshipModule.sponsorPool] calldata batch for any external Base-MCP agent to submit via send_calls(chain="base-sepolia", calls=[...]). Signs nothing, holds no key. The two calls MUST execute in order. The sponsorPool call reverts on-chain if the sender is sanctions-listed.',
  tags: ['prepare'],
  request: { query: QuerySchema },
  responses: {
    200: {
      description: 'send_calls-ready calldata batch',
      content: { 'application/json': { schema: PrepareSponsorPoolResponseSchema } },
    },
    422: {
      description: 'Invalid query params',
      content: { 'application/json': { schema: ErrorEnvelopeSchema } },
    },
    500: {
      description: 'Unexpected error',
      content: { 'application/json': { schema: ErrorEnvelopeSchema } },
    },
  },
});

prepareRoutes.openapi(route, (c) => {
  const { tournamentId, amount, from } = c.req.valid('query');
  const { calls, atoms } = buildSponsorPoolCalls({
    tournamentId: tournamentId as `0x${string}`,
    amount,
  });

  return c.json(
    {
      action: 'sponsor-pool' as const,
      chainId: CHAIN_ID,
      network: 'base-sepolia' as const,
      calls,
      tournamentId,
      amount,
      atoms: atoms.toString(),
      ...(from && { from }),
      hint: `Submit via base-mcp send_calls(chain="base-sepolia", calls=[...])${
        from ? ` from ${from}` : ''
      }. Execute the two calls in order: approve grants the SponsorshipModule the USDC pull, then sponsorPool funds the segregated prize pool and mints your SponsorReceiptSBT. Reverts if the sender is sanctions-listed.`,
    },
    200,
  );
});
