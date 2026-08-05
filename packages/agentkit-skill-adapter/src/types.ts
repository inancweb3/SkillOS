/**
 * Versioned AgentKit / Agent Skill adapter types (Faz 3 plan #9).
 * Rail-neutral: no live wallet/CDP/x402 coupling.
 */

/** Package contract version. */
export const ADAPTER_CONTRACT_VERSION = "0.1.0" as const;

/**
 * Only modes that may produce a successful offline invoke.
 * No `live` | `funded` | `mainnet` | `production` success path.
 */
export const ADAPTER_MODES = Object.freeze(["dry_run", "fixture"] as const);
export type AdapterMode = (typeof ADAPTER_MODES)[number];

export type AdapterDenyCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "MODE_FORBIDDEN"
  | "LIVE_PATH_UNREACHABLE"
  | "FUNDED_PATH_UNREACHABLE"
  | "SKILL_MISSING"
  | "SKILL_INVALID"
  | "TOOL_MISSING"
  | "TOOL_INVALID"
  | "VERSION_INVALID"
  | "AUTHORITY_NON_GRANT"
  | "SECRETS_FORBIDDEN"
  | "REGISTRY_UNAVAILABLE";

export type AdapterOk<T> = { readonly ok: true; readonly value: T };
export type AdapterErr = {
  readonly ok: false;
  readonly denyCode: AdapterDenyCode;
  readonly reason: string;
};
export type AdapterResult<T> = AdapterOk<T> | AdapterErr;

/** Tool surface registered under a skill (metadata only — no live handler). */
export type SkillToolDescriptor = {
  readonly toolId: string;
  readonly description: string;
};

/** Versioned skill registration input (caller-supplied shape). */
export type SkillRegistrationInput = {
  readonly skillId: string;
  /** Semver-like major.minor.patch string (validated loosely). */
  readonly version: string;
  readonly tools: readonly SkillToolDescriptor[];
  readonly description?: string;
};

/** Frozen skill record stored in the registry. */
export type SkillRecord = {
  readonly skillId: string;
  readonly version: string;
  readonly tools: readonly SkillToolDescriptor[];
  readonly description: string | null;
  readonly registeredAt: string;
};

/** Dry-run invoke request. */
export type SkillInvokeRequest = {
  readonly skillId: string;
  readonly toolId: string;
  /** JSON-serializable plain object; never secrets. */
  readonly input?: Readonly<Record<string, unknown>>;
};

/**
 * Dry-run invoke receipt. Minted only by invokeSkillTool into a private WeakSet.
 */
export type SkillInvokeReceipt = {
  readonly kind: "skillos.agentkit.skill.invoke.receipt";
  readonly contractVersion: typeof ADAPTER_CONTRACT_VERSION;
  readonly skillId: string;
  readonly skillVersion: string;
  readonly toolId: string;
  readonly mode: AdapterMode;
  readonly simulatedOutput: Readonly<Record<string, unknown>>;
  readonly invokedAt: string;
  readonly live: false;
  readonly funded: false;
  readonly promoteAuthorized: false;
  readonly executeEnabled: false;
};

/** Hard non-grant authority flags. */
export type AdapterAuthorityFlags = {
  readonly promoteAuthorized: false;
  readonly executeEnabled: false;
  readonly x402FundedSpend: false;
  readonly walletSpend: false;
  readonly cdpSpend: false;
  readonly controlPlaneUnpause: false;
  readonly policyBypass: false;
};

/** Untrusted config bag. */
export type AdapterConfigInput = {
  readonly mode?: unknown;
  readonly live?: unknown;
  readonly funded?: unknown;
  readonly production?: unknown;
  readonly mainnet?: unknown;
  readonly privateKey?: unknown;
  readonly apiKey?: unknown;
  readonly agentKitSdk?: unknown;
};

export type AdapterConfig = {
  readonly kind: "skillos.agentkit.adapter.config";
  readonly mode: AdapterMode;
  readonly live: false;
  readonly funded: false;
  readonly production: false;
  readonly mainnet: false;
};

export function isAdapterMode(v: unknown): v is AdapterMode {
  return v === "dry_run" || v === "fixture";
}

/** Loose semver: digits.digits.digits with optional pre-release suffix blocked. */
export function isSkillVersion(v: unknown): v is string {
  return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);
}
