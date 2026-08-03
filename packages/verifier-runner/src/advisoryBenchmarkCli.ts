#!/usr/bin/env npx tsx
/**
 * Advisory CI benchmark CLI — batch report over locked portable goldens.
 *
 * Usage:
 *   npx tsx src/advisoryBenchmarkCli.ts --out report.json
 *   npx tsx src/advisoryBenchmarkCli.ts --fixtures-dir ./fixtures --out report.json
 *
 * Exit codes:
 *   0  trustworthy report emitted (rows are verified and/or catalog-rejected only)
 *   1  usage error
 *   2  tool/load/schema/row-error failure — **no** normal trustworthy artifact
 *
 * Never exits non-zero solely because a golden row is hard-gate rejected.
 * Any status=error row fails closed (exit 2) — F-002.
 * Advisory only: no EXECUTE, no promotion, no Simpl3 authority.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeOutputsAtomic } from "./atomicWrite.js";
import {
  ADVISORY_GOLDEN_FILES,
  buildAdvisoryBenchmarkFromGoldenFixtures,
  formatAdvisoryBenchmarkHuman,
  isTrustworthyAdvisoryReport,
  sanitizeCiBinding,
} from "./advisoryBenchmark.js";
import { BundleConsumerError } from "./errors.js";

const here = dirname(fileURLToPath(import.meta.url));
const defaultFixturesDir = join(here, "../fixtures");

function printUsage(): void {
  process.stderr.write(
    [
      "skillos-advisory-benchmark — advisory CI benchmark report (v0.1)",
      "",
      "Usage:",
      "  skillos-advisory-benchmark --out <report.json> [--fixtures-dir DIR]",
      "",
      "Options:",
      "  --out PATH           Write AdvisoryBenchmarkReport JSON (atomic, mode 0600)",
      "  --fixtures-dir DIR   Directory with locked *.portable.bundle.json (default: package fixtures)",
      "  --git-sha SHA        Optional CI binding (default: $GITHUB_SHA or empty)",
      "  --workflow-run-id ID Optional CI binding (default: $GITHUB_RUN_ID or empty)",
      "  --verified-at ISO    Fixed verifiedAt for all rows (optional)",
      "  --quiet              Suppress human summary on stderr",
      "",
      "Exit codes:",
      "  0  trustworthy report emitted (verified and/or rejected rows only)",
      "  1  usage error",
      "  2  tool/row-error failure (no normal artifact written)",
      "",
      "status=error rows fail closed (exit 2). status=rejected is advisory success.",
      "Non-authority: advisory=true; promotionAuthority=false; executionAuthority=false.",
      "",
      `Default goldens (${ADVISORY_GOLDEN_FILES.length}): ${ADVISORY_GOLDEN_FILES.join(", ")}`,
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): {
  outPath?: string;
  fixturesDir: string;
  gitSha: string;
  workflowRunId: string;
  verifiedAt?: string;
  quiet: boolean;
} {
  let outPath: string | undefined;
  let fixturesDir = defaultFixturesDir;
  let gitSha = process.env.GITHUB_SHA ?? "";
  let workflowRunId = process.env.GITHUB_RUN_ID ?? "";
  let verifiedAt: string | undefined;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
    if (a === "--quiet") {
      quiet = true;
      continue;
    }
    if (a === "--out") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) {
        throw new BundleConsumerError("CLI_USAGE", "--out requires a path value");
      }
      outPath = v;
      continue;
    }
    if (a === "--fixtures-dir") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) {
        throw new BundleConsumerError(
          "CLI_USAGE",
          "--fixtures-dir requires a path value",
        );
      }
      fixturesDir = resolve(v);
      continue;
    }
    if (a === "--git-sha") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) {
        throw new BundleConsumerError(
          "CLI_USAGE",
          "--git-sha requires a value",
        );
      }
      gitSha = v;
      continue;
    }
    if (a === "--workflow-run-id") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) {
        throw new BundleConsumerError(
          "CLI_USAGE",
          "--workflow-run-id requires a value",
        );
      }
      workflowRunId = v;
      continue;
    }
    if (a === "--verified-at") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) {
        throw new BundleConsumerError(
          "CLI_USAGE",
          "--verified-at requires an ISO value",
        );
      }
      verifiedAt = v;
      continue;
    }
    throw new BundleConsumerError("CLI_USAGE", `unknown argument: ${a}`);
  }

  return { outPath, fixturesDir, gitSha, workflowRunId, verifiedAt, quiet };
}

/** Fixed stderr lines only — never raw exception text (may contain paths/secrets). */
function failTool(publicCode: string): never {
  process.stderr.write(`advisory-benchmark failed: ${publicCode}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch {
    process.stderr.write("advisory-benchmark failed: CLI_USAGE\n");
    printUsage();
    process.exit(1);
  }

  if (!args.outPath) {
    process.stderr.write("advisory-benchmark failed: CLI_USAGE\n");
    printUsage();
    process.exit(1);
  }

  let report;
  try {
    report = await buildAdvisoryBenchmarkFromGoldenFixtures(args.fixturesDir, {
      verifiedAt: args.verifiedAt,
      gitSha: sanitizeCiBinding(args.gitSha),
      workflowRunId: sanitizeCiBinding(args.workflowRunId),
    });
  } catch {
    // F-001: do not echo raw Error.message to stderr
    failTool("BUILD_FAILED");
  }

  // F-002: any error row or wrong count → exit 2, no normal artifact
  if (!isTrustworthyAdvisoryReport(report, ADVISORY_GOLDEN_FILES.length)) {
    const codes = report.rows
      .filter((r) => r.status === "error")
      .map((r) => r.error?.code ?? "TOOL_ERROR")
      .join(",");
    process.stderr.write(
      `advisory-benchmark failed: UNTRUSTED_REPORT errors=${report.summary.error} codes=${codes || "none"} rows=${report.rows.length}\n`,
    );
    process.exit(2);
  }

  const content = `${JSON.stringify(report, null, 2)}\n`;
  try {
    writeOutputsAtomic([{ path: args.outPath, content }]);
  } catch {
    failTool("CLI_OUTPUT");
  }

  if (!args.quiet) {
    process.stderr.write(`${formatAdvisoryBenchmarkHuman(report)}\n`);
  }
  process.exit(0);
}

main().catch(() => {
  process.stderr.write("advisory-benchmark failed: UNHANDLED\n");
  process.exit(2);
});
