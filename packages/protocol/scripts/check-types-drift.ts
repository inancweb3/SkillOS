/**
 * ADR 0004-style drift gate: regenerate types and fail if types.generated.ts changes.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const generated = join(root, "src", "types.generated.ts");

const before = readFileSync(generated, "utf8");
const r = spawnSync(
  process.execPath,
  ["--import", "tsx", join(root, "scripts", "generate-types.ts")],
  { cwd: root, encoding: "utf8" },
);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  process.exit(r.status ?? 1);
}
const after = readFileSync(generated, "utf8");
if (before !== after) {
  // restore so the working tree is not left dirty by the check alone when used in CI after clean gen
  writeFileSync(generated, before, "utf8");
  console.error(
    "DRIFT: src/types.generated.ts is out of date with schemas/*.schema.json",
  );
  console.error("Run: npm run generate-types -w @skillos/protocol");
  process.exit(1);
}
console.log("types.generated.ts matches schemas (no drift)");
