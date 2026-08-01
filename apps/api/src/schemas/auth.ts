import { z } from 'zod';
import { Bytes32HexSchema, WalletAddressSchema } from './common.js';

export const SiwbNonceRequestSchema = z
  .object({
    walletAddress: WalletAddressSchema,
  })
  .openapi('SiwbNonceRequest');

// ─── SIWA (Sign-In With Agent) schemas — Sprint X4 ────────────────────────

// SIWA nonce request takes no wallet binding: the address only appears in
// the signed SIWA message at verify time. We accept an empty body and
// return a wallet-address-agnostic nonce.
export const SiwaNonceRequestSchema = z
  .object({})
  .openapi('SiwaNonceRequest');

export const SiwaNonceResponseSchema = z
  .object({
    nonce: z.string().regex(/^[a-zA-Z0-9]{8,}$/, 'alphanumeric, ≥8 chars').openapi({
      description:
        'Cryptographic random alphanumeric nonce (default 16 hex chars). Single-use; consumed atomically at verify.',
    }),
    issuedAt: z.string().datetime().openapi({
      description: 'ISO-8601, UTC. Equals server-side `now()` at issuance.',
    }),
    expiresAt: z.string().datetime().openapi({
      description: 'ISO-8601, UTC. issuedAt + 5 minutes.',
    }),
  })
  .openapi('SiwaNonceResponse');

export const SiwaVerifyRequestSchema = z
  .object({
    message: z.string().min(20).openapi({
      description:
        'Full SIWA-formatted message (EIP-191). Contains agentId, agentRegistry (CAIP-10), chainId, nonce, issuedAt, etc.',
    }),
    signature: z
      .string()
      .regex(/^0x[a-fA-F0-9]+$/, 'must be 0x-prefixed hex')
      .openapi({
        description:
          'EIP-191 personal_sign by the agent. Verified via client.verifyMessage — supports EOA, ERC-1271 smart wallets, and ERC-6492 wrappers.',
      }),
  })
  .openapi('SiwaVerifyRequest');

export const SiwaVerifyResponseSchema = z
  .object({
    receipt: z.string().openapi({
      description:
        'HMAC-signed receipt (base64url(json).base64url(hmac-sha256)). Pass as `X-SIWA-Receipt` header on subsequent agent requests alongside ERC-8128 per-request signature.',
    }),
    expiresAt: z.string().datetime().openapi({
      description: 'ISO-8601, UTC. Receipt expiration (24h TTL).',
    }),
    address: WalletAddressSchema,
    agentId: z.number().int().nonnegative().openapi({
      description: 'ERC-8004 AgentIdentity tokenId owned by the address.',
    }),
    signerType: z.enum(['eoa', 'sca']).openapi({
      description:
        '`eoa` = externally-owned account, `sca` = smart contract account (ERC-1271).',
    }),
    builderCode: z
      .string()
      .regex(/^bc_[a-z0-9]{8}$/)
      .optional()
      .openapi({
        description:
          'Agent Builder Code (bc_xxxxxxxx) returned by api.base.dev/v1/agents/builder-codes. Fetched server-side on verify success (Sprint X3 Q3a-refined trigger). Cached for receipt lifetime in caller.',
      }),
  })
  .openapi('SiwaVerifyResponse');

export const SiwbNonceResponseSchema = z
  .object({
    nonce: z.string().regex(/^[a-f0-9]{32}$/, 'lowercase hex, 32 chars').openapi({
      description:
        'Cryptographic random, 32 lowercase hex chars. Matches Base SIWE nonce regex `\\w{32}$`.',
    }),
    issuedAt: z.string().datetime().openapi({
      description: 'ISO-8601, UTC. Equals server-side `now()` at issuance.',
    }),
    expiresAt: z.string().datetime().openapi({
      description: 'ISO-8601, UTC. issuedAt + 5 minutes.',
    }),
  })
  .openapi('SiwbNonceResponse');

export const SiwbVerifyRequestSchema = z
  .object({
    message: z.string().min(20).openapi({
      description: 'Full SIWE-formatted message (EIP-4361). Server parses + validates.',
    }),
    signature: z
      .string()
      .regex(/^0x[a-fA-F0-9]+$/, 'must be 0x-prefixed hex')
      .openapi({
        description:
          'EIP-191 personal_sign signature. Base Account smart wallets wrap with ERC-6492; viem.verifyMessage handles transparently.',
      }),
    walletAddress: WalletAddressSchema.openapi({
      description: 'Must equal the address inside the SIWE message body.',
    }),
  })
  .openapi('SiwbVerifyRequest');

export const SiwbVerifyResponseSchema = z
  .object({
    token: z.string().openapi({
      description:
        'Bearer JWT (HS256, 24h TTL). Pass as `Authorization: Bearer <token>` to write endpoints.',
    }),
    expiresAt: z.string().datetime().openapi({
      description: 'ISO-8601, UTC. Token expiration.',
    }),
    sessionId: z.string().uuid(),
  })
  .openapi('SiwbVerifyResponse');

// Score-submit shapes for /v1/scores POST.

export const ScoreSubmitRequestSchema = z
  .object({
    tournamentId: Bytes32HexSchema,
    score: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .openapi({
        description:
          'Raw player score. T0 tier: server signs as-is, no plausibility validation.',
      }),
    soloRunId: Bytes32HexSchema.optional().openapi({
      description: 'Client-supplied bytes32; if omitted, server generates random.',
    }),
    matchCountDelta: z
      .number()
      .int()
      .min(0)
      .default(1)
      .openapi({
        description:
          'Match count increment (capped at MATCH_COUNT_CAP=10 on-chain). 1 by default.',
      }),
    tier: z
      .enum(['T0', 'T1', 'T2', 'T3'])
      .default('T0')
      .openapi({
        description:
          'Quality tier. T0 is signature-only (no plausibility, no DB persistence). T1+ is rejected until replay or equivalent plausibility verification is implemented.',
      }),
  })
  .openapi('ScoreSubmitRequest');

export const ScoreSubmitResponseSchema = z
  .object({
    txHash: Bytes32HexSchema.openapi({
      description: 'On-chain submitSoloScore broadcast hash. Fire-and-forget — not waited for inclusion.',
    }),
    soloRunId: Bytes32HexSchema,
    submittedAt: z.string().datetime(),
    tier: z.literal('T0').openapi({
      description: 'Confirms the T0 trust tier. Echoed in X-SkillOS-Tier header.',
    }),
    isAgent: z.boolean().optional().openapi({
      description:
        'Reserved for a future verified T1+ submission pipeline.',
    }),
    classTag: z.enum(['human', 'agent']).optional().openapi({
      description:
        'Reserved for a future verified T1+ submission pipeline.',
    }),
  })
  .openapi('ScoreSubmitResponse');
