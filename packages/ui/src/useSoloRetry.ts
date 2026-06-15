"use client";

// ───────────────────────────────────────────────────────────────────────────
// useSoloRetry — pay-then-play state machine for solo tournament submissions.
//
// Replaces the legacy "play first, see score, then optionally pay" pattern
// with "pay upfront, play unconditionally, submit unconditionally". Closes
// the cherry-pick exploit where a user could play, see a low score, and
// dismiss the payment prompt — submitting only the high scores while still
// receiving free retries via abandonment.
//
// State machine:
//
//   idle
//     │
//     │ handlePlayClick()
//     ▼
//   ┌──────────────────────────────────────────┐
//   │ eligibility.nextPaidRetry === false?     │
//   ▼ yes (free)                               ▼ no (paid)
//   playing                                   awaiting-payment
//                                              │ wallet popup
//                                              ▼
//                                            paying  (approve, then chargeRetryFee)
//                                              │ tx success → write localStorage
//                                              ▼
//                                            playing
//
//   playing
//     │ handleGameOver(score)
//     ▼
//   submitting
//     │ POST /api/tournaments/[id]/solo
//     ├─ 200            → submitted     (clear localStorage)
//     ├─ 402            → error         (unexpected — surface for admin)
//     ├─ network failure → submission-queued (keep localStorage; replay next mount)
//     └─ other          → error
//
// localStorage scheme (per-tournament, same-device only):
//
//   key:   skillos:pendingSubmit:{tournamentId}
//   value: {
//     feeTxHash:        Hex | null,    // null on free path
//     score:            number,        // 0 between pay and game-over
//     durationSeconds:  number,
//     timestamp:        number,        // Date.now() at last write
//     gameSlug:         string,        // guard against cross-game replays
//   }
//
//   Cleared on:
//     • successful submit (200)
//     • mount when tournament's endsAt has passed (stale buffer, abandoned)
//     • reset()
//
//   Read on mount: if score > 0 (game completed but submit failed/never sent)
//   AND tournament still open AND gameSlug matches, automatically replay the
//   submit. This is the safety net for "user paid, played, network died
//   before submit landed."
//
//   NOT replayed: score === 0 (paid but never played to completion). That's
//   an abandoned credit; Phase 2 resume UX will surface those as "you have
//   an unconsumed paid retry — play now?" pending a server-side
//   pending_paid_runs table.
//
// Cross-device replay is NOT supported — localStorage is local. A user who
// pays on phone and tries to submit from desktop loses the buffer. Phase 2
// could move the buffer to a server-side pending_paid_runs table.
//
// Smart Wallet + EIP-5792 batched paymaster path is INTENTIONALLY NOT
// implemented here — see Phase 2 backlog. The prior bundler-drop bug stuck
// the UI mid-payment in a way that pay-then-play makes more visible. Stick
// with the legacy useWriteContract 2-tx path (USDC.approve, then
// chargeRetryFee) until the bundler issue is diagnosed.
//
// Popup-blocker awareness (Chrome default settings):
//
//   The 2-tx chain fires popup #1 (approve) inside the click handler —
//   user-gesture context, always allowed. Popup #2 (chargeRetryFee) fires
//   from the auto-chain useEffect AFTER the approve receipt mines, by
//   which time the user-gesture window has closed. Chrome can silently
//   suppress popup #2; the hook then sits in status="paying" forever.
//
//   We do NOT probe popup state with a window.open test inside
//   handlePlayClick: the probe runs in user-gesture context and will
//   report "allowed" even when popup #2 will later be blocked, so it
//   can't see the bug we want to surface, and risks false positives in
//   fringe browsers. Instead, the consuming page renders a <PopupHint>
//   below the Pay button and inside the "paying" panel — preventive
//   copy that tells users to allow popups for the site, which is the
//   actual remediation regardless of detection result.
// ───────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { type Hex, maxUint256 } from "viem";
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import {
  ERC20_ABI,
  RETRY_FEE,
  TOURNAMENT_POOL_ABI,
  TOURNAMENT_POOL_V2_ADDRESS,
  USDC_ADDRESS,
} from "@skillos/contracts";
import { useSkillOSDataSuffix } from "@skillos/sdk/react";
import { parseWalletError } from "./utils";
import { apiUrl } from "./apiUrl";
import {
  EXTENSION_PROFILE_HEADER,
  type ExtensionProfile,
} from "./extension-whitelist";

// ─── public types ─────────────────────────────────────────────────────────

