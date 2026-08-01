/**
 * Deterministic golden fixture generator — real digests only (no zero placeholders).
 * Run from package dir: npx tsx scripts/build-fixtures.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  adaptGameScoreToEvidence,
  digestEvidence,
  digestJsonValue,
  digestManifest,
  digestResult,
  digestVerifier,
  PROTOCOL_VERSION,
  type BenchmarkManifest,
  type EvidenceEnvelope,
  type VerificationResult,
  type VerifierDescriptor,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

async function sealResult(
  partial: Omit<
    VerificationResult,
    | "resultDigest"
    | "manifestDigest"
    | "evidenceDigest"
    | "verifierDigest"
    | "protocolVersion"
  >,
  ctx: {
    manifest: BenchmarkManifest;
    evidence: EvidenceEnvelope;
    verifier: VerifierDescriptor;
  },
): Promise<VerificationResult> {
  const base: Omit<VerificationResult, "resultDigest"> = {
    protocolVersion: PROTOCOL_VERSION,
    evidenceId: partial.evidenceId,
    manifestDigest: await digestManifest(ctx.manifest),
    evidenceDigest: await digestEvidence(ctx.evidence),
    verifierId: partial.verifierId,
    verifierVersion: partial.verifierVersion,
    verifierDigest: ctx.verifier.digest,
    status: partial.status,
    disqualifications: partial.disqualifications,
    measurements: partial.measurements,
    verifiedAt: partial.verifiedAt,
    ...(partial.signature !== undefined ? { signature: partial.signature } : {}),
  };
  return { ...base, resultDigest: await digestResult(base as VerificationResult) };
}

function write(rel: string, data: unknown) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log("wrote", rel);
}

async function main() {
  // ── Verifier (with required protocolVersion) ──────────────────────────
  const verifierBody: Omit<VerifierDescriptor, "digest"> = {
    protocolVersion: PROTOCOL_VERSION,
    id: "skillos.deterministic.v1",
    version: "0.1.0",
    capabilities: ["deterministic"],
  };
  const verifier: VerifierDescriptor = {
    ...verifierBody,
    digest: await digestVerifier(verifierBody),
  };
  write("fixtures/shared/verifier.json", verifier);

  // Synthetic replay artifact payload → real digest
  const replayDigest = await digestJsonValue({
    kind: "redacted-replay",
    gameId: "2048",
    note: "fixture-no-raw-frames",
  });

  // ── Game 2048 ─────────────────────────────────────────────────────────
  const { manifest: gameManifest, evidence: gameEvidence } =
    await adaptGameScoreToEvidence(
      {
        tournamentId:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        player: "0x2222222222222222222222222222222222222222",
        score: 4820,
        matchCountDelta: 1,
        nonce:
          "0x3333333333333333333333333333333333333333333333333333333333333333",
        gameId: "2048",
        seed: "fixture-seed-2048",
        createdAt: "2026-08-01T12:00:00.000Z",
        replayDigest,
      },
      {
        evidenceId: "01jgame2048fixture0000000001",
        signature: "test-sig-game-2048",
        // optional explicit codeCommit distinct from seed
        codeCommit: "fixture-tree-game-2048",
      },
    );

  const gameResult = await sealResult(
    {
      evidenceId: gameEvidence.evidenceId,
      verifierId: verifier.id,
      verifierVersion: verifier.version,
      status: "verified",
      disqualifications: [],
      measurements: { score: 4820, match_count_delta: 1 },
      verifiedAt: "2026-08-01T12:00:01.000Z",
    },
    { manifest: gameManifest, evidence: gameEvidence, verifier },
  );

  write("fixtures/game-2048/manifest.json", gameManifest);
  write("fixtures/game-2048/evidence.json", gameEvidence);
  write("fixtures/game-2048/result.json", gameResult);
  write("fixtures/game-2048/arena.json", {
    protocolVersion: PROTOCOL_VERSION,
    arenaId: "arena.game.2048",
    arenaVersion: "0.1.0",
    category: "game",
    entry: "open",
    prizeSource: "none",
    format: "tournament_compat",
    verifier: {
      id: verifier.id,
      version: verifier.version,
      digest: verifier.digest,
    },
    resolution: "deterministic",
    capabilityAxes: ["score"],
    dataTier: "public",
    dataRights: "public_evidence_digests_only",
    taskBinding: {
      benchmarkId: gameManifest.benchmarkId,
      adapterId: "legacy-game-score",
    },
  });

  // ── Simpl3 safety (synthetic, redacted) — real digests ────────────────
  const envResource = await digestJsonValue({
    kind: "simpl3-safety-env",
    cpu: "synthetic",
    memMb: 512,
  });
  const envNetwork = await digestJsonValue({
    kind: "simpl3-safety-network",
    policy: "deny-all-egress",
  });
  const inputSchemaHash = await digestJsonValue({
    kind: "simpl3.safety.offline.input-schema",
    version: "0.1.0",
  });
  const evaluatorDigest = await digestJsonValue({
    id: "simpl3.safety.offline-evaluator",
    version: "0.1.0",
  });
  const datasetDigest = await digestJsonValue({
    suite: "synthetic-safety-suite-v1",
    scenarios: ["offline-refuse-execute"],
  });
  const configDigest = await digestJsonValue({
    runner: "simpl3-offline-eval",
    version: "0.1.0",
    mode: "read-propose-only",
  });
  const inputDigest = await digestJsonValue({
    scenarioId: "offline-refuse-execute",
    frozenFixtures: true,
  });
  const toolCatalogDigest = await digestJsonValue({
    tools: ["read", "propose"],
    execute: false,
  });
  const toolTraceDigest = await digestJsonValue({
    availability: "redacted",
    steps: 3,
    note: "raw trace not in public evidence",
  });

  const safetyManifest: BenchmarkManifest = {
    protocolVersion: PROTOCOL_VERSION,
    benchmarkId: "simpl3.safety.offline",
    benchmarkVersion: "0.1.0",
    taskType: "simpl3.safety.offline",
    inputSchemaHash,
    evaluator: {
      id: "simpl3.safety.offline-evaluator",
      version: "0.1.0",
      digest: evaluatorDigest,
    },
    environment: {
      resourceDigest: envResource,
      networkPolicyDigest: envNetwork,
    },
    measurements: [
      {
        id: "policy_pass",
        name: "Policy pass rate",
        unit: "ratio",
        higherIsBetter: true,
        required: true,
        valueType: "number",
      },
      {
        id: "tool_boundary_ok",
        name: "Tool boundary respected",
        required: true,
        valueType: "boolean",
      },
      {
        id: "scenario_id",
        name: "Scenario identifier",
        required: false,
        valueType: "string",
      },
    ],
    hardFailureRules: ["execute_attempt", "secret_exfiltration"],
    dataset: { digest: datasetDigest, id: "synthetic-safety-suite-v1" },
  };

  const safetyManifestDigest = await digestManifest(safetyManifest);
  const safetyEvidence: EvidenceEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    evidenceId: "01jsimpl3safetyfixture000001",
    manifestDigest: safetyManifestDigest,
    subject: {
      type: "agent",
      id: "eval-agent-safety-pilot-001",
      version: "0.1.0",
    },
    provenance: {
      codeCommit: "synthetic-fixture-tree",
      configDigest,
      inputDigest,
      toolCatalogDigest,
      modelId: "eval-model-stub",
    },
    artifacts: [
      {
        mediaType: "application/vnd.skillos.tool-trace+json",
        digest: toolTraceDigest,
        availability: "redacted",
        role: "tool_trace",
      },
    ],
    metrics: {
      policy_pass: 1,
      tool_boundary_ok: true,
    },
    measurements: {
      policy_pass: 1,
      tool_boundary_ok: true,
      scenario_id: "offline-refuse-execute",
    },
    createdAt: "2026-08-01T12:30:00.000Z",
    signature: "test-sig-simpl3-safety",
  };

  const safetyResult = await sealResult(
    {
      evidenceId: safetyEvidence.evidenceId,
      verifierId: verifier.id,
      verifierVersion: verifier.version,
      status: "verified",
      disqualifications: [],
      measurements: { policy_pass: 1, tool_boundary_ok: 1 },
      verifiedAt: "2026-08-01T12:30:01.000Z",
    },
    { manifest: safetyManifest, evidence: safetyEvidence, verifier },
  );

  write("fixtures/simpl3-safety/manifest.json", safetyManifest);
  write("fixtures/simpl3-safety/evidence.json", safetyEvidence);
  write("fixtures/simpl3-safety/result.json", safetyResult);
  write("fixtures/simpl3-safety/arena.json", {
    protocolVersion: PROTOCOL_VERSION,
    arenaId: "arena.simpl3.safety",
    arenaVersion: "0.1.0",
    category: "agent_eval",
    entry: "agent-only",
    prizeSource: "none",
    format: "single_attempt",
    verifier: {
      id: verifier.id,
      version: verifier.version,
      digest: verifier.digest,
    },
    resolution: "deterministic",
    capabilityAxes: ["policy_pass", "tool_boundary_ok"],
    dataTier: "restricted",
    dataRights: "redacted_public_evidence_private_traces",
    taskBinding: {
      benchmarkId: safetyManifest.benchmarkId,
      adapterId: "simpl3-offline-eval",
    },
  });

  console.log("fixtures ok");
  console.log("game manifestDigest", await digestManifest(gameManifest));
  console.log("game evidenceDigest", await digestEvidence(gameEvidence));
  console.log("safety manifestDigest", safetyManifestDigest);
  console.log("seed not in codeCommit", gameEvidence.provenance.codeCommit);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
