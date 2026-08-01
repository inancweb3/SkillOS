// X15.6 — Server-side x402 client (ADR 0003 D2 + D5).
//
// The agent (AGENT_PRIVATE_KEY) pays its own bill by signing an
// EIP-3009 transferWithAuthorization for USDC and pushing it through the
// x402.org facilitator. The facilitator submits on-chain so the agent
// doesn't pay gas on this leg; USDC is pulled from the agent wallet to
// X402_RECEIVER_ADDRESS in the same transaction.
//
// Why this lives outside the paymentMiddleware route map (see x402.ts
// comment near /v1/data/*): the spectator UI POSTs the route from a
// browser and expects 202 + runId. A 402 challenge there would break
// the apex /watch/[runId] flow. The agent — not the spectator — is the
// economic payer, so satisfaction has to happen inside the handler.
//
// Why we hand-roll the EIP-712 payload rather than going through
// x402Client.createPaymentPayload: testability. The lower level is two
// calls (sign + settle) instead of a client/scheme/policy pipeline;
// unit tests inject a stub facilitator and a stub signer without
// instantiating the whole core/client/server graph.
//
// Idempotency: USDC's authorization map keys on (from, nonce), so a
// fresh random nonce per call makes replay impossible. A stuck attempt
// followed by a retry from the caller yields TWO settlements with
// distinct nonces; both will go through and BOTH are recorded as
// separate x15_payment_attempts rows (attempt_number distinguishes).
// The caller — not this module — owns the higher-level dedup decision.

import { randomBytes } from 'node:crypto';
import { type Address, type Hex, getAddress } from 'viem';

import { HTTPFacilitatorClient } from '@x402/core/server';

import { CHAIN_ID, USDC_ADDRESS } from './contracts-vendored/addresses.js';
import { getAgentAccount } from './contracts-vendored/attestation.js';
import { getPublicClient } from './viem.js';

// $1.05 atomic — kept in lock-step with X402_PRICES.agentMatchRetry in
// x402.ts. USDC has 6 decimals on Base; 1_050_000 = $1.05.
export const AGENT_MATCH_RETRY_ATOMIC = 1_050_000n;

const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';
const BASE_SEPOLIA_CAIP2 = 'eip155:84532' as const;

// USDC on Base Sepolia EIP-712 domain — version "2" not "1". Confirmed
// against @x402/evm DEFAULT_STABLECOINS at install time.
const USDC_DOMAIN_NAME = 'USDC';
const USDC_DOMAIN_VERSION = '2';
const USDC_DECIMALS = 6;

// 10-minute facilitator window. validAfter is rolled back 600s the same
// way @x402/evm's createEIP3009Payload does, so a small clock skew
// between this server and the facilitator's node doesn't reject a
// freshly-signed authorization.
const AUTHORIZATION_TTL_SECONDS = 600;
const CLOCK_SKEW_BACKDATE_SECONDS = 600;

// EIP-712 typed-data shape for USDC.transferWithAuthorization. Source
// of truth is @x402/evm's `authorizationTypes`; duplicated here so the
// module compiles standalone (test isolation) and is one fewer import
// the bundler has to chase. If x402-evm rev'd the shape we'd notice via
// a smoke-test settlement reverting with InvalidSignature on-chain.
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

const isHexAddress = (v: string): v is `0x${string}` =>
  /^0x[a-fA-F0-9]{40}$/.test(v);

function readReceiver(): Address {
  const raw = process.env.X402_RECEIVER_ADDRESS?.trim();
  if (!raw || !isHexAddress(raw)) {
    throw new Error(
      'X402_RECEIVER_ADDRESS is not set or invalid (must be 0x-prefixed 40-char hex)',
    );
  }
  return getAddress(raw);
}

function readFacilitatorUrl(): string {
  return process.env.X402_FACILITATOR_URL?.trim() || DEFAULT_FACILITATOR_URL;
}

