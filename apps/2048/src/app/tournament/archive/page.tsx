"use client";

// ───────────────────────────────────────────────────────────────────────────
// /tournament/archive — last 10 settled tournaments.
//
// Minimal list; deep-link into per-tournament detail later if needed.
// ───────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiUrl, basescanTx } from "@skillos/ui";

const GAME_DISPLAY = "2048";

type Tournament = {
  id: string;
  onChainId: string;
  cycleType: "daily" | "weekly";
  startsAt: string;
  endsAt: string;
  prizePoolUsdc: string;
  settledAt: string | null;
  settleTxHash: string | null;
};

async function fetchArchive(): Promise<{ archive: Tournament[] }> {
  const res = await fetch(apiUrl("/api/tournaments/archive"), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as { archive: Tournament[] };
}

export default function TournamentArchivePage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["tournaments", "archive", GAME_DISPLAY],
    queryFn: fetchArchive,
  });

  return (
    <main className="py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href="/tournament"
          className="text-xs text-neutral-400 underline-offset-4 hover:text-neutral-200 hover:underline"
        >
          ← Back to active tournaments
        </Link>

        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Past {GAME_DISPLAY} tournaments
          </h1>
          <p className="text-sm text-neutral-400">
            Last 10 settled cycles. Click a row to see the final leaderboard
            and settle transaction.
          </p>
        </header>

        {isLoading && (
          <p className="text-sm text-neutral-500">Loading archive…</p>
        )}
        {error && (
          <p className="text-sm text-red-400">Could not load archive.</p>
        )}

        {data && data.archive.length === 0 && (
          <div className="rounded-xl border border-dashed border-border bg-bg-elev p-6 text-center text-sm text-neutral-500">
            No tournaments have settled yet.
          </div>
        )}

        {data && data.archive.length > 0 && (
          <ul className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border bg-bg-elev">
            {data.archive.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between px-4 py-3"
              >
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-neutral-500">
                    {t.cycleType}
                  </p>
                  <Link
                    href={`/tournament/${t.id}`}
                    className="text-sm font-medium text-neutral-100 hover:text-skill"
                  >
                    {new Date(t.startsAt).toLocaleDateString()} →{" "}
                    {new Date(t.endsAt).toLocaleDateString()}
                  </Link>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="tabular-nums text-neutral-400">
                    {t.prizePoolUsdc} USDC
                  </span>
                  {t.settleTxHash && (
                    <a
                      href={basescanTx(t.settleTxHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-neutral-500 underline-offset-4 hover:text-neutral-200 hover:underline"
                    >
                      Settle ↗
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
