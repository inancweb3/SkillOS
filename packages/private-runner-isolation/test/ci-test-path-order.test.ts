/**
 * CI-ORD-1 — single owner for the load-bearing CI test-path adjacency chain.
 *
 * Do **not** re-create per-package neighbour guards in other packages.
 * Future insertions into the ordered tail must update this enforcer atomically
 * and respect the comment in `.github/workflows/ci.yml` that names this file.
 *
 * Symbol: `assertCiTestPathOrderChain` · suite: `CI-ORD-1 — single-owner test-path order`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Load-bearing ordered chain on the test-ts path list (contiguous). */
export const CI_TEST_PATH_ORDER_CHAIN = [
  "packages/verifier-runner/test/advisory-benchmark.test.ts",
  "packages/private-runner-isolation/test/isolation.test.ts",
  "packages/private-workspace-analytics/test/privacy.test.ts",
] as const;

/**
 * Extract ordered repo-relative path args from the CI `npx tsx --test` run block.
 * Lines must be indented list members (not bare shell commands).
 */
export function extractTsxTestPaths(ciYml: string): string[] {
  const start = ciYml.indexOf("npx tsx --test");
  assert.ok(start >= 0, "ci.yml must contain npx tsx --test");
  // Walk from the command line through continued lines until a non-continued path line.
  const fromCmd = ciYml.slice(start);
  const lines = fromCmd.split("\n");
  const paths: string[] = [];
  // Skip the `npx tsx --test \` line itself; following lines are path args.
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length === 0) break;
    // End of YAML block: unindented content or next job key.
    if (!/^\s+/.test(raw)) break;
    // Path args are package/app/scripts paths ending in .ts (optional trailing \).
    const m = trimmed.match(/^((?:packages|apps|scripts)\/\S+\.ts)\s*(\\?)\s*$/);
    if (!m) {
      // Stop when we leave the path list (e.g. blank already handled; other step keys).
      break;
    }
    paths.push(m[1]!);
    if (m[2] !== "\\") {
      // Last path of the list (no continuation).
      break;
    }
  }
  assert.ok(paths.length > 0, "ci.yml test-ts path list must be non-empty");
  return paths;
}

/**
 * Assert the load-bearing chain is a contiguous subsequence of the CI path list,
 * with line-continuation integrity on every non-final member of the full list.
 */
export function assertCiTestPathOrderChain(ciYml: string): void {
  const paths = extractTsxTestPaths(ciYml);
  const chain = [...CI_TEST_PATH_ORDER_CHAIN];
  const startIdx = paths.indexOf(chain[0]!);
  assert.ok(
    startIdx >= 0,
    `missing chain head ${chain[0]} in CI test-ts path list`,
  );
  for (let i = 0; i < chain.length; i++) {
    const expected = chain[i]!;
    const actual = paths[startIdx + i];
    assert.equal(
      actual,
      expected,
      `CI-ORD-1 chain break at offset ${i}: expected ${expected}, got ${actual ?? "<missing>"} (list must keep advisory→isolation→privacy contiguous)`,
    );
  }

  // F-004 style: every path line in the chain region (except the final path of
  // the whole list) must use YAML `|` indentation + trailing `\` continuation.
  // Re-read raw lines around each chain member.
  for (let i = 0; i < chain.length; i++) {
    const marker = chain[i]!;
    const idx = ciYml.indexOf(marker);
    assert.ok(idx >= 0, `${marker} present in ci.yml`);
    const lineStart = ciYml.lastIndexOf("\n", idx) + 1;
    const lineEnd = ciYml.indexOf("\n", idx);
    const line = ciYml.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    assert.ok(
      /^\s+(?:packages|apps|scripts)\//.test(line),
      `${marker} must remain an indented list arg (not a bare command)`,
    );
    // Last path of the entire extract may omit `\`; chain members that are not
    // the last overall path must continue.
    const isLastInList = paths[paths.length - 1] === marker;
    if (!isLastInList) {
      assert.match(
        line,
        /\\\s*$/,
        `${marker} must end with \\ so the next path stays on the same command`,
      );
    }
  }
}

describe("CI-ORD-1 — single-owner test-path order", () => {
  it("assertCiTestPathOrderChain: advisory → isolation → privacy contiguous", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const ciPath = resolve(here, "../../../.github/workflows/ci.yml");
    const text = readFileSync(ciPath, "utf8");
    assertCiTestPathOrderChain(text);
  });

  it("export chain is the only declared order contract", () => {
    assert.deepEqual([...CI_TEST_PATH_ORDER_CHAIN], [
      "packages/verifier-runner/test/advisory-benchmark.test.ts",
      "packages/private-runner-isolation/test/isolation.test.ts",
      "packages/private-workspace-analytics/test/privacy.test.ts",
    ]);
  });
});
