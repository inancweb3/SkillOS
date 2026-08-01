// Agent client — vanilla TypeScript surface for AI agents calling SkillOS.
//
// Use case: a Node script, edge function, or agent runner (e.g. Claude
// agent loop) that holds an ERC-8004 agent identity and submits scores or
// updates profile via the SkillOS API.
//
// Flow:
//   1. Caller creates a SiwaSigner (private key, viem wallet, Circle, etc.)
//      via one of @buildersgarden/siwa's factory functions.
//   2. createSkillOSAgentClient({ env, agentId, agentRegistry, signer })
//   3. await client.signIn() — runs full SIWA handshake, stores receipt.
//   4. await client.scores.submit({...}) / client.profile.patch({...}) —
//      each call automatically attaches ERC-8128 signature + receipt
//      header.
//
// Browser/React consumers use useSkillOSAgent from '@skillos/sdk/react'.

import type { Signer as SiwaSigner } from '@buildersgarden/siwa/signer';
import { signRequest } from '@slicekit/erc8128';
import { SkillOSApiError } from './vanilla.js';

export type SkillOSEnv = 'testnet' | 'mainnet';

const ENV_BASE_URL: Record<SkillOSEnv, string> = {
  testnet: 'https://api.skillos.network',
  mainnet: 'https://api.skillos.network',
};

const CHAIN_ID_BY_ENV: Record<SkillOSEnv, number> = {
  testnet: 84532,
  mainnet: 8453,
};

const REGISTRY_BY_ENV: Record<SkillOSEnv, `0x${string}`> = {
  testnet: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  mainnet: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
};

export interface SkillOSAgentClientConfig {
  env: SkillOSEnv;
  agentId: number;
  signer: SiwaSigner;
  /** Override the SIWA domain. Defaults to 'skillos.network' — must match server SIWE_DOMAIN env. */
  domain?: string;
  /** Override the base API URL (e.g., for local dev). */
  baseUrl?: string;
  /** Override the ERC-8004 registry address. Defaults to canonical per `env`. */
  agentRegistry?: `0x${string}`;
}

export interface SignInResult {
  address: `0x${string}`;
  agentId: number;
  receipt: string;
  expiresAt: number; // unix ms
  builderCode?: string;
}

export interface AgentScoreSubmitInput {
  tournamentId: `0x${string}`;
  score: number;
  soloRunId?: `0x${string}`;
  matchCountDelta?: number;
  tier?: 'T0' | 'T1' | 'T2' | 'T3';
}

export interface AgentScoreSubmitResult {
  txHash: `0x${string}`;
  soloRunId: `0x${string}`;
  submittedAt: string;
  tier: 'T0';
  agentAddress: `0x${string}`;
  agentId: number;
}

export interface AgentProfilePatchInput {
  displayName?: string;
  preferences?: Record<string, unknown>;
}

export interface SkillOSAgentClient {
  signIn(): Promise<SignInResult>;
  getReceipt(): { receipt: string; expiresAt: number; address: `0x${string}` } | null;
  setReceipt(input: { receipt: string; expiresAt: number; address: `0x${string}` }): void;
  scores: {
    submit(input: AgentScoreSubmitInput): Promise<AgentScoreSubmitResult>;
  };
  profile: {
    patch(input: AgentProfilePatchInput): Promise<unknown>;
  };
}

