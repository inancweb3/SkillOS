"use client";

// ───────────────────────────────────────────────────────────────────────────
// /tournament/solo — solo submit primary path (Tournaments v2).
//
// Pay-then-play state machine: payment settles BEFORE the game starts.
// The full state machine + localStorage replay logic lives in the shared
// useSoloRetry hook (@skillos/ui). This page is presentation-only.
//
// Smart Wallet + EIP-5792 batched paymaster path is deferred to Phase 2 —
// every wallet uses the legacy useWriteContract approve+chargeRetryFee
// flow until the bundler-drop bug is diagnosed.
// ───────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Hex } from "viem";
import { useAccount } from "wagmi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PLAY_WINDOW_MS } from "@skillos/contracts";
import {
  apiUrl,
  EmbedWalletFallback,
  ExtensionWarningModal,
  PopupHint,
  SoloResultCard,
  Timer,
  TournamentClassPill,
  evaluateExtensionProfile,
  useIsEmbedded,
  useSoloRetry,
  type SoloEligibility,
  type TournamentClass,
} from "@skillos/ui";
import { Game2048 } from "@/components/Game2048";
import { AICoach } from "@/components/AICoach";
import { AIRecap } from "@/components/AIRecap";
import { AIReviewedBadge } from "@/components/AIReviewedBadge";
import { SPEarnedCard } from "@/components/SPEarnedCard";

const GAME = "2048";

// ─── Types ─────────────────────────────────────────────────────────────────

type Tournament = {
  id: string;
  onChainId: Hex;
  game: string;
  cycleType: "daily" | "weekly";
  endsAt: string;
  prizePoolUsdc: string;
  entryCount: number;
  eligibility: SoloEligibility | null;
  tournamentClass: TournamentClass;
};

type ActiveResponse = {
  daily: Tournament | null;
  weekly: Tournament | null;
};

// ─── Data ──────────────────────────────────────────────────────────────────

