/**
 * Thin node:test wrapper so external-consumer smoke is runnable via tsx --test
 * and the package test surface.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "..", "scripts", "external-consumer-smoke.mjs");

describe("external consumer publish-readiness", () => {
  it("npm pack + clean consumer install + typecheck + node/browser smokes", () => {
    const r = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, CI: process.env.CI ?? "true" },
      timeout: 300_000,
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    assert.equal(r.status, 0, "external-consumer-smoke.mjs must exit 0");
    assert.match(r.stdout ?? "", /ALL EXTERNAL CONSUMER CHECKS PASS/);
  });
});