export function createSkillOSAgentClient(
  config: SkillOSAgentClientConfig,
): SkillOSAgentClient {
  const baseUrl = config.baseUrl ?? ENV_BASE_URL[config.env];
  const chainId = CHAIN_ID_BY_ENV[config.env];
  const registry = config.agentRegistry ?? REGISTRY_BY_ENV[config.env];
  const agentRegistry = `eip155:${chainId}:${registry}`;
  const domain = config.domain ?? 'skillos.network';
  const uri = `https://${domain}/v1/auth/siwa`;

  let cachedReceipt: { receipt: string; expiresAt: number; address: `0x${string}` } | null = null;

  async function signIn(): Promise<SignInResult> {
    const nonceRes = await fetch(`${baseUrl}/v1/auth/siwa/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!nonceRes.ok) throw await toApiError(nonceRes);
    const { nonce } = (await nonceRes.json()) as { nonce: string };

    const { message, signature } = await signSiwaMessage(
      {
        domain,
        uri,
        agentId: config.agentId,
        agentRegistry,
        chainId,
        nonce,
        issuedAt: new Date().toISOString(),
      },
      config.signer,
    );

    const verifyRes = await fetch(`${baseUrl}/v1/auth/siwa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, signature }),
    });
    if (!verifyRes.ok) throw await toApiError(verifyRes);
    const body = (await verifyRes.json()) as {
      receipt: string;
      expiresAt: string;
      address: `0x${string}`;
      agentId: number;
      signerType?: 'eoa' | 'sca';
      builderCode?: string;
    };

    cachedReceipt = {
      receipt: body.receipt,
      expiresAt: Date.parse(body.expiresAt),
      address: body.address,
    };
    return {
      address: body.address,
      agentId: body.agentId,
      receipt: body.receipt,
      expiresAt: cachedReceipt.expiresAt,
      ...(body.builderCode ? { builderCode: body.builderCode } : {}),
    };
  }

  async function signedFetch(path: string, init: { method: string; body: unknown }): Promise<Response> {
    if (!cachedReceipt) {
      throw new SkillOSApiError(401, 'NOT_SIGNED_IN', 'Call agent.signIn() before authenticated requests');
    }
    const url = `${baseUrl}${path}`;
    const body = JSON.stringify(init.body);
    const baseRequest = new Request(url, {
      method: init.method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const signed = await signAuthenticatedRequest(
      baseRequest,
      cachedReceipt.receipt,
      config.signer,
      chainId,
    );
    return fetch(signed);
  }

  return {
    signIn,
    getReceipt: () => cachedReceipt,
    setReceipt: (r) => {
      cachedReceipt = r;
    },
    scores: {
      async submit(input) {
        const res = await signedFetch('/v1/agents/scores', { method: 'POST', body: input });
        if (!res.ok) throw await toApiError(res);
        return (await res.json()) as AgentScoreSubmitResult;
      },
    },
    profile: {
      async patch(input) {
        const res = await signedFetch('/v1/agents/profile', { method: 'PATCH', body: input });
        if (!res.ok) throw await toApiError(res);
        return res.json();
      },
    },
  };
}

/**
 * Browser-safe SIWA client subset. The upstream convenience entry also
 * imports server-only receipt/captcha helpers backed by node:crypto; pulling
 * it into the React SDK made otherwise client-only bundles fail at runtime.
 */
async function signSiwaMessage(
  fields: {
    domain: string;
    uri: string;
    agentId: number;
    agentRegistry: string;
    chainId: number;
    nonce: string;
    issuedAt: string;
  },
  signer: SiwaSigner,
): Promise<{ message: string; signature: string }> {
  const address = await signer.getAddress();
  const message = [
    `${fields.domain} wants you to sign in with your Agent account:`,
    address,
    '',
    '',
    `URI: ${fields.uri}`,
    'Version: 1',
    `Agent ID: ${fields.agentId}`,
    `Agent Registry: ${fields.agentRegistry}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  ].join('\n');
  return { message, signature: await signer.signMessage(message) };
}

async function signAuthenticatedRequest(
  request: Request,
  receipt: string,
  signer: SiwaSigner,
  chainId: number,
): Promise<Request> {
  const headers = new Headers(request.headers);
  headers.set('X-SIWA-Receipt', receipt);
  const withReceipt = new Request(request, { headers });
  const address = await signer.getAddress();
  const httpSigner = {
    address,
    chainId,
    signMessage: async (message: Uint8Array) => {
      const raw = `0x${Array.from(message, (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('')}` as `0x${string}`;
      return signer.signRawMessage
        ? signer.signRawMessage(raw)
        : signer.signMessage(raw);
    },
  };
  return signRequest(withReceipt, httpSigner, {
    components: ['X-SIWA-Receipt'],
  });
}

async function toApiError(res: Response): Promise<SkillOSApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new SkillOSApiError(res.status, 'UNKNOWN', `HTTP ${res.status}`);
  }
  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    body.error &&
    typeof body.error === 'object' &&
    'code' in body.error &&
    typeof body.error.code === 'string'
  ) {
    const env = body.error as { code: string; message?: string; details?: unknown };
    return new SkillOSApiError(res.status, env.code, env.message ?? `HTTP ${res.status}`, env.details);
  }
  return new SkillOSApiError(res.status, 'UNKNOWN', `HTTP ${res.status}`);
}
