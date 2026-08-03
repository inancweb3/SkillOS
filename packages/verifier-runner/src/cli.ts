#!/usr/bin/env npx tsx
/**
 * Offline CLI: portable bundle JSON → VerificationResult (or fail-closed error).
 *
 * Usage:
 *   npx tsx src/cli.ts --in path/to/bundle.json
 *   npx tsx src/cli.ts --in path/to/bundle.json --out result.json
 *   cat bundle.json | npx tsx src/cli.ts --stdin
 */

import { writeFileSync } from "node:fs";
import { parseJsonStrict } from "@skillos/protocol";
import { BundleConsumerError } from "./errors.js";
import { loadBundleFile } from "./load.js";
import { runDeterministicBundleVerifier } from "./run.js";

function printUsage(): void {
  process.stderr.write(
    [
      "skillos-verify-bundle — consume a portable offline-eval bundle",
      "",
      "Usage:",
      "  skillos-verify-bundle --in <bundle.json> [--out <result.json>]",
      "  skillos-verify-bundle --stdin [--out <result.json>]",
      "",
      "Exit codes: 0 success, 1 usage/load, 2 verification failure",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): {
  inPath?: string;
  outPath?: string;
  stdin: boolean;
  verifiedAt?: string;
} {
  let inPath: string | undefined;
  let outPath: string | undefined;
  let stdin = false;
  let verifiedAt: string | undefined;

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
  return { inPath, outPath, stdin, verifiedAt };
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
    };
    const text = JSON.stringify(payload, null, 2) + "\n";
    if (args.outPath) {
      writeFileSync(args.outPath, text, { encoding: "utf8", mode: 0o600 });
    } else {
      process.stdout.write(text);
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
      process.exit(err.code === "CLI_USAGE" || err.code === "LOAD_FAILED" ? 1 : 2);
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
