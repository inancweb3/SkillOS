"use client";

// ───────────────────────────────────────────────────────────────────────────
// /tournament — active daily + weekly leaderboards for this game.
//
// Both cycles (when present) are rendered stacked, daily first. Empty-state
// (no active tournament yet) tells the user the next one creates at the
// top of the hour. Live-refresh leaderboard every 5s via React Query.
// ───────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import {
  apiUrl,
  ExclusionTooltip,
  TournamentClassPill,
  truncateAddress,
} from "@skillos/ui";

const GAME = "2048";
const GAME_DISPLAY = "2048";

// Prize curve for display. Mirrors TournamentPool._distributePrizes +
// computePrizeDistribution in @skillos/duel-backend, but returns
// percentages for the UI "what am I playing for" chart.
type CurvePoint = { place: string; pct: number };
function previewCurve(participantCount: number): CurvePoint[] {
  if (participantCount === 0) {
    return [
      { place: "1st", pct: 25 },
      { place: "2nd", pct: 15 },
      { place: "3rd", pct: 10 },
      { place: "4th–10th", pct: 5 },
      { place: "11th+", pct: 15 }, // shared among 11..topN
    ];
  }
  if (participantCount < 4) return [{ place: "1st", pct: 100 }];
  const topN = Math.ceil(participantCount / 2);
  const points: CurvePoint[] = [
    { place: "1st", pct: 25 },
    { place: "2nd", pct: 15 },
    { place: "3rd", pct: 10 },
  ];
  const tier4Count = Math.min(10, topN) - 3;
  if (tier4Count > 0) {
    points.push({ place: tier4Count === 1 ? "4th" : `4th–${3 + tier4Count}th`, pct: 5 });
  }
  if (topN > 10) {
    const t5 = topN - 10;
    const eachPct = 15 / t5;
    points.push({
      place: `11th–${topN}th`,
      pct: Number(eachPct.toFixed(2)),
    });
  }
  return points;
}

// ─── Types ────────────────────────────────────────────────────────────────

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
  sponsorLogoUrl: string | null;
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
  prizeTxHash: string | null;
  level: number | null;
};

type ActiveResponse = {
  game: string;
  daily: Tournament | null;
  weekly: Tournament | null;
};

type DetailResponse = {
  tournament: Tournament;
  leaderboard: LeaderboardEntry[];
};

// ─── Data hooks ───────────────────────────────────────────────────────────

async function fetchActive(): Promise<ActiveResponse> {
  const res = await fetch(apiUrl("/api/tournaments"), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ActiveResponse;
}

async function fetchDetail(id: string): Promise<DetailResponse> {
  const res = await fetch(apiUrl(`/api/tournaments/${id}`), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as DetailResponse;
}

// ─── Countdown ───────────────────────────────────────────────────────────

function useCountdown(targetIso: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!targetIso) return "";
  const ms = new Date(targetIso).getTime() - now;
  if (ms <= 0) return "Closing…";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function TournamentPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["tournaments", "active", GAME],
    queryFn: fetchActive,
    refetchInterval: 15_000,
  });

  if (isLoading) {
    return (
      <main className="flex min-h-[calc(100vh-56px)] items-center justify-center px-4">
        <p className="text-sm text-neutral-400">Loading tournaments…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex min-h-[calc(100vh-56px)] items-center justify-center px-4">
        <p className="text-sm text-red-400">
          Could not load tournaments. Try again shortly.
        </p>
      </main>
    );
  }

  const daily = data?.daily ?? null;
  const weekly = data?.weekly ?? null;
  const hasAny = !!(daily || weekly);

  return (
    <main className="py-10">
      <div className="mx-auto max-w-3xl space-y-10">
        <header className="space-y-2">
          <p className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-bg-elev px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-neutral-400">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-skill" />
            {GAME_DISPLAY} tournaments · Base Sepolia
          </p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Compete, win USDC.
          </h1>
          <p className="max-w-xl text-sm text-neutral-400">
            Free entry. Top 50% of players split the sponsor-funded prize pool.
            Your best score across the window sets your rank, participation
            matches nudge it higher.
          </p>
        </header>

        {!hasAny && <EmptyState />}

        {daily && <TournamentSection tournament={daily} />}
        {weekly && <TournamentSection tournament={weekly} />}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-6 text-xs text-neutral-500">
          <div className="flex gap-4">
            <Link
              href="/tournament/archive"
              className="underline-offset-4 hover:text-neutral-200 hover:underline"
            >
              Past tournaments ↗
            </Link>
            <Link
              href="/leaderboard"
              className="underline-offset-4 hover:text-skill hover:underline"
            >
              Global SP leaderboard ↗
            </Link>
          </div>
          <Link
            href="/duel/waiting"
            className="underline-offset-4 hover:text-neutral-200 hover:underline"
          >
            Play a duel →
          </Link>
        </div>
      </div>
    </main>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-bg-elev p-8 text-center">
      <p className="text-sm text-neutral-300">No active tournament right now.</p>
      <p className="mt-2 text-xs text-neutral-500">
        A fresh daily tournament opens every hour, top-of-hour. The weekly
        cycle starts each Monday at 00:00 UTC.
      </p>
    </div>
  );
}

