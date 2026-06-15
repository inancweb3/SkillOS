"use client";

// ───────────────────────────────────────────────────────────────────────────
// AICoach — post-match feedback card. Renders for both duel and solo.
//
// Duel:
//   Fetches POST /api/duel/[matchId]/coach with { player } so the server
//   can determine the caller's slot (p1 vs p2). Tone badge always renders.
//
// Solo (context="solo"):
//   Fetches POST /api/tournaments/solo/[matchId]/coach with an empty body
//   (the runId alone identifies the single-slot cache). The solo prompt
//   enforces a strict 6-enum tone; on repeated enum violation it returns
//   tone="encouraging" as the hide-badge sentinel — in solo context we
//   SUPPRESS the tone badge when that sentinel is seen so the user isn't
//   shown a generic fallback label. Duel context keeps "encouraging" as
//   a first-class tone per its existing contract.
//
// States:
//   • loading  — skeleton lines + "Analyzing your match…"
//   • ready    — styled feedback card with tone badge (unless suppressed)
//   • error    — soft fallback message, no crash
// ───────────────────────────────────────────────────────────────────────────

import { useQuery } from "@tanstack/react-query";
import type { CoachResponse, CoachTone } from "@skillos/ai-coach";
import { apiUrl, COACH_MODEL_DISPLAY } from "@skillos/ui";

type DuelProps = {
  matchId: string;
  player: `0x${string}`;
  context?: "duel";
};
type SoloProps = {
  matchId: string;
  context: "solo";
  player?: `0x${string}`;
};
type Props = DuelProps | SoloProps;

async function fetchCoach(
  matchId: string,
  context: "duel" | "solo",
  player: string | undefined,
): Promise<CoachResponse> {
  const url =
    context === "solo"
      ? `/api/tournaments/solo/${matchId}/coach`
      : `/api/duel/${matchId}/coach`;
  const body = context === "solo" ? "{}" : JSON.stringify({ player });
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!res.ok) {
    // Surface the structured error body when available — helps debugging
    // without needing to crack the browser devtools network panel.
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.error) detail = `${body.error}: ${body.message ?? ""}`.trim();
    } catch {
      /* non-JSON error body; keep the HTTP-status detail. */
    }
    throw new Error(detail);
  }
  return (await res.json()) as CoachResponse;
}

// Tone → small-caps label + swatch color. Using border + text colors
// rather than fills so the badge sits inside the card without visual
// weight. Fallback to neutral for encouraging / unknown tones.
const TONE_STYLES: Record<CoachTone, { label: string; cls: string }> = {
  tactical: {
    label: "Tactical",
    cls: "border-yellow-500/40 text-yellow-300",
  },
  analytical: {
    label: "Analytical",
    cls: "border-blue-500/40 text-blue-300",
  },
  technique: {
    label: "Technique",
    cls: "border-purple-500/40 text-purple-300",
  },
  risk: {
    label: "Risk",
    cls: "border-orange-500/40 text-orange-300",
  },
  pacing: {
    label: "Pacing",
    cls: "border-green-500/40 text-green-300",
  },
  strategic: {
    label: "Strategic",
    cls: "border-indigo-500/40 text-indigo-300",
  },
  encouraging: {
    label: "Coach",
    cls: "border-neutral-500/40 text-neutral-300",
  },
};

export function AICoach(props: Props) {
  const { matchId } = props;
  const context = props.context ?? "duel";
  const player = context === "duel" ? props.player : undefined;

  const { data, isLoading, isError } = useQuery<CoachResponse>({
    queryKey: ["coach", context, matchId, player ?? null],
    queryFn: () => fetchCoach(matchId, context, player),
    // Cached server-side — once we have a response it won't change. No
    // point in refetching on focus, reconnect, or background intervals.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  // Solo context uses tone="encouraging" as a hide-badge sentinel when the
  // strict 6-enum prompt retries failed. Duel has no such sentinel — every
  // tone including "encouraging" renders its badge as today.
  const showToneBadge =
    !!data && !(context === "solo" && data.tone === "encouraging");

  return (
    <div className="rounded-2xl border border-border bg-bg-elev p-6">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
          🤖 AI Coach
        </p>
        {showToneBadge && data && (
          <span
            className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider ${TONE_STYLES[data.tone].cls}`}
          >
            {TONE_STYLES[data.tone].label}
          </span>
        )}
      </div>

      <div className="mt-4 min-h-[72px]">
        {isLoading && (
          <div className="space-y-2" aria-live="polite" aria-busy="true">
            <div className="h-3 w-11/12 animate-pulse rounded bg-neutral-700/60" />
            <div className="h-3 w-10/12 animate-pulse rounded bg-neutral-700/60" />
            <div className="h-3 w-7/12 animate-pulse rounded bg-neutral-700/60" />
            <p className="pt-2 text-xs text-neutral-500">
              Analyzing your match…
            </p>
          </div>
        )}

        {isError && (
          <p className="text-sm text-neutral-400">
            Coach unavailable. Try again later.
          </p>
        )}

        {data && (
          <p className="text-sm leading-relaxed text-neutral-200">
            {data.feedback}
          </p>
        )}
      </div>

      <p className="mt-4 text-[10px] tracking-wider text-neutral-600">
        Powered by {COACH_MODEL_DISPLAY}
      </p>
    </div>
  );
}
