"use client";;
import { use } from "react";

// Per-tournament detail view — used for archive deep-links.
// Renders the same TournamentSection layout as /tournament but for a
// specific tournament id (settled or active).

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import {
  AddressDisplay,
  apiUrl,
  ExclusionTooltip,
  TournamentClassPill,
} from "@skillos/ui";

type Tournament = {
  id: string;
  onChainId: string;
  game: string;
  cycleType: "daily" | "weekly";
  startsAt: string;
  endsAt: string;
  prizePoolUsdc: string;
  participationBonus: number;
  sponsorAddress: string;
  sponsorName: string | null;
  settledAt: string | null;
  settleTxHash: string | null;
  entryCount: number;
  tournamentClass: "human-only" | "agent-only" | "mixed-declared";
};

type LeaderboardEntry = {
  rank: number;
  playerAddress: string;
  bestScore: number;
  matchCount: number;
  effectiveRankScore: string;
  excluded: boolean;
  excludedReason: string | null;
  prizeWonUsdc: string | null;
};

async function fetchDetail(
  id: string,
): Promise<{ tournament: Tournament; leaderboard: LeaderboardEntry[] }> {
  const res = await fetch(apiUrl(`/api/tournaments/${id}`), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export default function TournamentDetailPage(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = use(props.params);
  const { address } = useAccount();
  const { data, isLoading, error } = useQuery({
    queryKey: ["tournament", params.id],
    queryFn: () => fetchDetail(params.id),
  });

  if (isLoading) {
    return (
      <main className="flex min-h-[calc(100vh-56px)] items-center justify-center">
        <p className="text-sm text-neutral-400">Loading…</p>
      </main>
    );
  }
  if (error || !data) {
    return (
      <main className="flex min-h-[calc(100vh-56px)] items-center justify-center">
        <p className="text-sm text-red-400">Tournament not found.</p>
      </main>
    );
  }

  const { tournament, leaderboard } = data;

  return (
    <main className="py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href="/tournament/archive"
          className="text-xs text-neutral-400 underline-offset-4 hover:text-neutral-200 hover:underline"
        >
          ← Back to archive
        </Link>

        <section className="rounded-2xl border border-border bg-bg-elev p-6">
          <p className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
            {tournament.cycleType} · {tournament.game}
            {tournament.settledAt && (
              <span className="ml-2 rounded bg-neutral-500/20 px-1.5 py-0.5 text-[10px]">
                settled
              </span>
            )}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {tournament.cycleType === "daily" ? "Daily" : "Weekly"}{" "}
            {tournament.game} Tournament
          </h1>
          <div className="mt-2">
            <TournamentClassPill tournamentClass={tournament.tournamentClass} />
          </div>
          <p className="mt-1 text-xs text-neutral-500">
            {new Date(tournament.startsAt).toLocaleString()} —{" "}
            {new Date(tournament.endsAt).toLocaleString()}
          </p>

          <div className="mt-4 grid grid-cols-3 gap-3">
            <MiniStat label="Prize pool" value={`${tournament.prizePoolUsdc} USDC`} accent />
            <MiniStat
              label="Players"
              value={
                leaderboard.filter((e) => !e.excluded).length === 0
                  ? "—"
                  : String(leaderboard.filter((e) => !e.excluded).length)
              }
            />
            <MiniStat
              label="Sponsor"
              value={tournament.sponsorName ?? "SkillOS"}
            />
          </div>

          {leaderboard.length === 0 ? (
            <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-center text-sm text-neutral-500">
              No entries.
            </p>
          ) : (
            <div className="mt-6 overflow-hidden rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg-elev2 text-[10px] uppercase tracking-wider text-neutral-500">
                  <tr>
                    <th className="px-3 py-2">Rank</th>
                    <th className="px-3 py-2">Player</th>
                    <th className="px-3 py-2 text-right">Best</th>
                    <th className="px-3 py-2 text-right">Prize</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {leaderboard.map((e) => {
                    const isMe =
                      address &&
                      e.playerAddress.toLowerCase() === address.toLowerCase();
                    return (
                      <tr
                        key={e.playerAddress}
                        className={
                          e.excluded
                            ? "bg-red-500/5 text-neutral-500"
                            : isMe
                              ? "bg-skill/5"
                              : "text-neutral-200"
                        }
                      >
                        <td className="px-3 py-2 tabular-nums">
                          {e.excluded ? (
                            <ExclusionTooltip reason={e.excludedReason} />
                          ) : (
                            `#${e.rank}`
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          <AddressDisplay address={e.playerAddress} />
                          {isMe && (
                            <span className="ml-2 rounded bg-skill/20 px-1.5 py-0.5 text-[10px] text-skill">
                              you
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {e.bestScore}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {e.prizeWonUsdc ? (
                            <span className="text-skill">
                              {Number(e.prizeWonUsdc).toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-neutral-600">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function MiniStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        "rounded-lg border p-3 " +
        (accent ? "border-skill/40 bg-skill/5" : "border-border bg-bg-elev2")
      }
    >
      <p className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </p>
      <p
        className={
          "mt-1 text-sm font-semibold tabular-nums " +
          (accent ? "text-skill" : "text-neutral-100")
        }
      >
        {value}
      </p>
    </div>
  );
}