async function fetchActive(address: string | undefined): Promise<ActiveResponse> {
  const url = address
    ? `/api/tournaments?address=${address}`
    : `/api/tournaments`;
  const res = await fetch(apiUrl(url), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ActiveResponse;
}

// ─── Utilities ────────────────────────────────────────────────────────────

function randomSeed(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function useCountdown(targetIso: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!targetIso) return "";
  const ms = new Date(targetIso).getTime() - now;
  if (ms <= 0) return "Closing…";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function SoloPage() {
  const router = useRouter();
  const { address, connector } = useAccount();
  const isEmbedded = useIsEmbedded();
  const queryClient = useQueryClient();

  const tournamentsKey = useMemo(
    () => ["tournaments", "active", GAME, "solo", address] as const,
    [address],
  );

  const { data: activeData } = useQuery({
    queryKey: tournamentsKey,
    queryFn: () => fetchActive(address),
    refetchInterval: 30_000,
  });
  const tournament = activeData?.daily ?? null;
  const countdown = useCountdown(tournament?.endsAt);

  // X14.1 — extension whitelist soft-warning. evaluateExtensionProfile is
  // pure; useMemo just stabilizes object identity for the useSoloRetry dep
  // array. enforced=true triggers the modal + adds X-Extension-Profile to
  // the submit fetch; enforced=false makes both inert.
  const extensionProfile = useMemo(
    () =>
      evaluateExtensionProfile(
        connector?.id,
        tournament?.tournamentClass ?? "mixed-declared",
      ),
    [connector?.id, tournament?.tournamentClass],
  );

  const [seed, setSeed] = useState(() => randomSeed());

  const {
    status,
    error,
    liveScore,
    finalScore,
    result,
    canPlay,
    walletBusy,
    handlePlayClick,
    handleGameOver,
    setLiveScore,
    reset,
    eligibility,
  } = useSoloRetry({
    tournamentId: tournament?.id ?? null,
    tournamentOnChainId: (tournament?.onChainId as Hex | undefined) ?? null,
    gameSlug: GAME,
    eligibility: tournament?.eligibility ?? null,
    tournamentEndsAt: tournament?.endsAt ?? null,
    extensionProfile,
    onSubmitted: () => {
      // Refresh eligibility — priorSoloRuns went up; next click is paid retry.
      void queryClient.invalidateQueries({ queryKey: tournamentsKey });
    },
  });

  // New play deadline each time the game (re)starts. Reset seed too so the
  // game component remounts with fresh internal state.
  const [playDeadline, setPlayDeadline] = useState<string | null>(null);
  // X20.0a — bridges onMovesChange (each game emits its current count) to
  // handleGameOver. Reset per play session so an earlier game's count
  // doesn't leak into the next submit.
  const lastMovesRef = useRef(0);
  useEffect(() => {
    if (canPlay) {
      setPlayDeadline(
        new Date(Date.now() + PLAY_WINDOW_MS).toISOString(),
      );
      setSeed(randomSeed());
      lastMovesRef.current = 0;
    }
  }, [canPlay]);

  function handlePlayPress() {
    handlePlayClick();
  }

  function handlePlayAgain() {
    reset();
    handlePlayClick();
  }

  // ─── Render ─────────────────────────────────────────────────────────

  if (!address) {
    return (
      <main className="flex min-h-[calc(100vh-56px)] flex-col items-center justify-center gap-4 px-4">
        <EmbedWalletFallback />
        {!isEmbedded && (
          <p className="text-sm text-neutral-400">
            Connect your wallet to play solo.
          </p>
        )}
      </main>
    );
  }
  if (!tournament) {
    return (
      <main className="flex min-h-[calc(100vh-56px)] flex-col items-center justify-center px-4">
        <p className="text-sm text-neutral-400">
          No active tournament. The next one opens at the top of the hour.
        </p>
        <Link
          href="/tournament"
          className="mt-4 text-xs text-neutral-500 underline-offset-4 hover:underline"
        >
          ← back to tournaments
        </Link>
      </main>
    );
  }

  const isPaidRetry = eligibility?.nextPaidRetry === true;
  const playButtonLabel = !eligibility
    ? "Loading…"
    : isPaidRetry
      ? "Pay 1.00 USDC & play"
      : "Play (free)";
  const playButtonDisabled = !eligibility || walletBusy;

  return (
    <main className="flex min-h-[calc(100vh-56px)] flex-col items-center px-4 py-6">
      {/* Header */}
      <div className="mb-4 flex w-full max-w-md items-center justify-between gap-3">
        <button
          onClick={() => router.push("/tournament")}
          className="rounded-lg border border-border-subtle bg-bg-elev px-2 py-1 text-[11px] text-neutral-400 hover:text-neutral-100"
        >
          ← Exit
        </button>
        <div className="text-center">
          <p className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
            Solo · {tournament.cycleType}
          </p>
          <div className="mt-0.5 flex justify-center">
            <TournamentClassPill
              tournamentClass={tournament.tournamentClass}
              size="xs"
            />
          </div>
          <p className="mt-0.5 font-mono text-[10px] text-neutral-500">
            closes in {countdown}
          </p>
        </div>
        {canPlay && playDeadline ? (
          <Timer
            deadline={playDeadline}
            onExpire={() => handleGameOver(liveScore, undefined, lastMovesRef.current)}
          />
        ) : (
          <div className="w-[52px]" />
        )}
      </div>

      {/* X14.1 — soft warning when human-only tournament + non-whitelisted connector */}
      <div className="w-full max-w-md">
        <ExtensionWarningModal profile={extensionProfile} />
      </div>

      {/* Live score */}
      <div className="mb-4 w-full max-w-md rounded-xl border border-skill/50 bg-skill/5 p-3 text-center">
        <p className="text-[10px] uppercase tracking-wider text-neutral-500">
          Your score
        </p>
        <p className="mt-0.5 text-3xl font-bold tabular-nums text-neutral-100">
          {finalScore ?? liveScore}
        </p>
      </div>

      {/* Game (only while playing) */}
      {canPlay && (
        <Game2048
          seed={seed}
          onGameOver={(score) =>
            handleGameOver(score, undefined, lastMovesRef.current)
          }
          onScoreChange={setLiveScore}
          onMovesChange={(n) => {
            lastMovesRef.current = n;
          }}
          frozen={false}
        />
      )}

      {/* Pre-game CTA — idle, awaiting-payment, paying, error-without-finalScore */}
      {!canPlay && finalScore == null && (
        <div className="mt-6 w-full max-w-md space-y-3">
          {status === "idle" || status === "checking-eligibility" ? (
            <Panel>
              <p className="text-sm font-semibold text-neutral-100">
                Ready to play?
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                {isPaidRetry
                  ? "Your first run is in. Each retry costs 1.00 USDC. Payment settles on-chain before the game starts — no cherry-picking."
                  : "Your first solo entry is free. Subsequent retries are 1.00 USDC each."}
              </p>
              <button
                onClick={handlePlayPress}
                disabled={playButtonDisabled}
                className="mt-3 w-full rounded-lg bg-skill px-3 py-2 text-sm font-semibold text-black transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {playButtonLabel}
              </button>
              {isPaidRetry && <PopupHint />}
            </Panel>
          ) : null}

          {status === "awaiting-payment" && (
            <Panel>
              <p className="text-sm text-neutral-300">
                Confirm payment in your wallet…
              </p>
            </Panel>
          )}

          {status === "paying" && (
            <Panel>
              <p className="text-sm text-neutral-300">
                Settling fee on-chain… game starts on confirmation.
              </p>
              <PopupHint variant="stuck" />
            </Panel>
          )}

          {status === "error" && (
            <Panel tone="error">
              <p className="text-sm text-red-300">
                {error ?? "Something went wrong."}
              </p>
              <button
                onClick={reset}
                className="mt-2 text-xs underline"
              >
                Reset
              </button>
            </Panel>
          )}
        </div>
      )}

      {/* Post-game panel — single column on mobile, 2-col on desktop for the
          submitted state so score / SP / recap / coach fit fold-above. */}
      {finalScore != null && (
        <div className="mt-6 w-full max-w-md md:max-w-4xl">
          {status === "submitting" && (
            <div className="mx-auto max-w-md">
              <Panel>
                <p className="text-sm text-neutral-300">
                  Submitting {finalScore} points…
                </p>
              </Panel>
            </div>
          )}

          {status === "submitted" && result && (
            <SoloResultCard
              finalScore={finalScore}
              bestScore={result.bestScore}
              cycleType={tournament.cycleType}
              rank={result.rank}
              matchCount={result.matchCount}
              isPaidRetry={result.isPaidRetry}
              onPlayAgain={handlePlayAgain}
              walletBusy={walletBusy}
              game={GAME}
              aiReviewedBadge={
                <AIReviewedBadge matchId={result.soloRunId} context="solo" />
              }
              spEarnedCard={
                <SPEarnedCard
                  kind="solo"
                  sourceId={result.soloRunId}
                  player={address}
                />
              }
              aiRecap={<AIRecap matchId={result.soloRunId} context="solo" />}
              aiCoach={<AICoach matchId={result.soloRunId} context="solo" />}
            />
          )}

          {status === "submission-queued" && (
            <div className="mx-auto max-w-md">
              <Panel>
                <p className="text-sm font-semibold text-neutral-100">
                  Score buffered — network slow
                </p>
                <p className="mt-1 text-xs text-neutral-400">
                  Your run + payment is saved locally. We&apos;ll auto-submit on your
                  next visit while the tournament is still open.
                </p>
              </Panel>
            </div>
          )}

          {status === "error" && (
            <div className="mx-auto max-w-md">
              <Panel tone="error">
                <p className="text-sm text-red-300">
                  {error ?? "Something went wrong."}
                </p>
                <button
                  onClick={reset}
                  className="mt-2 text-xs underline"
                >
                  Reset
                </button>
              </Panel>
            </div>
          )}
        </div>
      )}
    </main>
  );
}

// ─── Presentational ───────────────────────────────────────────────────────

function Panel({
  children,
  highlight,
  tone,
}: {
  children: React.ReactNode;
  highlight?: boolean;
  tone?: "error";
}) {
  const base = "rounded-xl border p-4";
  const cls =
    tone === "error"
      ? `${base} border-red-500/40 bg-red-500/10`
      : highlight
        ? `${base} border-skill/50 bg-skill/5`
        : `${base} border-border bg-bg-elev`;
  return <div className={cls}>{children}</div>;
}
