"use client";

// ───────────────────────────────────────────────────────────────────────────
// TournamentInvite — post-duel nudge to submit the score to an active
// tournament. Renders on the result page, only when:
//   - match status is settled
//   - caller won the duel
//   - plausibility is not 'implausible'
//   - an active daily tournament exists for this game
//
// One-click submit. Optimistic rank via the POST response. Hides itself
// on success to avoid re-submits of the same duel.
// ───────────────────────────────────────────────────────────────────────────

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiUrl } from "@skillos/ui";

type Tournament = {
  id: string;
  cycleType: "daily" | "weekly";
  prizePoolUsdc: string;
  entryCount: number;
  endsAt: string;
};

type ActiveResponse = {
  daily: Tournament | null;
  weekly: Tournament | null;
};

type SubmitResponse = {
  submitted: boolean;
  rank: number;
  txHash: string;
  bestScore: number;
  matchCount: number;
};

async function fetchActive(): Promise<ActiveResponse> {
  const res = await fetch(apiUrl("/api/tournaments"), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ActiveResponse;
}

async function submitToTournament(input: {
  tournamentId: string;
  playerAddress: string;
  duelId: string;
  score: number;
}): Promise<SubmitResponse> {
  const res = await fetch(
    apiUrl(`/api/tournaments/${input.tournamentId}/submit`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerAddress: input.playerAddress,
        duelId: input.duelId,
        score: input.score,
      }),
    },
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.error) detail = `${body.error}: ${body.message ?? ""}`.trim();
    } catch {
      /* non-JSON body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as SubmitResponse;
}

type Props = {
  matchId: string;
  player: `0x${string}`;
  score: number;
};

export function TournamentInvite({ matchId, player, score }: Props) {
  const [dismissed, setDismissed] = useState(false);
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["tournaments", "active-for-invite"],
    queryFn: fetchActive,
    // Short stale window — we just finished a match, user may linger here
    // for a minute before submitting. Don't need real-time.
    staleTime: 30_000,
  });

  const daily = data?.daily ?? null;

  const mutation = useMutation({
    mutationFn: () => {
      if (!daily) throw new Error("no active daily tournament");
      return submitToTournament({
        tournamentId: daily.id,
        playerAddress: player,
        duelId: matchId,
        score,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tournaments"] });
    },
  });

  if (isLoading || !data) return null;
  if (!daily) return null;
  if (dismissed) return null;

  // Already submitted → success state with rank.
  if (mutation.isSuccess) {
    return (
      <div className="rounded-xl border border-skill/40 bg-skill/5 p-4">
        <p className="text-[10px] uppercase tracking-wider text-skill">
          Submitted
        </p>
        <p className="mt-1 text-sm text-neutral-100">
          You&apos;re currently{" "}
          <span className="font-semibold text-skill">
            #{mutation.data.rank}
          </span>{" "}
          on the Daily Tournament leaderboard.
        </p>
        <a
          href="/tournament"
          className="mt-2 inline-block text-xs text-neutral-400 underline-offset-4 hover:text-neutral-200 hover:underline"
        >
          View full leaderboard →
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-bg-elev2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-neutral-500">
            Active tournament
          </p>
          <p className="mt-1 text-sm text-neutral-100">
            Daily · <span className="text-skill">{daily.prizePoolUsdc} USDC</span>{" "}
            pool · {daily.entryCount} players
          </p>
        </div>
        <button
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
          className="text-neutral-600 hover:text-neutral-300"
        >
          ×
        </button>
      </div>
      <button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-lg bg-skill text-sm font-semibold text-black transition hover:opacity-90 disabled:opacity-60"
      >
        {mutation.isPending
          ? "Submitting…"
          : `Submit score ${score} to tournament`}
      </button>
      {mutation.isError && (
        <p className="mt-2 text-xs text-red-400">
          {(mutation.error as Error).message}
        </p>
      )}
    </div>
  );
}