export type UseSoloRetryStatus =
  | "idle"
  | "checking-eligibility"
  | "awaiting-payment"
  | "paying"
  | "playing"
  | "submitting"
  | "submitted"
  | "submission-queued"
  | "error";

export interface SoloEligibility {
  walletAddress: string;
  priorSoloRuns: number;
  nextPaidRetry: boolean;
  /** RETRY_FEE atoms as decimal string ("1000000" = 1 USDC) or "0" on free. */
  currentFeeOwed: string;
}

export interface SoloSubmitResponse {
  submitted: boolean;
  soloRunId: string;
  rank: number;
  bestScore: number;
  matchCount: number;
  isPaidRetry: boolean;
  txHash: string | null;
}

export interface UseSoloRetryParams {
  /** v2_tournaments.id — null while parent is still loading the active tournament. */
  tournamentId: string | null;
  /** v2_tournaments.on_chain_id — needed for chargeRetryFee args. */
  tournamentOnChainId: Hex | null;
  /** "2048" | "wordle" | … — guards localStorage replays against cross-game pollution. */
  gameSlug: string;
  /** From /api/tournaments?address= response. null while parent is still loading. */
  eligibility: SoloEligibility | null;
  /** Tournament endsAt (ISO 8601) — used to discard stale localStorage replays. */
  tournamentEndsAt: string | null;
  /** Optional callback fired after a successful submit, with the response payload. */
  onSubmitted?: (result: SoloSubmitResponse) => void;
  /**
   * X14.1 — extension whitelist profile (from `evaluateExtensionProfile`).
   * When `enforced && detected !== null`, the submit fetch carries
   * `X-Extension-Profile: <detected>` so the server can emit the
   * `x14_1_extension_profile` audit event. Log-only — never affects the
   * submit outcome.
   */
  extensionProfile?: ExtensionProfile;
}

export interface UseSoloRetryReturn {
  status: UseSoloRetryStatus;
  error: string | null;
  liveScore: number;
  finalScore: number | null;
  result: SoloSubmitResponse | null;
  eligibility: SoloEligibility | null;
  /** True iff status === "playing"; convenience for `{canPlay && <Game/>}`. */
  canPlay: boolean;
  /** Wallet/network operation in flight — disable buttons. */
  walletBusy: boolean;
  handlePlayClick: () => void;
  /**
   * X20.0a — `moves` is the per-game move count (2048 swipes, wordle
   * guesses, sudoku placements, …). Forwarded to the API for AntiCheat
   * F0 in X20.0b; absent in legacy callers is OK (server stores NULL).
   */
  handleGameOver: (
    score: number,
    durationSeconds?: number,
    moves?: number,
  ) => void;
  setLiveScore: (score: number) => void;
  reset: () => void;
}

// ─── localStorage helpers ─────────────────────────────────────────────────

interface PendingSubmit {
  feeTxHash: Hex | null;
  score: number;
  durationSeconds: number;
  /**
   * X20.0a — captured at game-over from each game's local counter
   * (2048 swipes, wordle guesses, …). null when the buffered run pre-dates
   * X20.0a instrumentation OR when the game component doesn't pass moves.
   * Replayed verbatim on re-submit; absent in body = server stores NULL.
   */
  moves: number | null;
  timestamp: number;
  gameSlug: string;
}

const PENDING_PREFIX = "skillos:pendingSubmit:";
// TODO(post-rebrand): remove LEGACY_PREFIX read-fallback after
// 2026-06-01 (one release cycle from rebrand merge).
const LEGACY_PREFIX = "skillbase:pendingSubmit:";

function pendingKey(tournamentId: string): string {
  return `${PENDING_PREFIX}${tournamentId}`;
}

function readPending(tournamentId: string): PendingSubmit | null {
  if (typeof window === "undefined") return null;
  try {
    const newKey = pendingKey(tournamentId);
    let raw = window.localStorage.getItem(newKey);
    if (!raw) {
      // Migrate-on-read from legacy key (rebrand cutover).
      const legacyKey = `${LEGACY_PREFIX}${tournamentId}`;
      raw = window.localStorage.getItem(legacyKey);
      if (raw) {
        window.localStorage.setItem(newKey, raw);
        window.localStorage.removeItem(legacyKey);
      }
    }
    if (!raw) return null;
    return JSON.parse(raw) as PendingSubmit;
  } catch {
    return null;
  }
}

function writePending(tournamentId: string, value: PendingSubmit): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(pendingKey(tournamentId), JSON.stringify(value));
  } catch {
    // Quota exceeded / disabled storage — buffer is best-effort.
  }
}