// ─── Per-tournament section: header + sponsor + prize + leaderboard ──────

function TournamentSection({ tournament }: { tournament: Tournament }) {
  const countdown = useCountdown(tournament.endsAt);
  const { data: detail } = useQuery({
    queryKey: ["tournaments", tournament.id],
    queryFn: () => fetchDetail(tournament.id),
    refetchInterval: 5_000,
  });

  const leaderboard = detail?.leaderboard ?? [];
  const participantCount = leaderboard.filter((e) => !e.excluded).length;
  const curve = useMemo(() => previewCurve(participantCount), [participantCount]);

  const title = tournament.cycleType === "daily" ? "Daily" : "Weekly";
  const totalPool = tournament.prizePoolUsdc;

  return (
    <section className="rounded-2xl border border-border bg-bg-elev p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
            {title} · {GAME_DISPLAY}
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">
            {title} {GAME_DISPLAY} Tournament
          </h2>
          <div className="mt-2">
            <TournamentClassPill tournamentClass={tournament.tournamentClass} />
          </div>
        </div>
        <div className="rounded-lg border border-skill/40 bg-skill/5 px-3 py-2 text-right">
          <p className="text-[10px] uppercase tracking-wider text-neutral-400">
            Closes in
          </p>
          <p className="font-mono text-base tabular-nums text-skill">
            {countdown}
          </p>
        </div>
      </div>

      {/* Sponsor strip */}
      <SponsorStrip tournament={tournament} />

      {/* Prize pool + curve */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCell label="Prize pool" value={`${totalPool} USDC`} accent />
        <StatCell
          label="Players"
          value={participantCount === 0 ? "—" : String(participantCount)}
        />
        <StatCell
          label="Bonus / match"
          value={`+${tournament.participationBonus}`}
          sub="rank weight"
        />
      </div>

      <PrizeCurve points={curve} />

      {/* Solo CTA — primary path into the tournament.
          Sits between the "why play" (prize pool + curve) and "who's winning"
          (leaderboard) sections; the middle slot frames it as the action
          that connects the two. Uses the same fee-transparency language as
          /tournament/solo so the sweepstakes-safe posture is consistent
          wherever the player encounters the decision point. */}
      {!tournament.settledAt && <SoloCTA />}

      {/* Leaderboard */}
      <Leaderboard
        entries={leaderboard}
        tournamentSettled={!!tournament.settledAt}
      />
    </section>
  );
}

// ─── Solo CTA ─────────────────────────────────────────────────────────────

function SoloCTA() {
  return (
    <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-skill/40 bg-skill/5 p-5 sm:flex-row sm:justify-between">
      <div>
        <p className="text-sm font-semibold text-neutral-100">
          Play solo to enter
        </p>
        <p className="mt-1 text-xs text-neutral-400">
          First entry free. Retries cost 1.00 USDC and fund platform
          operations — they don&apos;t touch the prize pool.
        </p>
      </div>
      <Link
        href="/tournament/solo"
        className="whitespace-nowrap rounded-lg bg-skill px-4 py-2 text-sm font-semibold text-black transition hover:opacity-90"
      >
        Play solo →
      </Link>
    </div>
  );
}

// ─── Sponsor strip ───────────────────────────────────────────────────────

function SponsorStrip({ tournament }: { tournament: Tournament }) {
  const hasSponsor = !!tournament.sponsorName;
  return (
    <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-elev2 px-4 py-3">
      <div className="flex items-center gap-3">
        {tournament.sponsorLogoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={tournament.sponsorLogoUrl}
            alt={tournament.sponsorName ?? "Sponsor"}
            className="h-8 w-8 rounded-md object-cover"
          />
        ) : (
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-bg text-[10px] uppercase tracking-wider text-neutral-500">
            {hasSponsor ? (tournament.sponsorName ?? "SP").slice(0, 2) : "—"}
          </div>
        )}
        <div>
          <p className="text-[10px] uppercase tracking-wider text-neutral-500">
            Sponsored by
          </p>
          <p className="text-sm font-medium text-neutral-100">
            {tournament.sponsorName ?? "Sponsorship slot open"}
          </p>
        </div>
      </div>
      {!hasSponsor && (
        <a
          href="mailto:hello@skillos.games?subject=Sponsorship%20inquiry"
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-[11px] text-neutral-300 hover:border-skill hover:text-skill"
        >
          Contact →
        </a>
      )}
    </div>
  );
}

