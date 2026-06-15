"use client";

// ───────────────────────────────────────────────────────────────────────────
// Global SP leaderboard. Thesis artifact — shows the jury that "the whole
// platform levels up," not one game at a time.
//
// Global data: the rows served here are the same on 2048 / wordle / sudoku /
// minesweeper / clicker / match3. No per-game filtering, no time windows —
// those are post-submission backlog.
// ───────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AddressDisplay, apiUrl } from "@skillos/ui";

type LeaderboardRow = {
  rank: number;
  address: string;
  level: number;
  totalSp: number;
  lastActiveAt: string;
};

async function fetchLeaderboard(): Promise<LeaderboardRow[]> {
  const res = await fetch(apiUrl("/api/leaderboard"), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { leaderboard } = (await res.json()) as {
    leaderboard: LeaderboardRow[];
  };
  return leaderboard;
}

export default function LeaderboardPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["leaderboard-global"],
    queryFn: fetchLeaderboard,
  });

  if (isLoading) {
    return (
      <main className="flex min-h-[calc(100vh-56px)] items-center justify-center">
        <p className="text-sm text-neutral-400">Loading leaderboard…</p>
      </main>
    );
  }
  if (error || !data) {
    return (
      <main className="flex min-h-[calc(100vh-56px)] items-center justify-center">
        <p className="text-sm text-red-400">
          {error instanceof Error ? error.message : "Failed to load leaderboard."}
        </p>
      </main>
    );
  }

  return (
    <main className="py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <section className="rounded-2xl border border-border bg-bg-elev p-6">
          <p className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
            All games · All time
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Global Skill Points Leaderboard
          </h1>
          <p className="mt-1 text-xs text-neutral-500">
            All-time SP across every game mode. One profile, every skill.
          </p>

          {data.length === 0 ? (
            <p className="mt-6 rounded-lg border border-dashed border-border p-6 text-center text-sm text-neutral-500">
              No SP earned yet. Be the first on the board.
            </p>
          ) : (
            <div className="mt-6 overflow-hidden rounded-lg border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg-elev2 text-[10px] uppercase tracking-wider text-neutral-500">
                  <tr>
                    <th className="px-3 py-2">Rank</th>
                    <th className="px-3 py-2">Player</th>
                    <th className="px-3 py-2 text-right">Level</th>
                    <th className="px-3 py-2 text-right">Total SP</th>
                    <th className="px-3 py-2 text-right">Last active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {data.map((row) => (
                    <tr key={row.address} className="text-neutral-200">
                      <td className="px-3 py-2 tabular-nums">
                        {row.rank <= 3 ? (
                          <span className="text-skill">#{row.rank}</span>
                        ) : (
                          `#${row.rank}`
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        <Link
                          href={`/profile/${row.address}`}
                          className="underline-offset-4 hover:text-skill hover:underline"
                        >
                          <AddressDisplay address={row.address} />
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className="inline-block rounded bg-skill/10 px-1.5 py-0.5 text-[10px] font-semibold text-skill">
                          L{row.level}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.totalSp.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-neutral-500">
                        {formatRelative(row.lastActiveAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `just now`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