export interface SettleX402PaymentArgs {
  /** duel_runs.id — passed through for log correlation. Not used by the protocol. */
  runId: string;
  /** Agent EOA. Must equal the configured agent signer's address. */
  agentAddress: Address;
  /**
   * On-chain submission count at the time of this request. Passed through
   * for log correlation with x15_payment_attempts.prior_solo; not consumed
   * by the protocol (x402 is contract-blind).
   */
  priorSolo: number;
}

export interface SettleX402PaymentResult {
  x402TxHash: Hex;
  /** Atomic USDC units settled. Equals AGENT_MATCH_RETRY_ATOMIC for the
   *  exact scheme; preserved as a return field so the caller can record
   *  the actually-settled amount rather than re-reading the constant. */
  x402AmountAtomic: bigint;
  settledAt: Date;
}

// Minimal signer surface — narrows the viem PrivateKeyAccount type to
// exactly what we use so tests can pass a small stub.
export interface X402Signer {
  readonly address: Address;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

// Mirrors the @x402/core SettleResponse shape (whichever fields we
// actually read). Inlined to avoid bleeding the core type into this
// module's signature, since the test stub doesn't construct a real one.
interface FacilitatorSettleResponse {
  success: boolean;
  transaction?: string;
  errorReason?: string;
  errorMessage?: string;
  network?: string;
  amount?: string;
}

interface FacilitatorClient {
  settle(payload: unknown, requirements: unknown): Promise<FacilitatorSettleResponse>;
}

interface X402ReceiptClient {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{
    status: string;
    logs: readonly {
      address: Address;
      topics: readonly Hex[];
      data: Hex;
    }[];
  }>;
}

export interface SettleX402PaymentDeps {
  facilitator?: FacilitatorClient;
  signer?: X402Signer;
  publicClient?: X402ReceiptClient;
  /** Override for tests; production reads Date.now(). */
  now?: () => number;
  /** Override for tests; production uses node:crypto randomBytes. */
  randomNonce?: () => Hex;
}

export class X402SettlementError extends Error {
  readonly reason: string;
  readonly facilitatorResponse?: FacilitatorSettleResponse;
  constructor(
    reason: string,
    message: string,
    facilitatorResponse?: FacilitatorSettleResponse,
  ) {
    super(`x402 settlement failed (${reason}): ${message}`);
    this.name = 'X402SettlementError';
    this.reason = reason;
    this.facilitatorResponse = facilitatorResponse;
  }
}

let cachedFacilitator: FacilitatorClient | null = null;

function getDefaultFacilitator(): FacilitatorClient {
  if (!cachedFacilitator) {
    cachedFacilitator = new HTTPFacilitatorClient({ url: readFacilitatorUrl() });
  }
  return cachedFacilitator;
}

/**
 * Build the EIP-3009 authorization + signature. Exported separately so
 * the unit test can assert the typed-data layout independently of the
 * settle round-trip.
 */
export async function buildAuthorization(params: {
  signer: X402Signer;
  receiver: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}): Promise<{
  authorization: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
  signature: Hex;
}> {
  const { signer, receiver, value, validAfter, validBefore, nonce } = params;
  const from = getAddress(signer.address);
  const to = getAddress(receiver);

  const domain = {
    name: USDC_DOMAIN_NAME,
    version: USDC_DOMAIN_VERSION,
    chainId: CHAIN_ID,
    verifyingContract: USDC_ADDRESS,
  };

  const signature = (await signer.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as Record<string, unknown>,
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  })) as Hex;

  return {
    authorization: {
      from,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
    signature,
  };
}

/**
 * Settle a $1.05 USDC payment from the agent wallet to the x402 receiver,
 * via the x402 facilitator. Throws X402SettlementError if the facilitator
 * reports failure or the response is malformed; throws the underlying
 * fetch/network error otherwise.
 *
 * The caller is responsible for writing the x15_payment_attempts row;
 * this function only returns the data needed to update that row.
 */