function clearPending(tournamentId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(pendingKey(tournamentId));
  } catch {
    // Same — best-effort.
  }
}

// ─── network ──────────────────────────────────────────────────────────────

type PostSoloResult =
  | { ok: true; data: SoloSubmitResponse }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      networkFailure?: boolean;
    };

async function postSolo(params: {
  tournamentDbId: string;
  body: {
    playerAddress: string;
    score: number;
    durationSeconds: number;
    /** X20.0a — optional moves count for AntiCheat F0 (X20.0b). */
    moves?: number;
    feeTxHash?: string;
  };
  /**
   * X14.1 — optional connector identifier echoed to the server when the
   * tournament is human-only AND the client has a connected wallet.
   * Server reads `X-Extension-Profile` and emits the
   * `x14_1_extension_profile` audit event; missing header means the
   * client either didn't detect a connector or didn't deem it relevant
   * (mixed-declared / agent-only tournament).
   */
  extensionHeader?: string;
}): Promise<PostSoloResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (params.extensionHeader) {
    headers[EXTENSION_PROFILE_HEADER] = params.extensionHeader;
  }
  let res: Response;
  try {
    res = await fetch(apiUrl(`/api/tournaments/${params.tournamentDbId}/solo`), {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      code: "network_failure",
      message: e instanceof Error ? e.message : "network failure",
      networkFailure: true,
    };
  }
  if (res.ok) {
    const data = (await res.json()) as SoloSubmitResponse;
    return { ok: true, data };
  }
  const err = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  };
  return {
    ok: false,
    status: res.status,
    code: err.error ?? `http_${res.status}`,
    message: err.message ?? res.statusText,
  };
}

// ─── hook ──────────────────────────────────────────────────────────────────

