/**
 * Compatibility adapter: legacy game score submission → EvidenceEnvelope.
 * Does NOT change public score APIs or TournamentPool (ADR 0005 D6).
 *
 * Provenance digests are either supplied by the caller or computed
 * deterministically from the submission (no zero-digest placeholders).
 * Seeds are never written to codeCommit.
 */

import { digestJsonValue, digestManifest } from "../digest.js";
import { parseProtocolNumberInput } from "../numbers.js";
import {
  type BenchmarkManifest,
  type EvidenceEnvelope,
  type Subject,
  PROTOCOL_VERSION,
  ProtocolError,
} from "../types.js";

/**
 * Minimal legacy score shape (adapter input only — not a protocol document).
 */
export interface LegacyGameScoreSubmission {
  tournamentId: string;
  player: string;
  /** Must parse to a protocol-safe number (fail-closed). */
  score: string | number;
  /** Optional; when present must be protocol-safe number. */
  matchCountDelta?: string | number;
  nonce?: string;
  gameId?: string;
  /** Included in deterministic inputDigest only — never mapped to codeCommit. */
  seed?: string;
  createdAt?: string;
  /** Optional public artifact digest (must be valid format if set). */
  replayDigest?: string;
}

export interface AdaptGameScoreOptions {
  evidenceId: string;
  manifest?: BenchmarkManifest;
  subject?: Partial<Subject>;
  signature?: string;
  /**
   * Provenance configDigest. When omitted, computed as Digest(JCS({
   *   adapter: "legacy-game-score", adapterVersion: "0.1.0", gameId
   * })).
   */
  configDigest?: string;
  /**
   * Provenance inputDigest. When omitted, computed as Digest(JCS(normalized submission input)).
   */
  inputDigest?: string;
  /** Manifest inputSchemaHash. When omitted, digest of adapter input schema descriptor. */
  inputSchemaHash?: string;
  /** Evaluator digest pin. When omitted, digest of evaluator identity object. */
  evaluatorDigest?: string;
  /** Optional git/code commit — must not be used to smuggle seeds. */
  codeCommit?: string;
}

async function defaultInputSchemaHash(gameId: string): Promise<string> {
  return digestJsonValue({
    kind: "legacy-game-score-input",
    gameId,
    fields: ["tournamentId", "player", "score", "matchCountDelta", "nonce", "seed"],
  });
}

async function defaultEvaluatorDigest(gameId: string): Promise<string> {
  return digestJsonValue({
    id: `game.${gameId}.score-adapter`,
    version: "0.1.0",
  });
}

/**
 * Build a domain-neutral BenchmarkManifest for a legacy game score fixture.
 * Digests must be real (caller supplies or uses buildGameScoreManifestAsync).
 */
export function buildGameScoreManifest(
  gameId: string,
  opts: {
    inputSchemaHash: string;
    evaluatorDigest: string;
    benchmarkVersion?: string;
  },
): BenchmarkManifest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    benchmarkId: `game.${gameId}`,
    benchmarkVersion: opts.benchmarkVersion ?? "0.1.0",
    taskType: `game.${gameId}`,
    inputSchemaHash: opts.inputSchemaHash,
    evaluator: {
      id: `game.${gameId}.score-adapter`,
      version: "0.1.0",
      digest: opts.evaluatorDigest,
    },
    measurements: [
      {
        id: "score",
        name: "Game score",
        unit: "points",
        higherIsBetter: true,
        required: true,
        valueType: "number",
      },
      {
        id: "match_count_delta",
        name: "Match count delta",
        higherIsBetter: true,
        required: false,
        valueType: "number",
      },
    ],
    hardFailureRules: ["invalid_score"],
  };
}

