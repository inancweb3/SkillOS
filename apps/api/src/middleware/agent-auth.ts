// Agent-write middleware: requires a valid SIWA receipt AND a fresh
// ERC-8128 per-request signature. Used on /v1/agents/* write endpoints
// (POST /v1/agents/scores, PATCH /v1/agents/profile).
//
// Built on @buildersgarden/siwa/hono.siwaMiddleware, which:
//   - reads X-SIWA-Receipt + Signature + Signature-Input + Content-Digest headers
//   - verifies receipt HMAC against SIWA_RECEIPT_SECRET
//   - verifies ERC-8128 request signature against the receipt-derived public key
//   - sets c.var.agent = { address, agentId, signerType?, ... } on success
//   - returns 401 on failure
//
// We expose the verified agent via c.var.agent (typed below for downstream
// route handlers).
//
// Read endpoints don't use this middleware — Q4 lock scoped ERC-8128
// enforcement to writes only. No agent read endpoints exist in X4; future
// sprints can add a lighter requireSiwaReceipt() middleware that verifies
// only the receipt (no per-request sig).

import type { MiddlewareHandler } from 'hono';
import { siwaMiddleware } from '@buildersgarden/siwa/hono';
import { getReceiptSecret } from '../lib/agent-receipt.js';
import type { PublicClient } from 'viem';
import { getPublicClient } from '../lib/viem.js';

declare module 'hono' {
  interface ContextVariableMap {
    agent: {
      address: string;
      agentId: number;
      agentRegistry?: string;
      chainId?: number;
      signerType?: 'eoa' | 'sca';
    };
  }
}

export const requireSiwaAuth = (): MiddlewareHandler =>
  siwaMiddleware({
    receiptSecret: getReceiptSecret(),
    // A valid HMAC receipt alone is not enough for write access. Re-check the
    // registry ownership so revoked/transferred agents cannot keep spending.
    verifyOnchain: true,
    // The library's siwaMiddleware accepts an explicit publicClient. Pass our
    // Base-narrowed client through the same structural cast used in lib/siwa.ts.
    publicClient: getPublicClient() as unknown as PublicClient,
  });
