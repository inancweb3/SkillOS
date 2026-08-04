/**
 * @skillos/private-workspace-analytics — private workspace + analytics
 * privacy foundations (Faz 3 / ADR 0007).
 *
 * - Explicit allowlist + field classification for SkillOS ingress
 * - Fail-closed export (missing policy / unclassified / private / secret-shaped)
 * - Analytics: digests + aggregates only; never EXECUTE / promotion / wallet /
 *   funded-spend / control-plane authority (full deny-set hard-false flags)
 * - Gates accept no authority parameter (stronger than deny-by-parameter)
 * - No network, cloud SDK, secrets, or Simpl3 execution import
 *
 * Security rebuild (ChatGPT F-001…F-007 + F-007A/B):
 * - F-001: top-level isSensitiveKey before policy
 * - F-002: detached deep JSON snapshot + deep-freeze
 * - F-003: null-prototype maps + own-property lookup
 * - F-004: strict finite I-JSON digest domain
 * - F-005: snapshot-then-scan (same detached value)
 * - F-006: outer descriptor-safe ingress; gate APIs return structured Results
 *   (never throw). Helpers `digestWorkspaceId` / `canonicalJson` throw
 *   deliberately on non-I-JSON so misuse fails loud (AR-4).
 * - F-007: fail-closed array/depth/node/property/UTF-8-byte caps (no truncation)
 * - F-007 residual: request-wide shared budgets; public encoder one-arg only
 * - F-007A: budget / *WithBudget not on package root; counters fail-closed
 * - F-007B: array named/symbol own keys rejected (no silent omit / budget bypass)
 */

export {
  PRIVACY_CONTRACT_VERSION,
  FIELD_CLASSES,
  ALWAYS_PRIVATE_KEYS,
  FORBIDDEN_AUTHORITY_ACTIONS,
  isFieldClass,
  isForbiddenAuthorityAction,
  freezeExportPolicy,
  type FieldClass,
  type ForbiddenAuthorityAction,
  type ExportDenyCode,
  type ExportPolicy,
  type PrivateWorkspaceRecord,
  type SkillOSIngressExport,
  type ExportDecision,
  type AnalyticsSummary,
  type AnalyticsDecision,
} from "./types.js";

export {
  isSensitiveKey,
  isSecretValue,
  containsSecretShaped,
} from "./secrets.js";

export {
  // Public digest surface only — ResourceBudget / *WithBudget / createResourceBudget
  // remain package-internal (F-007A); request gates construct budgets privately.
  encodeIJson,
  digestValue,
  digestWorkspaceId,
  canonicalJson,
  IJSON_MAX_ARRAY_LENGTH,
  IJSON_MAX_DEPTH,
  IJSON_MAX_NODES,
  IJSON_MAX_PROPERTIES,
  IJSON_MAX_UTF8_BYTES,
  type DigestEncodeResult,
  type DigestValueResult,
} from "./digest.js";

export {
  exportForSkillOSIngress,
  buildAnalyticsSummary,
  denyAuthorityAction,
  attemptRawPrivateExport,
  isAlwaysPrivateKey,
  isAuthorityActionForbidden,
} from "./export.js";
