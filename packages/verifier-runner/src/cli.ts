#!/usr/bin/env npx tsx
/**
 * Offline CLI: portable bundle JSON → VerificationResult (or fail-closed error).
 *
 * Usage:
 *   npx tsx src/cli.ts --in path/to/bundle.json
 *   npx tsx src/cli.ts --in path/to/bundle.json --out result.json
 *   npx tsx src/cli.ts --in path/to/bundle.json --report
 *   cat bundle.json | npx tsx src/cli.ts --stdin
 *
 * Exit codes:
 *   0  runner success — emits a protocol-valid VerificationResult
 *      (including status=rejected when a hard gate fires)
 *   1  usage / load error
 *   2  verification / schema / binding / output failure (no final result or report)
 *
 * File outputs (--out, --report-out) are written transactionally: destinations are
 * validated first (no symlinks/directories/collisions), exclusive temps at mode 0600
 * are fsynced, then renamed. Any failure leaves no final result or report from this run.
 */

import { parseJsonStrict } from "@skillos/protocol";
import { writeOutputsAtomic } from "./atomicWrite.js";
import { BundleConsumerError } from "./errors.js";
import { loadBundleFile } from "./load.js";
import { formatHardFailureReportHuman } from "./multiAxis.js";
import { runDeterministicBundleVerifier } from "./run.js";

function printUsage(): void {
  process.stderr.write(
    [
      "skillos-verify-bundle — consume a portable offline-eval bundle",
      "",
      "Usage:",
      "  skillos-verify-bundle --in <bundle.json> [--out <result.json>] [--report]",
      "  skillos-verify-bundle --stdin [--out <result.json>] [--report]",
      "",
      "Options:",
      "  --report           Write multi-axis / hard-failure summary to stderr",
      "  --report-out PATH  Write multi-axis report JSON sidecar (atomic, mode 0600)",
      "  --verified-at ISO  Override VerificationResult.verifiedAt",
      "",
      "Exit codes:",
      "  0  success (result emitted; may be status=rejected on hard gate)",
      "  1  usage/load error",
      "  2  verification or output failure (no final result/report files)",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): {
  inPath?: string;
  outPath?: string;
  stdin: boolean;
  verifiedAt?: string;
  report: boolean;
  reportOutPath?: string;
} {
  let inPath: string | undefined;
  let outPath: string | undefined;
  let stdin = false;
  let verifiedAt: string | undefined;
  let report = false;
  let reportOutPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
    if (a === "--stdin") {
      stdin = true;
      continue;
    }
    if (a === "--report") {
      report = true;
      continue;
    }
    if (a === "--in") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) {
        throw new BundleConsumerError("CLI_USAGE", "--in requires a path value");
      }
      inPath = v;
      continue;
    }
    if (a === "--out") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) {
        throw new BundleConsumerError(
          "CLI_USAGE",
          "--out requires a path value",
        );
      }
      outPath = v;
      continue;
    }
    if (a === "--report-out") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) {
        throw new BundleConsumerError(
          "CLI_USAGE",
          "--report-out requires a path value",
        );
      }
      reportOutPath = v;
      continue;
    }
    if (a === "--verified-at") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) {
        throw new BundleConsumerError(
          "CLI_USAGE",
          "--verified-at requires an ISO timestamp",
        );
      }
      verifiedAt = v;
      continue;
    }
    throw new BundleConsumerError("CLI_USAGE", `unknown argument: ${a}`);
  }

  if (stdin === Boolean(inPath)) {
    throw new BundleConsumerError(
      "CLI_USAGE",
      "exactly one of --in <path> or --stdin is required",
    );
  }
  return { inPath, outPath, stdin, verifiedAt, report, reportOutPath };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    let bundle: Record<string, unknown>;
    if (args.stdin) {
      const text = await readStdin();
      const parsed = parseJsonStrict(text);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new BundleConsumerError(
          "BUNDLE_INVALID",
          "bundle root must be a JSON object",
        );
      }
      bundle = parsed as Record<string, unknown>;
    } else {
      bundle = loadBundleFile(args.inPath!);
    }

    const out = await runDeterministicBundleVerifier(bundle, {
      verifiedAt: args.verifiedAt,
    });

    if (!out.ok) {
      process.stderr.write(
        JSON.stringify(
          { ok: false, code: out.code, reason: out.reason },
          null,
          2,
        ) + "\n",
      );
      process.exit(2);
    }

    const payload = {
      ok: true as const,
      bundleDigest: out.bundleDigest,
      result: out.result,
      verifier: {
        id: out.verifier.id,
        version: out.verifier.version,
        digest: out.verifier.digest,
      },
      multiAxisReport: out.multiAxisReport,
      hardFailureReport: out.hardFailureReport,
    };
    const text = JSON.stringify(payload, null, 2) + "\n";

    const reportPayload = JSON.stringify(
      {
        multiAxisReport: out.multiAxisReport,
        hardFailureReport: out.hardFailureReport,
      },
      null,
      2,
    ) + "\n";

    // Validate + commit all file outputs before any stdout emission.
    const fileWrites: Array<{ path: string; content: string }> = [];
    if (args.outPath) {
      fileWrites.push({ path: args.outPath, content: text });
    }
    if (args.reportOutPath) {
      fileWrites.push({ path: args.reportOutPath, content: reportPayload });
    }
    if (fileWrites.length > 0) {
      writeOutputsAtomic(fileWrites);
    }

    // Stdout only after successful file commit (or when no files requested).
    if (!args.outPath) {
      process.stdout.write(text);
    }

    if (args.report) {
      process.stderr.write(
        formatHardFailureReportHuman(
          out.hardFailureReport,
          out.multiAxisReport,
        ) + "\n",
      );
    }

    process.exit(0);
  } catch (err) {
    if (err instanceof BundleConsumerError) {
      process.stderr.write(
        JSON.stringify(
          { ok: false, code: err.code, reason: err.message },
          null,
          2,
        ) + "\n",
      );
      const usageLike =
        err.code === "CLI_USAGE" || err.code === "LOAD_FAILED";
      process.exit(usageLike ? 1 : 2);
    }
    process.stderr.write(
      JSON.stringify(
        {
          ok: false,
          code: "BUNDLE_INVALID",
          reason: err instanceof Error ? err.message : String(err),
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(2);
  }
}

void main();
