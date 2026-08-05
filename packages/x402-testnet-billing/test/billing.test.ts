/**
 * ADR 0009 — rail-neutral testnet billing fail-closed tests.
 * Run: npx tsx --test packages/x402-testnet-billing/test/billing.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BILLING_CONTRACT_VERSION,
  BILLING_MODES,
  authorizeBilling,
  authorizeExecuteFromBilling,
  authorizePromotionFromBilling,
  authorizeX402FundedSpend,
  billingAuthorityFlags,
  createBillingConfig,
  dryRunBilling,
  isBillingReceipt,
  parseBillingConfig,
  quoteBilling,
  settleBilling,
  settleLiveFundedBilling,
  type BillingRequest,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

const NOW = "2026-08-05T19:00:00.000Z";
const req: BillingRequest = {
  requestId: "req_test_001",
  amountAtomic: 1_050_000n,
  asset: "USDC",
  subjectDigest: "a8fafc3778d45ff5ce8c78d22dba658fe161b956",
};

describe("contract pins", () => {
  it("exports version 0.1.0 and only dry_run|fixture modes", () => {
    assert.equal(BILLING_CONTRACT_VERSION, "0.1.0");
    assert.deepEqual([...BILLING_MODES], ["dry_run", "fixture"]);
  });

  it("authority flags are always hard-false", () => {
    const f = billingAuthorityFlags();
    assert.equal(f.promoteAuthorized, false);
    assert.equal(f.executeEnabled, false);
    assert.equal(f.x402FundedSpend, false);
    assert.equal(f.walletSpend, false);
    assert.equal(f.controlPlaneUnpause, false);
    assert.equal(f.policyBypass, false);
  });
});

describe("config fail-closed", () => {
  it("missing config → CONFIG_MISSING", () => {
    const r = parseBillingConfig(null);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "CONFIG_MISSING");
  });

  it("production true → PRODUCTION_FORBIDDEN", () => {
    const r = parseBillingConfig({ mode: "dry_run", production: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "PRODUCTION_FORBIDDEN");
  });

  it("mainnet true → MAINNET_FORBIDDEN", () => {
    const r = parseBillingConfig({ mode: "dry_run", mainnet: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "MAINNET_FORBIDDEN");
  });

  it("funded true → FUNDED_PATH_UNREACHABLE", () => {
    const r = parseBillingConfig({ mode: "dry_run", funded: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "FUNDED_PATH_UNREACHABLE");
  });

  it("liveSettle true → FUNDED_PATH_UNREACHABLE", () => {
    const r = parseBillingConfig({ mode: "fixture", liveSettle: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "FUNDED_PATH_UNREACHABLE");
  });

  it("mode mainnet string → MODE_FORBIDDEN", () => {
    const r = parseBillingConfig({ mode: "mainnet" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "MODE_FORBIDDEN");
  });

  it("privateKey rejected", () => {
    const r = parseBillingConfig({ mode: "dry_run", privateKey: "0xabc" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "CONFIG_INVALID");
  });

  it("facilitatorUrl rejected", () => {
    const r = parseBillingConfig({
      mode: "dry_run",
      facilitatorUrl: "https://x402.org/facilitator",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "CONFIG_INVALID");
  });

  it("dry_run config succeeds with hard-false flags", () => {
    const r = parseBillingConfig({ mode: "dry_run" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.mode, "dry_run");
    assert.equal(r.value.funded, false);
    assert.equal(r.value.mainnet, false);
    assert.equal(r.value.production, false);
    assert.equal(r.value.liveSettle, false);
  });
});

describe("quote / authorize / settle dry-run", () => {
  const cfg = createBillingConfig({ mode: "dry_run" });

  it("happy path dry-run settles simulated receipt only", () => {
    const settled = dryRunBilling(req, cfg, { decidedAt: NOW });
    assert.equal(settled.ok, true);
    if (!settled.ok) return;
    assert.equal(settled.value.funded, false);
    assert.equal(settled.value.liveSettle, false);
    assert.equal(settled.value.promoteAuthorized, false);
    assert.equal(settled.value.executeEnabled, false);
    assert.equal(settled.value.mode, "dry_run");
    assert.ok(settled.value.simulatedTxId.startsWith("sim_dry_run_"));
    assert.equal(isBillingReceipt(settled.value), true);
  });

  it("fixture mode also works", () => {
    const fixture = createBillingConfig({ mode: "fixture" });
    const settled = dryRunBilling(req, fixture, { decidedAt: NOW });
    assert.equal(settled.ok, true);
    if (!settled.ok) return;
    assert.equal(settled.value.mode, "fixture");
    assert.equal(settled.value.funded, false);
  });

  it("missing config on quote fails closed", () => {
    const q = quoteBilling(req, null);
    assert.equal(q.ok, false);
    if (!q.ok) assert.equal(q.denyCode, "CONFIG_MISSING");
  });

  it("zero amount fails", () => {
    const q = quoteBilling({ ...req, amountAtomic: 0n }, cfg);
    assert.equal(q.ok, false);
    if (!q.ok) assert.equal(q.denyCode, "AMOUNT_INVALID");
  });

  it("forged receipt shape is rejected by isBillingReceipt", () => {
    const forged = {
      kind: "skillos.billing.receipt" as const,
      contractVersion: BILLING_CONTRACT_VERSION,
      requestId: "forged",
      amountAtomic: 1n,
      asset: "USDC" as const,
      mode: "dry_run" as const,
      simulatedTxId: "sim_forged",
      settledAt: NOW,
      funded: false as const,
      liveSettle: false as const,
      promoteAuthorized: false as const,
      executeEnabled: false as const,
    };
    assert.equal(isBillingReceipt(forged), false);
  });

  it("spread clone of real receipt is not registered", () => {
    const settled = dryRunBilling(req, cfg, { decidedAt: NOW });
    assert.equal(settled.ok, true);
    if (!settled.ok) return;
    assert.equal(isBillingReceipt({ ...settled.value }), false);
  });
});

describe("funded path unreachable by construction", () => {
  it("settleLiveFundedBilling always denies", () => {
    const r = settleLiveFundedBilling(req, { mode: "dry_run" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "FUNDED_PATH_UNREACHABLE");
  });

  it("funded config never reaches settle", () => {
    const q = quoteBilling(req, { mode: "dry_run", funded: true });
    assert.equal(q.ok, false);
    if (!q.ok) assert.equal(q.denyCode, "FUNDED_PATH_UNREACHABLE");
  });

  it("production flag never reaches settle", () => {
    const r = dryRunBilling(req, { mode: "fixture", production: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "PRODUCTION_FORBIDDEN");
  });

  it("mainnet mode string never settles", () => {
    const r = dryRunBilling(req, { mode: "mainnet" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denyCode, "MODE_FORBIDDEN");
  });
});

describe("billing never enters decision / promotion / EXECUTE", () => {
  it("authorizePromotionFromBilling always fails", () => {
    const settled = dryRunBilling(req, createBillingConfig({ mode: "dry_run" }), {
      decidedAt: NOW,
    });
    assert.equal(settled.ok, true);
    const p = authorizePromotionFromBilling(settled);
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.denyCode, "AUTHORITY_NON_GRANT");
  });

  it("authorizeExecuteFromBilling always fails", () => {
    const e = authorizeExecuteFromBilling({ ok: true });
    assert.equal(e.ok, false);
    if (!e.ok) assert.equal(e.denyCode, "AUTHORITY_NON_GRANT");
  });

  it("authorizeX402FundedSpend always fails", () => {
    const x = authorizeX402FundedSpend({ settled: true });
    assert.equal(x.ok, false);
    if (!x.ok) assert.equal(x.denyCode, "FUNDED_PATH_UNREACHABLE");
  });

  it("receipt fields cannot claim promote or execute", () => {
    const settled = dryRunBilling(req, createBillingConfig({ mode: "dry_run" }), {
      decidedAt: NOW,
    });
    assert.equal(settled.ok, true);
    if (!settled.ok) return;
    assert.equal(settled.value.promoteAuthorized, false);
    assert.equal(settled.value.executeEnabled, false);
  });
});

describe("authorize/settle chain integrity", () => {
  it("authorize without valid quote fails", () => {
    const a = authorizeBilling(
      // @ts-expect-error intentional bad input
      { kind: "nope" },
      createBillingConfig({ mode: "dry_run" }),
    );
    assert.equal(a.ok, false);
  });

  it("settle without authorization fails", () => {
    const s = settleBilling(
      // @ts-expect-error intentional bad input
      null,
      createBillingConfig({ mode: "dry_run" }),
    );
    assert.equal(s.ok, false);
  });
});

describe("ADR-0009 in-repo", () => {
  it("documents rail-neutral + funded unreachable", () => {
    const adr = readFileSync(
      join(repoRoot, "docs/adr/0009-rail-neutral-testnet-billing.md"),
      "utf8",
    );
    assert.match(adr, /ADR 0009/);
    assert.match(adr, /x402-testnet-billing/);
    assert.match(adr, /unreachable by construction/i);
    assert.match(adr, /rail-neutral/i);
    assert.match(adr, /0003/);
  });
});
