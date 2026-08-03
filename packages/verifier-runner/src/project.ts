import { BundleConsumerError } from "./errors.js";
import {
  OFFLINE_EVAL_BUNDLE_BODY_KEYS,
  type OfflineEvalBundle,
  type OfflineEvalBundleBody,
} from "./types.js";

/**
 * Project a parsed bundle document onto OfflineEvalBundleBody allowlist only.
 * Rejects unknown top-level keys (e.g. diagnostic) and missing body keys.
 */
export function projectOfflineEvalBundleBody(
  bundle: OfflineEvalBundle | Record<string, unknown>,
): OfflineEvalBundleBody {
  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new BundleConsumerError(
      "BUNDLE_INVALID",
      "bundle must be a non-null object",
    );
  }
  const rec = bundle as Record<string, unknown>;
  const allowed = new Set<string>([
    ...OFFLINE_EVAL_BUNDLE_BODY_KEYS,
    "bundleDigest",
  ]);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) {
      throw new BundleConsumerError(
        "BUNDLE_UNKNOWN_FIELD",
        `unknown top-level bundle field "${key}" (not in offlineEvalBundleBody)`,
      );
    }
  }
  const body: Record<string, unknown> = {};
  for (const key of OFFLINE_EVAL_BUNDLE_BODY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(rec, key)) {
      throw new BundleConsumerError(
        "BUNDLE_MISSING_FIELD",
        `missing required body field "${key}"`,
      );
    }
    body[key] = rec[key];
  }
  return body as OfflineEvalBundleBody;
}
