import { PROTOCOL_VERSION, type EvidenceEnvelope } from "@skillos/protocol";
import { BundleConsumerError } from "./errors.js";
import {
  EVAL_BUNDLE_PRODUCER_ID,
  EVAL_BUNDLE_VERSION,
  type OfflineEvalBundleBody,
} from "./types.js";

/** Protocol digest string: `sha256:` + 64 lowercase hex chars. */
export function isValidDigestString(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * Pin supported versions and require producer identity/coherence with
 * provenance + evidence already carried by the body.
 *
 * Does not invent trust in operator-supplied codeCommit — only enforces that
 * producer fields agree with evidence/provenance fields already inside the document.
 */
export function assertBundleIdentityCoherence(
  body: OfflineEvalBundleBody,
): void {
  if (body.bundleVersion !== EVAL_BUNDLE_VERSION) {
    throw new BundleConsumerError(
      "BUNDLE_VERSION_UNSUPPORTED",
      `unsupported bundleVersion ${JSON.stringify(body.bundleVersion)}; expected ${EVAL_BUNDLE_VERSION}`,
    );
  }
  if (body.protocolVersion !== PROTOCOL_VERSION) {
    throw new BundleConsumerError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      `unsupported protocolVersion ${JSON.stringify(body.protocolVersion)}; expected ${PROTOCOL_VERSION}`,
    );
  }

  if (body.producer?.id !== EVAL_BUNDLE_PRODUCER_ID) {
    throw new BundleConsumerError(
      "PRODUCER_ID_INVALID",
      `producer.id must be ${EVAL_BUNDLE_PRODUCER_ID}; got ${JSON.stringify(body.producer?.id)}`,
    );
  }

  const producerCommit = body.producer.codeCommit;
  if (
    typeof producerCommit !== "string" ||
    producerCommit.length === 0 ||
    producerCommit !== body.provenance.codeCommit
  ) {
    throw new BundleConsumerError(
      "PRODUCER_COHERENCE",
      "producer.codeCommit must equal provenance.codeCommit",
    );
  }
  const evidenceCommit = body.evidence.provenance?.codeCommit;
  if (producerCommit !== evidenceCommit) {
    throw new BundleConsumerError(
      "PRODUCER_COHERENCE",
      "producer.codeCommit must equal evidence.provenance.codeCommit",
    );
  }

  const producerVersion = body.producer.version;
  if (typeof producerVersion !== "string" || producerVersion.length === 0) {
    throw new BundleConsumerError(
      "PRODUCER_COHERENCE",
      "producer.version must be a non-empty string",
    );
  }
  if (producerVersion !== body.evidence.subject?.version) {
    throw new BundleConsumerError(
      "PRODUCER_COHERENCE",
      "producer.version must equal evidence.subject.version",
    );
  }
  if (producerVersion !== body.manifest.evaluator?.version) {
    throw new BundleConsumerError(
      "PRODUCER_COHERENCE",
      "producer.version must equal manifest.evaluator.version",
    );
  }
  if (body.manifest.evaluator?.id !== EVAL_BUNDLE_PRODUCER_ID) {
    throw new BundleConsumerError(
      "PRODUCER_COHERENCE",
      `manifest.evaluator.id must equal producer id ${EVAL_BUNDLE_PRODUCER_ID}`,
    );
  }
}

/**
 * Bundle-only coherence of inputDigest claims (no private preimage).
 */
export function assertPortableInputDigestCoherence(
  provenance: { inputDigest?: unknown },
  evidence: EvidenceEnvelope,
): void {
  const top = provenance?.inputDigest;
  if (!isValidDigestString(top)) {
    throw new BundleConsumerError(
      "INPUT_DIGEST_INVALID",
      `provenance.inputDigest must be a valid sha256 digest string; got ${JSON.stringify(top)}`,
    );
  }
  const nested = evidence.provenance?.inputDigest;
  if (!isValidDigestString(nested)) {
    throw new BundleConsumerError(
      "INPUT_DIGEST_INVALID",
      `evidence.provenance.inputDigest must be a valid sha256 digest string; got ${JSON.stringify(nested)}`,
    );
  }
  if (top !== nested) {
    throw new BundleConsumerError(
      "INPUT_DIGEST_MISMATCH",
      `provenance.inputDigest ${top} !== evidence.provenance.inputDigest ${nested}`,
    );
  }
}

/**
 * scenario.fixedNow must equal evidence.createdAt when identity is present.
 */
export function assertScenarioIdentityCoherence(
  body: OfflineEvalBundleBody,
): void {
  const fixedNow = body.scenario?.fixedNow;
  const createdAt = body.evidence?.createdAt;
  if (typeof fixedNow !== "string" || fixedNow.length === 0) {
    throw new BundleConsumerError(
      "SCENARIO_IDENTITY",
      "scenario.fixedNow must be a non-empty string",
    );
  }
  if (fixedNow !== createdAt) {
    throw new BundleConsumerError(
      "SCENARIO_IDENTITY",
      `scenario.fixedNow=${fixedNow} !== evidence.createdAt=${String(createdAt)}`,
    );
  }
}
