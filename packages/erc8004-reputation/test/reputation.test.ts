/**
 * ADR 0010 — ERC-8004 reputation one-way dry-run tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPUTATION_CONTRACT_VERSION,
  REPUTATION_MODES,
  authorizeExecuteFromReputation,
  authorizePolicyFromReputation,
  authorizePromotionFromReputation,
  authorizeWalletSpendFromReputation,
  broadcastReputationLive,
  createReputationConfig,
  isReputationProjection,
  parseReputationConfig,
  projectReputation,
  reputationAuthorityFlags,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const NOW = "2026-08-06T00:00:00.000Z";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const baseInput = {
  subjectDigest: DIGEST_A,
  evidenceDigest: DIGEST_B,
  summaryCode: "verified_pass" as const,
};

describe("contract pins", () => {
  it("version and modes", () => {
    assert.equal(REPUTATION_CONTRACT_VERSION, "0.1.0");
    assert.deepEqual([...REPUTATION_MODES], ["dry_run", "fixture"]);
  });

  it("authority flags always hard-false including inbound", () => {
    const f = reputationAuthorityFlags();
    assert.equal(f.promoteAuthorized, false);
    assert.equal(f.executeEnabled, false);
    assert.equal(f.reputationInboundAuthority, false);
    assert.equal(f.walletSpend, false);
    assert.equal(f.x402FundedSpend, false);
  });
});

describe("config fail-closed", () => {
  it("missing config", () => {
    const r = parseReputationConfig(null);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "CONFIG_MISSING");
  });

  it("live/broadcast true denied", () => {
    const r = parseReputationConfig({ mode: "dry_run", live: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "LIVE_PATH_UNREACHABLE");
  });

  it("funded denied", () => {
    const r = parseReputationConfig({ mode: "dry_run", funded: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "FUNDED_PATH_UNREACHABLE");
  });

  it("privateKey and rpcUrl denied", () => {
    assert.equal(
      parseReputationConfig({ mode: "dry_run", privateKey: "0x" }).ok,
      false,
    );
    assert.equal(
      parseReputationConfig({
        mode: "dry_run",
        rpcUrl: "https://sepolia.base.org",
      }).ok,
      false,
    );
  });
});

describe("projectReputation dry-run", () => {
  const cfg = createReputationConfig({ mode: "dry_run" });

  it("projects digest/summary with one-way hard-false flags", () => {
    const r = projectReputation(baseInput, cfg, { projectedAt: NOW });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.subjectDigest, DIGEST_A);
    assert.equal(r.value.evidenceDigest, DIGEST_B);
    assert.equal(r.value.summaryCode, "verified_pass");
    assert.equal(r.value.broadcast, false);
    assert.equal(r.value.live, false);
    assert.equal(r.value.promoteAuthorized, false);
    assert.equal(r.value.executeEnabled, false);
    assert.equal(r.value.oneWayOutbound, true);
    assert.equal(isReputationProjection(r.value), true);
  });

  it("fixture mode works", () => {
    const r = projectReputation(
      baseInput,
      createReputationConfig({ mode: "fixture" }),
      { projectedAt: NOW },
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.mode, "fixture");
  });

  it("invalid digest fails", () => {
    const r = projectReputation(
      { ...baseInput, subjectDigest: "short" },
      cfg,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "DIGEST_INVALID");
  });

  it("invalid summary fails", () => {
    const r = projectReputation(
      {
        ...baseInput,
        // @ts-expect-error intentional
        summaryCode: "leaked_pii_blob",
      },
      cfg,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "SUMMARY_INVALID");
  });

  it("privacy denylist rejects extra evidence body field", () => {
    const r = projectReputation(
      {
        ...baseInput,
        // unexpected key
        rawEvidence: "secret blob",
      } as typeof baseInput & { rawEvidence: string },
      cfg,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "PRIVACY_DENYLIST");
  });

  it("forged projection rejected by isReputationProjection", () => {
    const forged = {
      kind: "skillos.erc8004.reputation.projection" as const,
      contractVersion: REPUTATION_CONTRACT_VERSION,
      mode: "dry_run" as const,
      subjectDigest: DIGEST_A,
      evidenceDigest: DIGEST_B,
      summaryCode: "verified_pass" as const,
      schemaDigest: null,
      simulatedOnchainRef: "sim_forged",
      projectedAt: NOW,
      broadcast: false as const,
      funded: false as const,
      live: false as const,
      promoteAuthorized: false as const,
      executeEnabled: false as const,
      oneWayOutbound: true as const,
    };
    assert.equal(isReputationProjection(forged), false);
  });

  it("spread clone not registered", () => {
    const r = projectReputation(baseInput, cfg, { projectedAt: NOW });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(isReputationProjection({ ...r.value }), false);
  });
});

describe("one-way: reputation never promotes or executes", () => {
  it("authorizePromotionFromReputation always fails", () => {
    const cfg = createReputationConfig({ mode: "dry_run" });
    const r = projectReputation(baseInput, cfg, { projectedAt: NOW });
    assert.equal(r.ok, true);
    const p = authorizePromotionFromReputation(r);
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.denyCode, "ONE_WAY_VIOLATION");
  });

  it("authorizeExecuteFromReputation always fails", () => {
    const e = authorizeExecuteFromReputation({ score: 99 });
    assert.equal(e.ok, false);
    if (!e.ok) assert.equal(e.denyCode, "ONE_WAY_VIOLATION");
  });

  it("authorizePolicyFromReputation always fails", () => {
    const p = authorizePolicyFromReputation({ ok: true });
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.denyCode, "AUTHORITY_NON_GRANT");
  });

  it("authorizeWalletSpendFromReputation always fails", () => {
    const w = authorizeWalletSpendFromReputation({ ok: true });
    assert.equal(w.ok, false);
    if (!w.ok) assert.equal(w.denyCode, "FUNDED_PATH_UNREACHABLE");
  });
});

describe("live broadcast unreachable", () => {
  it("broadcastReputationLive always denies", () => {
    const r = broadcastReputationLive(baseInput, { mode: "dry_run" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "LIVE_PATH_UNREACHABLE");
  });
});

describe("ADR-0010 present", () => {
  it("documents one-way and digests only", () => {
    const adr = readFileSync(
      join(repoRoot, "docs/adr/0010-onchain-privacy-reputation.md"),
      "utf8",
    );
    assert.match(adr, /ADR 0010/);
    assert.match(adr, /one-way/i);
    assert.match(adr, /digest/i);
    assert.match(adr, /EXECUTE|promote/i);
  });
});
