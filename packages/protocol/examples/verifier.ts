/**
 * Minimal verifier example — bind evidence to manifest and emit a result.
 * Run: npx tsx examples/verifier.ts
 */
import {
  PROTOCOL_VERSION,
  adaptGameScoreToEvidence,
  assertDigestBinding,
  digestResult,
  digestVerifier,
  parseAndValidateSchema,
  type VerificationResult,
  type VerifierDescriptor,
} from "../src/index.js";

const verifierBody: Omit<VerifierDescriptor, "digest"> = {
  protocolVersion: PROTOCOL_VERSION,
  id: "example.deterministic",
  version: "0.1.0",
  capabilities: ["deterministic"],
};
const verifier: VerifierDescriptor = {
  ...verifierBody,
  digest: await digestVerifier(verifierBody),
};
parseAndValidateSchema(verifier, "VerifierDescriptor");

const { manifest, evidence } = await adaptGameScoreToEvidence(
  {
    tournamentId: "0x1",
    player: "0xplayer",
    score: 500,
    gameId: "2048",
    createdAt: "2026-08-01T15:00:00.000Z",
  },
  { evidenceId: "example-verify-1" },
);

await assertDigestBinding({
  manifest,
  evidence,
  verifier,
  checkMeasurements: true,
});

const score = Number(evidence.measurements?.score ?? 0);
const base: Omit<VerificationResult, "resultDigest"> = {
  protocolVersion: PROTOCOL_VERSION,
  evidenceId: evidence.evidenceId,
  manifestDigest: evidence.manifestDigest,
  evidenceDigest: await (await import("../src/index.js")).digestEvidence(
    evidence,
  ),
  verifierId: verifier.id,
  verifierVersion: verifier.version,
  verifierDigest: verifier.digest,
  status: score > 0 ? "verified" : "rejected",
  disqualifications: score > 0 ? [] : ["invalid_score"],
  measurements: { score },
  verifiedAt: "2026-08-01T15:00:01.000Z",
};

const result: VerificationResult = {
  ...base,
  resultDigest: await digestResult(base as VerificationResult),
};

parseAndValidateSchema(result, "VerificationResult");
await assertDigestBinding({ manifest, evidence, verifier, result });

console.log(
  JSON.stringify(
    {
      status: result.status,
      resultDigest: result.resultDigest,
      measurements: result.measurements,
    },
    null,
    2,
  ),
);
