/**
 * Minimal browser-facing entry used by the browser-bundle smoke test.
 * Must not import node: builtins.
 */
import {
  canonicalize,
  parseAndValidateSchema,
  digestJsonValue,
  PROTOCOL_VERSION,
} from "./index.js";

export {
  canonicalize,
  parseAndValidateSchema,
  digestJsonValue,
  PROTOCOL_VERSION,
};

export async function browserSmoke(): Promise<{
  ok: true;
  protocolVersion: string;
  digest: string;
  canonical: string;
}> {
  const canonical = canonicalize({ b: 2, a: 1 });
  if (canonical !== '{"a":1,"b":2}') {
    throw new Error(`unexpected JCS output: ${canonical}`);
  }
  const digest = await digestJsonValue({ hello: "browser" });
  if (!digest.startsWith("sha256:") || digest.length !== 71) {
    throw new Error(`unexpected digest: ${digest}`);
  }
  parseAndValidateSchema(
    {
      id: "score",
      valueType: "number",
      required: true,
    },
    "MeasurementDefinition",
  );
  return { ok: true, protocolVersion: PROTOCOL_VERSION, digest, canonical };
}