/** Async helper that fills real digests when building a default manifest. */
export async function buildGameScoreManifestAsync(
  gameId: string,
  opts?: {
    inputSchemaHash?: string;
    evaluatorDigest?: string;
    benchmarkVersion?: string;
  },
): Promise<BenchmarkManifest> {
  const inputSchemaHash =
    opts?.inputSchemaHash ?? (await defaultInputSchemaHash(gameId));
  const evaluatorDigest =
    opts?.evaluatorDigest ?? (await defaultEvaluatorDigest(gameId));
  return buildGameScoreManifest(gameId, {
    inputSchemaHash,
    evaluatorDigest,
    benchmarkVersion: opts?.benchmarkVersion,
  });
}

function normalizedInputPayload(
  submission: LegacyGameScoreSubmission,
  score: number,
  matchCountDelta: number | undefined,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    tournamentId: submission.tournamentId,
    player: submission.player,
    score,
    gameId: submission.gameId ?? "2048",
  };
  if (matchCountDelta !== undefined) {
    payload.matchCountDelta = matchCountDelta;
  }
  if (submission.nonce !== undefined) {
    payload.nonce = submission.nonce;
  }
  if (submission.seed !== undefined) {
    payload.seed = submission.seed;
  }
  return payload;
}

/**
 * Map a legacy game score submission to EvidenceEnvelope (+ resolved manifest).
 */
export async function adaptGameScoreToEvidence(
  submission: LegacyGameScoreSubmission,
  options: AdaptGameScoreOptions,
): Promise<{ manifest: BenchmarkManifest; evidence: EvidenceEnvelope }> {
  const gameId = submission.gameId ?? "2048";

  const score = parseProtocolNumberInput(submission.score, "score");
  let matchCountDelta: number | undefined;
  if (submission.matchCountDelta !== undefined) {
    matchCountDelta = parseProtocolNumberInput(
      submission.matchCountDelta,
      "matchCountDelta",
    );
  }

  const manifest =
    options.manifest ??
    (await buildGameScoreManifestAsync(gameId, {
      inputSchemaHash: options.inputSchemaHash,
      evaluatorDigest: options.evaluatorDigest,
    }));

  const manifestDigest = await digestManifest(manifest);

  const configDigest =
    options.configDigest ??
    (await digestJsonValue({
      adapter: "legacy-game-score",
      adapterVersion: "0.1.0",
      gameId,
    }));

  const inputDigest =
    options.inputDigest ??
    (await digestJsonValue(
      normalizedInputPayload(submission, score, matchCountDelta),
    ));

  if (options.codeCommit !== undefined && submission.seed !== undefined) {
    // Explicit policy: never allow callers to believe seed maps to codeCommit.
    // They may set both independently, but seed is only in inputDigest material.
  }

  const measurements: Record<string, number> = { score };
  if (matchCountDelta !== undefined) {
    measurements.match_count_delta = matchCountDelta;
  }

  const evidence: EvidenceEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    evidenceId: options.evidenceId,
    manifestDigest,
    subject: {
      type: options.subject?.type ?? "human",
      id: options.subject?.id ?? submission.player,
      version: options.subject?.version ?? "1",
    },
    provenance: {
      configDigest,
      inputDigest,
      ...(options.codeCommit !== undefined
        ? { codeCommit: options.codeCommit }
        : {}),
    },
    artifacts: submission.replayDigest
      ? [
          {
            mediaType: "application/vnd.skillos.game-replay+json",
            digest: submission.replayDigest,
            availability: "redacted",
            role: "replay",
          },
        ]
      : [],
    metrics: {
      score,
      tournamentId: submission.tournamentId,
      ...(submission.nonce !== undefined ? { nonce: submission.nonce } : {}),
    },
    measurements,
    createdAt: submission.createdAt ?? new Date().toISOString(),
    ...(options.signature !== undefined
      ? { signature: options.signature }
      : {}),
  };

  // Guard against accidental seed→codeCommit mapping in adapter output.
  if (
    submission.seed !== undefined &&
    evidence.provenance.codeCommit === `seed:${submission.seed}`
  ) {
    throw new ProtocolError(
      "INVALID_INPUT",
      "adapter must not place seed into codeCommit",
    );
  }

  return { manifest, evidence };
}
