/**
 * F-004 — CLI transactional output, symlink safety, mode 0600.
 * Spawns the real CLI (tsx src/cli.ts) as a child process.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const cliPath = join(pkgRoot, "src/cli.ts");
const golden = join(pkgRoot, "fixtures/risk-tier.portable.bundle.json");

function runCli(
  args: string[],
  opts: { cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", cliPath, ...args],
    {
      cwd: opts.cwd ?? pkgRoot,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

describe("F-004 CLI atomic outputs", () => {
  it("success --out writes mode 0600 result and overwrites prior 0644", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillos-cli-"));
    const outPath = join(dir, "result.json");
    writeFileSync(outPath, "stale", { mode: 0o644 });
    chmodSync(outPath, 0o644);

    const r = runCli(["--in", golden, "--out", outPath]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(outPath), true);
    assert.equal(modeOf(outPath), 0o600);
    const body = JSON.parse(readFileSync(outPath, "utf8")) as {
      ok: boolean;
      result: { status: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.result.status, "verified");
  });

  it("invalid --report-out directory does not leave --out result", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillos-cli-"));
    const outPath = join(dir, "result.json");
    const reportDir = join(dir, "report-as-dir");
    mkdirSync(reportDir);

    // Ensure outPath does not exist before
    assert.equal(existsSync(outPath), false);

    const r = runCli([
      "--in",
      golden,
      "--out",
      outPath,
      "--report-out",
      reportDir,
    ]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(existsSync(outPath), false, "must not leave result on failure");
    assert.match(r.stderr, /CLI_OUTPUT|directory/i);
  });

  it("symlink --out is rejected with no final write", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillos-cli-"));
    const target = join(dir, "target.json");
    const linkPath = join(dir, "out-link.json");
    writeFileSync(target, "orig", { mode: 0o600 });
    symlinkSync(target, linkPath);

    const r = runCli(["--in", golden, "--out", linkPath]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /symlink/i);
    assert.equal(readFileSync(target, "utf8"), "orig");
  });

  it("symlink --report-out with --out does not leave result", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillos-cli-"));
    const outPath = join(dir, "result.json");
    const target = join(dir, "report-target.json");
    const linkPath = join(dir, "report-link.json");
    writeFileSync(target, "x", { mode: 0o600 });
    symlinkSync(target, linkPath);

    const r = runCli([
      "--in",
      golden,
      "--out",
      outPath,
      "--report-out",
      linkPath,
    ]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(existsSync(outPath), false);
  });

  it("collision --out and --report-out same path rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillos-cli-"));
    const same = join(dir, "same.json");
    const r = runCli([
      "--in",
      golden,
      "--out",
      same,
      "--report-out",
      same,
    ]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(existsSync(same), false);
    assert.match(r.stderr, /collision/i);
  });

  it("successful --out + --report-out both mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillos-cli-"));
    const outPath = join(dir, "result.json");
    const reportPath = join(dir, "report.json");
    // pre-existing permissive report
    writeFileSync(reportPath, "old", { mode: 0o644 });
    chmodSync(reportPath, 0o644);

    const r = runCli([
      "--in",
      golden,
      "--out",
      outPath,
      "--report-out",
      reportPath,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(modeOf(outPath), 0o600);
    assert.equal(modeOf(reportPath), 0o600);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      multiAxisReport: { status: string };
    };
    assert.equal(report.multiAxisReport.status, "verified");
  });

  it("--report human summary has no multiline control forging from payload", () => {
    const r = runCli(["--in", golden, "--report"]);
    assert.equal(r.status, 0, r.stderr);
    // human summary is a single logical line on stderr (plus possible runtime noise)
    const lines = r.stderr
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("(node:"));
    const summary = lines.find((l) => l.startsWith("status="));
    assert.ok(summary, `expected status= summary, stderr=${r.stderr}`);
    assert.equal(summary!.includes("\u0000"), false);
  });
});
