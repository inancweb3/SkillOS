"use client";

// ───────────────────────────────────────────────────────────────────────────
// AIRecap — post-match shareable narrative card. Renders for both duel
// and solo.
//
// Duel:
//   Fetches POST /api/duel/[matchId]/recap. Share link deep-links to the
//   duel result page.
//
// Solo (context="solo"):
//   Fetches POST /api/tournaments/solo/[matchId]/recap. Share link points
//   at the solo tournament page (no per-run deep link exists yet — can be
//   upgraded in a later sprint without changing this contract).
//
// The recap endpoint response shape is identical across duel and solo, so
// this component renders both without a mapping layer. The only branching
// is the endpoint path and the share-URL shape.
//
// States:
//   • loading — headline/body skeleton
//   • ready   — headline + narrative + 3 share buttons + (optional) style pill
//   • error   — return null (the recap card vanishes; result page still works)
//
// Error handling nuance:
//   The endpoint uses the "soft-error" convention (HTTP 200 with { error }),
//   so we check the parsed body and throw so useQuery flips isError.
// ───────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { RecapResponse, RecapStyle } from "@skillos/ai-coach";
import { apiUrl, RECAP_MODEL_DISPLAY } from "@skillos/ui";

type Props = {
  matchId: string;
  context?: "duel" | "solo";
};

// URL base for share links. Reads NEXT_PUBLIC_URL so Vercel/env drives
// the production domain; falls back to the canonical subdomain so the
// card still links correctly when env is missing (e.g. local dev).
// Fallback is the one line that differs across the 6 app copies.
const URL_BASE =
  process.env.NEXT_PUBLIC_URL ?? "https://2048.skillos.games";

async function fetchRecap(
  matchId: string,
  context: "duel" | "solo",
): Promise<RecapResponse> {
  const url =
    context === "solo"
      ? `/api/tournaments/solo/${matchId}/recap`
      : `/api/duel/${matchId}/recap`;
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = (await res.json()) as RecapResponse | { error: string };
  if ("error" in body) throw new Error(body.error);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return body;
}

// Style → pill label + color. "standard" is intentionally absent: its badge
// is suppressed (see `data.style !== "standard"` guard below).
const STYLE_PILL: Record<
  Exclude<RecapStyle, "standard">,
  { label: string; cls: string }
> = {
  comeback: {
    label: "Comeback",
    cls: "border-green-500/40 text-green-300",
  },
  blowout: {
    label: "Blowout",
    cls: "border-red-500/40 text-red-300",
  },
  nailBiter: {
    label: "Nail-biter",
    cls: "border-orange-500/40 text-orange-300",
  },
  speedRun: {
    label: "Speed run",
    cls: "border-blue-500/40 text-blue-300",
  },
  grind: {
    label: "Grind",
    cls: "border-purple-500/40 text-purple-300",
  },
};

export function AIRecap({ matchId, context = "duel" }: Props) {
  const { data, isLoading, isError } = useQuery<RecapResponse>({
    queryKey: ["recap", context, matchId],
    queryFn: () => fetchRecap(matchId, context),
    // Cached server-side. Once we have a recap, it's permanent for the match.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });

  const [copied, setCopied] = useState(false);

  // Recap is an enhancement — if anything goes wrong, disappear silently.
  if (isError) return null;

  // Duel deep-links per match; solo currently has no per-run page, so we
  // link to the tournament landing — viewers click through and play solo
  // themselves. Keeps the share loop intact even without a deep link.
  const shareTargetUrl =
    context === "solo"
      ? `${URL_BASE}/tournament/solo`
      : `${URL_BASE}/duel/${matchId}/result`;
  const populatedShareText = data
    ? data.shareText.replace("{url}", shareTargetUrl)
    : "";

  const shareToX = () => {
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(populatedShareText)}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const shareToFarcaster = () => {
    window.open(
      `https://warpcast.com/~/compose?text=${encodeURIComponent(populatedShareText)}&embeds[]=${encodeURIComponent(shareTargetUrl)}`,
      "_blank",
      "noopener,noreferrer",
    );
  };

  const copyShareText = async () => {
    try {
      await navigator.clipboard.writeText(populatedShareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (insecure context / old browser). No new
      // toast library per spec — just degrade silently; the other two share
      // paths (X, Farcaster) still work.
    }
  };

  return (
    <div className="rounded-2xl border border-skill/60 bg-bg-elev p-6">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
          ⚡ Match Recap
        </p>
        {data && data.style !== "standard" && (
          <span
            className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider ${STYLE_PILL[data.style].cls}`}
          >
            {STYLE_PILL[data.style].label}
          </span>
        )}
      </div>

      <div className="mt-4 min-h-[120px]">
        {isLoading && (
          <div className="space-y-3" aria-live="polite" aria-busy="true">
            <div className="h-7 w-10/12 animate-pulse rounded bg-neutral-700/60" />
            <div className="mt-2 h-3 w-full animate-pulse rounded bg-neutral-700/60" />
            <div className="h-3 w-11/12 animate-pulse rounded bg-neutral-700/60" />
            <p className="pt-1 text-xs text-neutral-500">Writing the recap…</p>
          </div>
        )}

        {data && (
          <>
            <h2 className="text-2xl font-bold leading-tight text-neutral-50 sm:text-3xl">
              {data.headline}
            </h2>
            <p className="mt-3 text-base leading-relaxed text-neutral-300">
              {data.narrative}
            </p>
          </>
        )}
      </div>

      {data && (
        <div className="mt-5 flex items-center gap-2">
          <ShareButton onClick={shareToX} label="Share on X">
            <XIcon />
          </ShareButton>
          <ShareButton onClick={shareToFarcaster} label="Cast on Farcaster">
            <span className="text-[10px] font-extrabold tracking-tighter">
              FC
            </span>
          </ShareButton>
          <ShareButton
            onClick={copyShareText}
            label="Copy share text"
            feedback={copied ? "Copied!" : null}
          >
            <CopyIcon />
          </ShareButton>
        </div>
      )}

      <p className="mt-4 text-[10px] tracking-wider text-neutral-600">
        Powered by {RECAP_MODEL_DISPLAY}
      </p>
    </div>
  );
}

function ShareButton({
  children,
  onClick,
  label,
  feedback,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  feedback?: string | null;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-bg-elev2 text-neutral-300 transition-colors hover:border-skill/60 hover:text-skill"
      >
        {children}
      </button>
      {feedback && (
        <span className="pointer-events-none absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-200">
          {feedback}
        </span>
      )}
    </div>
  );
}

function XIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width="14"
      height="14"
      aria-hidden
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="14"
      height="14"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