export function useSoloRetry(params: UseSoloRetryParams): UseSoloRetryReturn {
  const {
    tournamentId,
    tournamentOnChainId,
    gameSlug,
    eligibility,
    tournamentEndsAt,
    onSubmitted,
    extensionProfile,
  } = params;

  const { address } = useAccount();
  const dataSuffix = useSkillOSDataSuffix();

  const [status, setStatus] = useState<UseSoloRetryStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [liveScore, setLiveScore] = useState(0);
  const [finalScore, setFinalScore] = useState<number | null>(null);
  const [result, setResult] = useState<SoloSubmitResponse | null>(null);
  /** Held from chargeRetryFee receipt until the score POST consumes it. null on free path. */
  const [feeTxHash, setFeeTxHash] = useState<Hex | null>(null);
  /** Match start wall clock — Date.now() at "playing" entry, read on game-over. */
  const matchStartTimeRef = useRef<number>(Date.now());
  /** Latches replay-on-mount to one attempt per hook lifetime. */
  const replayedRef = useRef<boolean>(false);
  /** Latches the auto-chain effect (approve→charge) so re-renders don't re-fire. */
  const chargeStartedRef = useRef<boolean>(false);

  // ─── allowance ────────────────────────────────────────────────────────
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, TOURNAMENT_POOL_V2_ADDRESS] : undefined,
    query: { enabled: !!address },
  });
  const hasAllowance =
    typeof allowance === "bigint" && allowance >= RETRY_FEE;

  // ─── approve tx ───────────────────────────────────────────────────────
  const {
    writeContract: writeApprove,
    data: approveHash,
    isPending: approvePending,
    reset: resetApprove,
  } = useWriteContract();
  const { isLoading: approveMining, isSuccess: approveDone } =
    useWaitForTransactionReceipt({ hash: approveHash });
  useEffect(() => {
    if (approveDone) {
      void refetchAllowance();
      resetApprove();
    }
  }, [approveDone, refetchAllowance, resetApprove]);

  // ─── chargeRetryFee tx ────────────────────────────────────────────────
  const {
    writeContract: writeCharge,
    data: chargeHash,
    isPending: chargePending,
    reset: resetCharge,
  } = useWriteContract();
  const { isLoading: chargeMining, isSuccess: chargeDone } =
    useWaitForTransactionReceipt({ hash: chargeHash });

  // ─── auto-chain approve → charge while in "paying" ───────────────────
  // Mirrors the legacy solo-page chain. Smart-Wallet/paymaster path is
  // deferred to Phase 2; this is the universal 2-tx flow.
  //
  // Trigger on approveDone ONLY — NOT on hasAllowance. The React-side
  // `allowance` state is refreshed via async refetchAllowance(), which
  // lags behind on-chain truth. Gating on hasAllowance loses the race
  // on fresh wallets: the effect returns early at the render where
  // approveDone first goes true, and by the next render resetApprove()
  // has flipped approveDone back to false — the chain stays stuck.
  // The receipt is authoritative: approveDone === true ⇒ allowance is
  // sufficient on-chain. chargeStartedRef latches against re-fire.
  useEffect(() => {
    if (
      status !== "paying" ||
      !approveDone ||
      chargeHash ||
      !address ||
      !tournamentOnChainId
    ) {
      return;
    }
    if (chargeStartedRef.current) return;
    chargeStartedRef.current = true;
    writeCharge(
      {
        address: TOURNAMENT_POOL_V2_ADDRESS,
        abi: TOURNAMENT_POOL_ABI,
        functionName: "chargeRetryFee",
        args: [tournamentOnChainId, address],
        ...(dataSuffix && { dataSuffix }),
      },
      {
        onError: (e) => {
          setError(parseWalletError(e).message);
          setStatus("error");
          chargeStartedRef.current = false;
        },
      },
    );
  }, [
    status,
    approveDone,
    chargeHash,
    address,
    tournamentOnChainId,
    dataSuffix,
    writeCharge,
  ]);

  // ─── on charge mined: write buffer + start the match clock ───────────
  useEffect(() => {
    if (!chargeDone || !chargeHash) return;
    if (status !== "paying") return;
    setFeeTxHash(chargeHash);
    if (tournamentId) {
      writePending(tournamentId, {
        feeTxHash: chargeHash,
        score: 0,
        durationSeconds: 0,
        // X20.0a — moves not yet captured at pay-time; filled in at game-over.
        moves: null,
        timestamp: Date.now(),
        gameSlug,
      });
    }
    matchStartTimeRef.current = Date.now();
    setStatus("playing");
  }, [chargeDone, chargeHash, status, tournamentId, gameSlug]);

  // ─── submit ───────────────────────────────────────────────────────────
  const submit = useCallback(
    async (
      score: number,
      durationSeconds: number,
      feeTxHashArg: Hex | null,
      moves: number | null,
    ) => {
      if (!address || !tournamentId) return;
      setStatus("submitting");
      setError(null);
      const extensionHeader =
        extensionProfile?.enforced && extensionProfile.detected != null
          ? extensionProfile.detected
          : undefined;
      const res = await postSolo({
        tournamentDbId: tournamentId,
        body: {
          playerAddress: address,
          score,
          durationSeconds,
          ...(moves != null ? { moves } : {}),
          ...(feeTxHashArg ? { feeTxHash: feeTxHashArg } : {}),
        },
        ...(extensionHeader ? { extensionHeader } : {}),
      });
      if (res.ok) {
        clearPending(tournamentId);
        setResult(res.data);
        setStatus("submitted");
        onSubmitted?.(res.data);
        return;
      }
      // 402 means server thinks paid retry but feeTxHash was missing/invalid.
      // We DID pay upfront. Surface as error rather than silently re-prompting
      // — the chain credit still exists, user can revisit via replay path.
      if (res.status === 402) {
        setError(
          "Server says payment required, but the fee was already paid on-chain. Refresh and retry — your credit is preserved.",
        );
        setStatus("error");
        return;
      }
      if (res.networkFailure) {
        // localStorage already holds (score, feeTxHash, duration). Soft-state
        // the UI so the user knows their run is queued, not lost.
        if (tournamentId) {
          writePending(tournamentId, {
            feeTxHash: feeTxHashArg,
            score,
            durationSeconds,
            moves,
            timestamp: Date.now(),
            gameSlug,
          });
        }
        setError("Network slow — score buffered, will retry on next visit.");
        setStatus("submission-queued");
        return;
      }
      setError(`${res.code}: ${res.message}`);
      setStatus("error");
    },
    [address, tournamentId, gameSlug, onSubmitted, extensionProfile],
  );

  // ─── replay buffered submit on mount ─────────────────────────────────
  useEffect(() => {
    if (replayedRef.current) return;
    if (!address || !tournamentId || !tournamentEndsAt) return;
    if (status !== "idle") return;
    const pending = readPending(tournamentId);
    if (!pending) return;
    if (pending.gameSlug !== gameSlug) return;
    // Only replay completed runs (score > 0). score=0 means "paid but never
    // played" — an abandoned credit Phase 2 resume UX will surface separately.
    if (pending.score <= 0) return;
    if (new Date(tournamentEndsAt).getTime() < Date.now()) {
      // Tournament closed; abandon the buffer.
      clearPending(tournamentId);
      return;
    }
    replayedRef.current = true;
    // Restore finalScore from the pending submission so the result UI
    // shows the originally-submitted score rather than falling back to
    // result.bestScore on rehydrate (which can be a different number
    // when this run was below the player's tournament best).
    setFinalScore(pending.score);
    // X20.0a — pending.moves carries through; older buffered runs
    // (pre-X20.0a) where the field was absent JSON-parse as undefined →
    // treated as null below.
    const pendingMoves =
      typeof pending.moves === "number" ? pending.moves : null;
    void submit(
      pending.score,
      pending.durationSeconds,
      pending.feeTxHash,
      pendingMoves,
    );
  }, [address, tournamentId, tournamentEndsAt, gameSlug, status, submit]);

  // ─── entry points ────────────────────────────────────────────────────
  const handlePlayClick = useCallback(() => {
    if (!address || !tournamentId || !tournamentOnChainId) {
      setError("Connect a wallet first.");
      setStatus("error");
      return;
    }
    if (!eligibility) {
      // Shouldn't happen if the parent disables the button until eligibility
      // is loaded — surface as a transient state if it does.
      setStatus("checking-eligibility");
      return;
    }
    setError(null);
    setLiveScore(0);
    setFinalScore(null);
    setResult(null);
    setFeeTxHash(null);
    chargeStartedRef.current = false;
    resetCharge();
    resetApprove();

    if (!eligibility.nextPaidRetry) {
      // Free path — game starts immediately.
      matchStartTimeRef.current = Date.now();
      setStatus("playing");
      return;
    }

    // Paid path — wallet popup BEFORE game starts.
    setStatus("awaiting-payment");
    if (!hasAllowance) {
      writeApprove(
        {
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [TOURNAMENT_POOL_V2_ADDRESS, maxUint256],
          ...(dataSuffix && { dataSuffix }),
        },
        {
          onSuccess: () => {
            setStatus("paying");
          },
          onError: (e) => {
            setError(parseWalletError(e).message);
            setStatus("idle");
          },
        },
      );
      return;
    }
    // Allowance already granted — go straight to chargeRetryFee.
    setStatus("paying");
    chargeStartedRef.current = true;
    writeCharge(
      {
        address: TOURNAMENT_POOL_V2_ADDRESS,
        abi: TOURNAMENT_POOL_ABI,
        functionName: "chargeRetryFee",
        args: [tournamentOnChainId, address],
        ...(dataSuffix && { dataSuffix }),
      },
      {
        onError: (e) => {
          setError(parseWalletError(e).message);
          setStatus("error");
          chargeStartedRef.current = false;
        },
      },
    );
  }, [
    address,
    tournamentId,
    tournamentOnChainId,
    eligibility,
    hasAllowance,
    dataSuffix,
    writeApprove,
    writeCharge,
    resetCharge,
    resetApprove,
  ]);

  const handleGameOver = useCallback(
    (score: number, durationSeconds?: number, moves?: number) => {
      // Guard against double-fire: timer expiry + natural game-over can race.
      if (status !== "playing") return;
      if (finalScore != null) return;
      const computed =
        typeof durationSeconds === "number"
          ? durationSeconds
          : Math.max(
              0,
              Math.floor((Date.now() - matchStartTimeRef.current) / 1000),
            );
      // X20.0a — coerce undefined to null so localStorage round-trips a
      // distinguishable absence. Negative / non-integer values are caught
      // server-side by parseMovesField; we don't double-validate here.
      const movesValue = typeof moves === "number" ? moves : null;
      setFinalScore(score);
      // Buffer first so a network failure on submit isn't catastrophic.
      if (tournamentId) {
        writePending(tournamentId, {
          feeTxHash,
          score,
          durationSeconds: computed,
          moves: movesValue,
          timestamp: Date.now(),
          gameSlug,
        });
      }
      void submit(score, computed, feeTxHash, movesValue);
    },
    [status, finalScore, tournamentId, feeTxHash, gameSlug, submit],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setLiveScore(0);
    setFinalScore(null);
    setResult(null);
    setFeeTxHash(null);
    chargeStartedRef.current = false;
    replayedRef.current = false;
    resetApprove();
    resetCharge();
  }, [resetApprove, resetCharge]);

  const walletBusy =
    approvePending || approveMining || chargePending || chargeMining;

  return {
    status,
    error,
    liveScore,
    finalScore,
    result,
    eligibility,
    canPlay: status === "playing",
    walletBusy,
    handlePlayClick,
    handleGameOver,
    setLiveScore,
    reset,
  };
}
