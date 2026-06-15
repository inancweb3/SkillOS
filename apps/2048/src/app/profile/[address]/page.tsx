"use client";;
import { use } from "react";

// ───────────────────────────────────────────────────────────────────────────
// Global profile page — any address, no auth gate. Jury-visible surface for
// the SP + Level thesis: "this platform has a continuous progression system,
// not just one-shot prizes."
//
// Data shape matches the ProfileDTO from @skillos/duel-backend. Pure read;
// no mutations here.
// ───────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AddressDisplay, apiUrl, basescanAddress } from "@skillos/ui";

type Verdict = "plausible" | "suspicious" | "implausible";

type ActivityRow =
  | {
      kind: "duel";
      at: string;
      sp: number;
      result: "win" | "loss";
      verdict: Verdict;
      duelId: string;
      opponentAddress: string;
    }
  | {
      kind: "solo";
      at: string;
      sp: number;
      verdict: Verdict;
      runId: string;
      tournamentId: string;
      game: string;
    };

type ProfileDTO = {
  address: string;
  stats: {
    totalSp: number;
    currentLevel: number;
    duelsWon: number;
    duelsLost: number;
    tournamentsParticipated: number;
    tournamentsWon: number;
    lastActiveAt: string;
    createdAt: string;
  } | null;
  progress: {
    next: number | null;
    remaining: number;
    currentLevelMinSP: number;
  };
  activity: ActivityRow[];
};

async function fetchProfile(address: string): Promise<ProfileDTO> {
  const res = await fetch(apiUrl(`/api/profile/${address}`), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export default function ProfilePage(
  props: {
    params: Promise<{ address: string }>;
  }
) {
  const params = use(props.params);
  const { data, isLoading, error } = useQuery({
    queryKey: ["profile", params.address.toLowerCase()],
    queryFn: () => fetchProfile(params.address),
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
        <p className="text-sm text-red-400">
          {error instanceof Error ? error.message : "Failed to load profile."}
        </p>
      </main>
    );
  }

  const { address, stats, progress, activity } = data;
  const totalSp = stats?.totalSp ?? 0;
  const level = stats?.currentLevel ?? 1;

  // Progress bar: (totalSp - currentMin) / (next - currentMin). At L10 (next=null)
  // it's always "full."
  const progressPct =
    progress.next === null
      ? 100
      : Math.max(
          0,
          Math.min(
            100,
            ((totalSp - progress.currentLevelMinSP) /
              (progress.next - progress.currentLevelMinSP)) *
              100,
          ),
        );

  return (
    <main className="py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href="/leaderboard"
          className="text-xs text-neutral-400 underline-offset-4 hover:text-neutral-200 hover:underline"
        >
          ← Leaderboard
        </Link>

        <section className="rounded-2xl border border-border bg-bg-elev p-6">
          <div className="flex items-baseline justify-between">
            <h1 className="font-mono text-lg tracking-tight">
              <AddressDisplay address={address} variant="stacked" />
            </h1>
            <a
              href={basescanAddress(address)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] uppercase tracking-widest text-neutral-500 hover:text-neutral-300"
            >
              Basescan ↗
            </a>
          </div>

          <div className="mt-5 flex items-end gap-5">
            <div>
              <p className="text-[11px] uppercase tracking-widest text-neutral-500">
                Level
              </p>
              <p className="mt-1 text-4xl font-semibold tabular-nums text-skill">
                {level}
              </p>
            </div>
            <div className="flex-1 pb-1">
              <div className="h-2 w-full overflow-hidden rounded-full bg-bg-elev2">
                <div
                  className="h-full rounded-full bg-skill transition-[width] duration-500"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <p className="mt-2 text-xs tabular-nums text-neutral-400">
                {totalSp.toLocaleString()} /{" "}
                {progress.next === null
                  ? "MAX"
                  : progress.next.toLocaleString()}{" "}
                SP
                {progress.next !== null && (
                  <span className="text-neutral-600">
                    {" "}
                    · {progress.remaining.toLocaleString()} to Level{" "}
                    {level + 1}
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCell label="Total SP" value={totalSp.toLocaleString()} accent />
            <StatCell
              label="Duels W / L"
              value={`${stats?.duelsWon ?? 0} / ${stats?.duelsLost ?? 0}`}
            />
            <StatCell
              label="Tournaments"
              value={String(stats?.tournamentsParticipated ?? 0)}
            />
            <StatCell
              label="Tournaments Won"
              value={String(stats?.tournamentsWon ?? 0)}
            />
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-bg-elev p-6">
          <h2 className="text-[11px] uppercase tracking-widest text-neutral-500">
            Recent SP activity
          </h2>
          {activity.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-border p-6 text-center text-sm text-neutral-500">
              {stats === null
                ? "No activity yet — play a solo run or a duel to earn SP."
                : "No recent SP events."}
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-border-subtle">
              {activity.map((row, i) => (
                <li
                  key={`${row.kind}-${row.kind === "duel" ? row.duelId : row.runId}-${i}`}
                  className="flex items-center justify-between py-2.5 text-sm"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={
                        "inline-block w-12 text-right font-mono tabular-nums " +
                        (row.sp === 0
                          ? "text-neutral-500"
                          : row.sp >= 100
                            ? "text-skill"
                            : "text-neutral-200")
                      }
                    >
                      {row.sp === 0 ? "+0" : `+${row.sp}`}
                    </span>
                    <span className="text-neutral-200">
                      {row.kind === "duel"
                        ? row.result === "win"
                          ? "Duel win"
                          : "Duel loss"
                        : `Solo · ${row.game}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-neutral-500">
                    <span>{formatRelative(row.at)}</span>
                    <span
                      className={
                        row.verdict === "plausible"
                          ? "text-neutral-600"
                          : row.verdict === "suspicious"
                            ? "text-amber-400"
                            : "text-red-400"
                      }
                    >
                      {row.verdict}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function StatCell({
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
          "mt-1 text-base font-semibold tabular-nums " +
          (accent ? "text-skill" : "text-neutral-100")
        }
      >
        {value}
      </p>
    </div>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
