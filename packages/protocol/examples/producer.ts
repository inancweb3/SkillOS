/**
 * Minimal producer example — build evidence for a legacy game score.
 * Run: npx tsx examples/producer.ts
 */
import {
  adaptGameScoreToEvidence,
  parseAndValidateSchema,
  digestEvidence,
} from "../src/index.js";

const { manifest, evidence } = await adaptGameScoreToEvidence(
  {
    tournamentId:
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    player: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    score: 2048,
    gameId: "2048",
    createdAt: "2026-08-01T15:00:00.000Z",
  },
  { evidenceId: "example-producer-1" },
);

parseAndValidateSchema(manifest, "BenchmarkManifest");
parseAndValidateSchema(evidence, "EvidenceEnvelope");

const evidenceDigest = await digestEvidence(evidence);

console.log(
  JSON.stringify(
    {
      taskType: manifest.taskType,
      manifestDigest: evidence.manifestDigest,
      evidenceDigest,
      measurements: evidence.measurements,
    },
    null,
    2,
  ),
);