export async function settleX402Payment(
  args: SettleX402PaymentArgs,
  deps: SettleX402PaymentDeps = {},
): Promise<SettleX402PaymentResult> {
  const receiver = readReceiver();
  const signer = deps.signer ?? getAgentAccount();

  // Defensive: surface a config mismatch as a clear error rather than
  // signing a payment from one wallet that the caller logged as another.
  if (getAddress(signer.address) !== getAddress(args.agentAddress)) {
    throw new X402SettlementError(
      'signer_mismatch',
      `agent address mismatch: signer=${signer.address} args=${args.agentAddress}`,
    );
  }

  const now = (deps.now ?? Date.now)();
  const nowSec = Math.floor(now / 1000);
  const validAfter = BigInt(nowSec - CLOCK_SKEW_BACKDATE_SECONDS);
  const validBefore = BigInt(nowSec + AUTHORIZATION_TTL_SECONDS);
  const value = AGENT_MATCH_RETRY_ATOMIC;
  const nonce = (deps.randomNonce ?? defaultNonce)();

  const { authorization, signature } = await buildAuthorization({
    signer,
    receiver,
    value,
    validAfter,
    validBefore,
    nonce,
  });

  const paymentRequirements = {
    scheme: 'exact',
    network: BASE_SEPOLIA_CAIP2,
    asset: USDC_ADDRESS,
    amount: value.toString(),
    payTo: receiver,
    maxTimeoutSeconds: AUTHORIZATION_TTL_SECONDS,
    extra: {
      name: USDC_DOMAIN_NAME,
      version: USDC_DOMAIN_VERSION,
      decimals: USDC_DECIMALS,
    },
  };

  const paymentPayload = {
    x402Version: 2,
    accepted: paymentRequirements,
    payload: {
      signature,
      authorization,
    },
  };

  const facilitator = deps.facilitator ?? getDefaultFacilitator();
  const response = await facilitator.settle(paymentPayload, paymentRequirements);

  if (!response.success) {
    throw new X402SettlementError(
      response.errorReason ?? 'facilitator_rejected',
      response.errorMessage ?? 'facilitator returned success=false',
      response,
    );
  }

  const txHash = response.transaction;
  if (!txHash || typeof txHash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(txHash)) {
    throw new X402SettlementError(
      'malformed_response',
      `facilitator returned non-hex transaction: ${String(txHash).slice(0, 80)}`,
      response,
    );
  }

  // The facilitator response is advisory. Do not mark a payment settled
  // until Base confirms a successful receipt containing the exact USDC
  // Transfer(from=agent, to=receiver, value=$1.05) we authorized.
  const publicClient =
    deps.publicClient ?? (getPublicClient() as unknown as X402ReceiptClient);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash as Hex,
  });
  if (receipt.status !== 'success') {
    throw new X402SettlementError(
      'transaction_reverted',
      `facilitator transaction ${txHash} did not succeed on-chain`,
      response,
    );
  }

  if (!hasExpectedUsdcTransfer(receipt.logs, signer.address, receiver, value)) {
    throw new X402SettlementError(
      'transfer_not_found',
      'confirmed transaction did not contain the expected USDC Transfer',
      response,
    );
  }

  return {
    x402TxHash: txHash as Hex,
    x402AmountAtomic: value,
    settledAt: new Date(now),
  };
}

const TRANSFER_EVENT_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function hasExpectedUsdcTransfer(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  from: Address,
  to: Address,
  value: bigint,
): boolean {
  return logs.some((log) => {
    if (getAddress(log.address) !== getAddress(USDC_ADDRESS)) return false;
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC) {
      return false;
    }
    try {
      const loggedFrom = getAddress(`0x${log.topics[1]!.slice(-40)}`);
      const loggedTo = getAddress(`0x${log.topics[2]!.slice(-40)}`);
      return (
        loggedFrom === getAddress(from) &&
        loggedTo === getAddress(to) &&
        BigInt(log.data) === value
      );
    } catch {
      return false;
    }
  });
}

function defaultNonce(): Hex {
  return `0x${randomBytes(32).toString('hex')}` as Hex;
}
