import {
  canonicalize,
  digestJsonValue,
  type EvidenceEnvelope,
} from "@skillos/protocol";
import { BundleConsumerError } from "./errors.js";
import { redactDeep } from "./redaction.js";
import {
  BUNDLE_TOOL_TRACE_FIELDS,
  type BundleToolCallRecord,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate one toolTrace record without coercion.
 * Exact types only; missing/extra/exotic fields fail closed.
 */
function validateToolTraceRecord(
  raw: unknown,
  index: number,
): BundleToolCallRecord {
  if (!isPlainObject(raw)) {
    throw new BundleConsumerError(
      "TRACE_UNEXPECTED_FIELD",
      `toolTrace[${index}] must be a plain object`,
    );
  }

  // Reject accessor properties — only data descriptors with own values.
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(raw);
  } catch {
    throw new BundleConsumerError(
      "TRACE_UNEXPECTED_FIELD",
      `toolTrace[${index}] has unreadable property descriptors`,
    );
  }
  for (const [key, desc] of Object.entries(descriptors)) {
    if (desc.get !== undefined || desc.set !== undefined) {
      throw new BundleConsumerError(
        "TRACE_UNEXPECTED_FIELD",
        `toolTrace[${index}] field "${key}" must not be an accessor`,
      );
    }
  }

  const allowed = new Set<string>(BUNDLE_TOOL_TRACE_FIELDS);
  const keys = Object.keys(raw);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new BundleConsumerError(
        "TRACE_UNEXPECTED_FIELD",
        `toolTrace[${index}] has unexpected field "${key}" (allowlist: ${BUNDLE_TOOL_TRACE_FIELDS.join(", ")})`,
      );
    }
  }
  for (const req of BUNDLE_TOOL_TRACE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, req)) {
      throw new BundleConsumerError(
        "TRACE_UNEXPECTED_FIELD",
        `toolTrace[${index}] missing required field "${req}"`,
      );
    }
  }

  const tool = raw.tool;
  if (typeof tool !== "string" || tool.length === 0) {
    throw new BundleConsumerError(
      "TRACE_UNEXPECTED_FIELD",
      `toolTrace[${index}].tool must be a non-empty string`,
    );
  }

  const args = raw.args;
  if (!isPlainObject(args)) {
    throw new BundleConsumerError(
      "TRACE_UNEXPECTED_FIELD",
      `toolTrace[${index}].args must be a plain object`,
    );
  }

  const ok = raw.ok;
  if (typeof ok !== "boolean") {
    throw new BundleConsumerError(
      "TRACE_UNEXPECTED_FIELD",
      `toolTrace[${index}].ok must be a boolean (got ${typeof ok})`,
    );
  }

  const errorCode = raw.errorCode;
  if (!(errorCode === null || typeof errorCode === "string")) {
    throw new BundleConsumerError(
      "TRACE_UNEXPECTED_FIELD",
      `toolTrace[${index}].errorCode must be string or null (got ${typeof errorCode})`,
    );
  }

  const logicalLatencyMs = raw.logicalLatencyMs;
  if (
    typeof logicalLatencyMs !== "number" ||
    !Number.isFinite(logicalLatencyMs) ||
    logicalLatencyMs < 0
  ) {
    throw new BundleConsumerError(
      "TRACE_UNEXPECTED_FIELD",
      `toolTrace[${index}].logicalLatencyMs must be a finite number >= 0`,
    );
  }

  // result may be any I-JSON-compatible value; reject functions/symbols/bigint.
  const result = raw.result;
  const rt = typeof result;
  if (rt === "function" || rt === "symbol" || rt === "bigint") {
    throw new BundleConsumerError(
      "TRACE_UNEXPECTED_FIELD",
      `toolTrace[${index}].result has unsupported type ${rt}`,
    );
  }

  // Preserve validated values exactly — no String/Boolean/Number coercion.
  return {
    tool,
    args,
    ok,
    errorCode,
    logicalLatencyMs,
    result,
  };
}

/**
 * Project toolTrace records to the stable allowlisted shape.
 * Validates exact types; does not coerce.
 */
export function projectToolTraceRecordsForBundle(
  toolTrace: unknown,
): BundleToolCallRecord[] {
  if (!Array.isArray(toolTrace)) {
    throw new BundleConsumerError(
      "TRACE_UNEXPECTED_FIELD",
      "toolTrace must be an array",
    );
  }
  return toolTrace.map((raw, index) => validateToolTraceRecord(raw, index));
}

/** Digest projection matching producer tool_trace artifact binding. */
export function projectToolTraceForDigest(
  toolTrace: BundleToolCallRecord[],
): { steps: Array<Record<string, unknown>> } {
  return {
    steps: toolTrace.map((t) => ({
      tool: t.tool,
      args: t.args,
      ok: t.ok,
      errorCode: t.errorCode ?? null,
      logicalLatencyMs: t.logicalLatencyMs,
      result: t.result,
    })),
  };
}

export async function digestToolTraceProjection(
  toolTrace: BundleToolCallRecord[],
): Promise<string> {
  return digestJsonValue(projectToolTraceForDigest(toolTrace));
}

/**
 * Consumer-side toolTrace integrity:
 * allowlist + exact types, redaction equality, exactly-one tool_trace artifact, digest match.
 */
export async function assertToolTraceConsumerReady(
  toolTrace: unknown,
  evidence: EvidenceEnvelope,
): Promise<BundleToolCallRecord[]> {
  const allowlisted = projectToolTraceRecordsForBundle(toolTrace);

  const redacted = redactDeep(allowlisted);
  if (canonicalize(redacted) !== canonicalize(allowlisted)) {
    throw new BundleConsumerError(
      "TRACE_NOT_REDACTED",
      "toolTrace is not fully redacted (redactDeep would change canonical form)",
    );
  }

  const projected = await digestToolTraceProjection(allowlisted);
  const traces = (evidence.artifacts ?? []).filter(
    (a) => a.role === "tool_trace",
  );
  if (traces.length !== 1) {
    throw new BundleConsumerError(
      "TRACE_ARTIFACT_COUNT",
      `evidence must contain exactly one tool_trace artifact; found ${traces.length}`,
    );
  }
  const traceArtifact = traces[0]!;
  if (traceArtifact.digest !== projected) {
    throw new BundleConsumerError(
      "TRACE_DIGEST_MISMATCH",
      `tool_trace artifact digest ${traceArtifact.digest} !== projection ${projected}`,
    );
  }
  return allowlisted;
}
