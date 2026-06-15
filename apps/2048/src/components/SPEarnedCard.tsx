"use client";

// ───────────────────────────────────────────────────────────────────────────
// SPEarnedCard — post-game "+SP earned" card.
//
// Renders alongside AICoach / AIRecap / AIReviewedBadge on both the duel
// result panel and the solo result panel. Single endpoint behind it
// (/api/sp-earned) returns the awarded delta + the player's before/after
// snapshot in one round-trip.
//
// States:
//   1. verdict = "pending"     → "SP pending AI review…" + pulse, refetch 5s
//   2. verdict = "implausible" → "+0 SP · flagged" muted, no progress bar
//   3. verdict = resolved (plausible/suspicious) → "+N SP" + level + bar
//   4. If before.level < current.level → one-shot "Level N → N+1" transition
//
// Restraint is explicit: no confetti, no haptic, CSS-only bar width
// transition. The card should read as "skill platform," not "mobile game."
//
// Per-app duplication: this file is cloned to 5 other apps (wordle, sudoku,
// minesweeper, clicker, match3). Lift to packages/ui is post-submission
// backlog, tracked alongside AICoach/AIRecap.
// ───────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "@skillos/ui";

type CardVerdict = "plausible" | "suspicious" | "implausible" | "pending";
type EventKind = "duel_win" | "duel_loss" | "solo_submit" | "tournament_rank_bonus";

type StatsSnapshot = {
  totalSp: number;
  currentLevel: number;
  progress: {
    next: number | null;
    remaining: number;
    currentLevelMinSP: number;
  };
};

type SPEarnedDTO = {
  kind: "duel" | "solo";
  sourceId: string;
  player: string;
  eventKind: EventKind | null;
  verdict: CardVerdict;
  sp: number | null;
  base: number | null;
  multiplier: number | null;
  current: StatsSnapshot;
  before: StatsSnapshot | null;
};

type Props = {
  kind: "duel" | "solo";
  sourceId: string;
  player: string;
};

async function fetchSPEarned(
  kind: "duel" | "solo",
  sourceId: string,
  player: string,
): Promise<SPEarnedDTO> {
  const qs = new URLSearchParams({ kind, id: sourceId, player });
  const res = await fetch(apiUrl(`/api/sp-earned?${qs.toString()}`));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as SPEarnedDTO;
}

function progressPct(snap: StatsSnapshot): number {
  const { progress, totalSp } = snap;
  if (progress.next === null) return 100;
  const span = progress.next - progress.currentLevelMinSP;
  if (span <= 0) return 100;
  const filled = totalSp - progress.currentLevelMinSP;
  return Math.max(0, Math.min(100, (filled / span) * 100));
}

export function SPEarnedCard({ kind, sourceId, player }: Props) {
  const { data, isError, isLoading, refetch } = useQuery<SPEarnedDTO>({
    queryKey: ["sp-earned", kind, sourceId, player.toLowerCase()],
    queryFn: () => fetchSPEarned(kind, sourceId, player),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  // Single retry after 5s if the verdict is still pending (same cadence as
  // the anti-cheat badge — Haiku typically lands inside that window).
  useEffect(() => {
    if (data?.verdict !== "pending") return;
    const t = setTimeout(() => refetch(), 5000);
    return () => clearTimeout(t);
  }, [data, refetch]);

  if (isError) return null;
  if (isLoading || !data) return null;

  // ─── pending ────────────────────────────────────────────────────────────
  if (data.verdict === "pending") {
    return (
      <section className="rounded-2xl border border-border bg-bg-elev p-5">
        <p className="text-[11px] uppercase tracking-widest text-neutral-500">
          Skill Points
        </p>
        <div className="mt-3 flex items-center gap-2 text-sm text-neutral-400">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-skill/70" />
          SP pending AI review…
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          Anti-cheat audit typically lands in 5 seconds. This card will update.
        </p>
      </section>
    );
  }

  const sp = data.sp ?? 0;
  const verdictLabel = data.verdict; // plausible | suspicious | implausible
  const isImplausible = data.verdict === "implausible";
  const eventLabel = eventCopy(data.eventKind, data.kind);
  const leveledUp =
    data.before !== null &&
    data.before.currentLevel < data.current.currentLevel;

  return (
    <section className="rounded-2xl border border-border bg-bg-elev p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-[11px] uppercase tracking-widest text-neutral-500">
          Skill Points
        </p>
        <Link
          href={`/profile/${data.player}`}
          className="text-[11px] text-neutral-500 underline-offset-4 hover:text-skill hover:underline"
        >
          View profile →
        </Link>
      </div>

      <div className="mt-3 flex items-baseline gap-3">
        <p
          className={
            "text-3xl font-semibold tabular-nums " +
            (isImplausible
              ? "text-neutral-500"
              : sp >= 100
                ? "text-skill"
                : "text-neutral-100")
          }
        >
          {isImplausible ? "+0" : `+${sp}`} SP
        </p>
        {isImplausible ? (
          <span
            className="rounded bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400"
            title="Anti-cheat flagged this run — no SP awarded."
          >
            flagged
          </span>
        ) : (
          <span className="text-xs text-neutral-500">
            base {data.base ?? 0} × {(data.multiplier ?? 1).toFixed(1)}{" "}
            <span
              className={
                verdictLabel === "plausible"
                  ? "text-neutral-500"
                  : "text-amber-400"
              }
            >
              {verdictLabel}
            </span>
          </span>
        )}
      </div>

      {eventLabel && (
        <p className="mt-1 text-xs text-neutral-500">{eventLabel}</p>
      )}

      {!isImplausible && (
        <>
          <div className="mt-4 flex items-center gap-3">
            <div className="min-w-[52px] text-left">
              {leveledUp && data.before ? (
                <p className="text-sm text-neutral-300">
                  <span className="text-neutral-500 line-through">
                    L{data.before.currentLevel}
                  </span>{" "}
                  <span className="font-semibold text-skill">
                    → L{data.current.currentLevel}
                  </span>
                </p>
              ) : (
                <p className="text-sm font-semibold text-neutral-200">
                  Level {data.current.currentLevel}
                </p>
              )}
            </div>
            <div className="flex-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-elev2">
                <div
                  className="h-full rounded-full bg-skill transition-[width] duration-700 ease-out"
                  style={{ width: `${progressPct(data.current)}%` }}
                />
              </div>
              <p className="mt-1.5 text-[11px] tabular-nums text-neutral-500">
                {data.current.totalSp.toLocaleString()} /{" "}
                {data.current.progress.next === null
                  ? "MAX"
                  : data.current.progress.next.toLocaleString()}{" "}
                SP
              </p>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function eventCopy(
  eventKind: EventKind | null,
  kind: "duel" | "solo",
): string {
  if (eventKind === "duel_win") return "Duel win";
  if (eventKind === "duel_loss") return "Duel loss";
  if (eventKind === "solo_submit") return "Solo submission";
  if (kind === "duel") return "Duel — walkover, no submit";
  return "";
}