// ─── Stat cell ───────────────────────────────────────────────────────────

function StatCell({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        "rounded-xl border p-4 " +
        (accent ? "border-skill/40 bg-skill/5" : "border-border bg-bg-elev2")
      }
    >
      <p className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </p>
      <p
        className={
          "mt-1 text-xl font-semibold tabular-nums " +
          (accent ? "text-skill" : "text-neutral-100")
        }
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[10px] text-neutral-500">{sub}</p>}
    </div>
  );
}

// ─── Prize curve ─────────────────────────────────────────────────────────

function PrizeCurve({ points }: { points: CurvePoint[] }) {
  const total = points.reduce((acc, p) => acc + p.pct, 0);
  return (
    <div className="mt-5">
      <p className="text-[10px] uppercase tracking-wider text-neutral-500">
        Prize split (top 50% of players)
      </p>
      <div className="mt-2 flex overflow-hidden rounded-md border border-border">
        {points.map((p, i) => (
          <div
            key={`${p.place}-${i}`}
            className="flex h-8 items-center justify-center border-r border-border/60 text-[10px] font-medium last:border-r-0"
            style={{
              flexBasis: `${(p.pct / Math.max(total, 1)) * 100}%`,
              background:
                i === 0
                  ? "rgba(228,242,34,0.28)"
                  : i === 1
                    ? "rgba(228,242,34,0.18)"
                    : i === 2
                      ? "rgba(228,242,34,0.1)"
                      : "rgba(255,255,255,0.04)",
              color: i < 3 ? "#e4f222" : "#a3a3a3",
            }}
            title={`${p.place}: ${p.pct}%`}
          >
            {p.pct >= 8 ? `${p.place} · ${p.pct}%` : `${p.pct}%`}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Leaderboard ─────────────────────────────────────────────────────────

function Leaderboard({
  entries,
  tournamentSettled,
}: {
  entries: LeaderboardEntry[];
  tournamentSettled: boolean;
}) {
  const { address } = useAccount();

  if (entries.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-dashed border-border bg-bg-elev2 p-6 text-center text-sm text-neutral-500">
        No entries yet — be the first. Win a duel and submit your score.
      </div>
    );
  }

  return (
    <div className="mt-6 overflow-hidden rounded-lg border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-bg-elev2 text-[10px] uppercase tracking-wider text-neutral-500">
          <tr>
            <th className="px-3 py-2">Rank</th>
            <th className="px-3 py-2">Player</th>
            <th className="px-3 py-2 text-center">Level</th>
            <th className="px-3 py-2 text-right">Best</th>
            <th className="hidden px-3 py-2 text-right sm:table-cell">Matches</th>
            <th className="hidden px-3 py-2 text-right sm:table-cell">
              Rank score
            </th>
            <th className="px-3 py-2 text-right">Prize</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {entries.map((e) => {
            const isMe =
              address && e.playerAddress.toLowerCase() === address.toLowerCase();
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
                <td className="px-3 py-2">
                  <Link
                    href={`/profile/${e.playerAddress}`}
                    className="font-mono text-xs underline-offset-4 hover:text-skill hover:underline"
                  >
                    {truncateAddress(e.playerAddress)}
                  </Link>
                  {isMe && (
                    <span className="ml-2 rounded bg-skill/20 px-1.5 py-0.5 text-[10px] text-skill">
                      you
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  {e.level != null ? (
                    <span className="inline-block rounded bg-skill/10 px-1.5 py-0.5 text-[10px] font-semibold text-skill">
                      L{e.level}
                    </span>
                  ) : (
                    <span className="text-neutral-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {e.bestScore}
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums sm:table-cell">
                  {e.matchCount}
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums text-neutral-400 sm:table-cell">
                  {Number(e.effectiveRankScore).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {e.prizeWonUsdc ? (
                    <span className="text-skill">
                      {Number(e.prizeWonUsdc).toFixed(2)}
                    </span>
                  ) : tournamentSettled ? (
                    <span className="text-neutral-600">—</span>
                  ) : (
                    <span className="text-neutral-500">pending</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
