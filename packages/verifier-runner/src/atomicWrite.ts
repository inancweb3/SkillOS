/**
 * Fail-closed atomic file output for CLI result / report sidecars.
 * - Rejects symlinks and directories at destinations
 * - Writes exclusive same-dir temps with mode 0600 (O_NOFOLLOW when available)
 * - fsync then rename; multi-file commit is all-or-nothing for finals
 */

import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { BundleConsumerError } from "./errors.js";

const FILE_MODE = 0o600;

export type PlannedWrite = {
  path: string;
  content: string;
};

/**
 * Validate an output destination path: not a symlink, not a directory.
 * Missing path is OK (will be created via temp+rename).
 */
export function assertSafeOutputPath(path: string, label: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new BundleConsumerError(
      "CLI_OUTPUT",
      `${label}: path must be a non-empty string`,
    );
  }
  const abs = resolve(path);
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(abs);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    if (code === "ENOENT") {
      // Parent must exist for temp create
      try {
        lstatSync(dirname(abs));
      } catch {
        throw new BundleConsumerError(
          "CLI_OUTPUT",
          `${label}: parent directory does not exist`,
        );
      }
      return;
    }
    throw new BundleConsumerError(
      "CLI_OUTPUT",
      `${label}: cannot stat destination (${code ?? "error"})`,
    );
  }
  if (st.isSymbolicLink()) {
    throw new BundleConsumerError(
      "CLI_OUTPUT",
      `${label}: refusing to write through symlink`,
    );
  }
  if (st.isDirectory()) {
    throw new BundleConsumerError(
      "CLI_OUTPUT",
      `${label}: destination is a directory`,
    );
  }
  if (!st.isFile()) {
    throw new BundleConsumerError(
      "CLI_OUTPUT",
      `${label}: destination is not a regular file`,
    );
  }
}

function openExclusiveTemp(dir: string, base: string): { fd: number; tmpPath: string } {
  const token = randomBytes(8).toString("hex");
  const tmpPath = join(dir, `.${base}.${token}.tmp`);
  // O_NOFOLLOW where available (Node on macOS/Linux); fail closed if open races to a link.
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  try {
    const fd = openSync(tmpPath, flags, FILE_MODE);
    return { fd, tmpPath };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined;
    throw new BundleConsumerError(
      "CLI_OUTPUT",
      `failed to create exclusive temp for ${base} (${code ?? "error"})`,
    );
  }
}

function writeTempFile(tmpPath: string, fd: number, content: string): void {
  try {
    writeSync(fd, content, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Re-assert mode (umask may have altered; chmod the temp before rename).
  chmodSync(tmpPath, FILE_MODE);
}

/**
 * Write all planned outputs transactionally:
 * 1. Validate every destination
 * 2. Write exclusive temps + fsync
 * 3. Rename all; on any failure after partial rename, best-effort unlink finals written
 *    this commit and all temps. Guarantees: failure leaves no *new* final content from
 *    this call when rename has not completed for that path; pre-existing files at a
 *    path that was not successfully renamed are left untouched.
 */
export function writeOutputsAtomic(writes: PlannedWrite[]): void {
  if (writes.length === 0) return;

  // Collision: same resolved path twice
  const seen = new Set<string>();
  for (const w of writes) {
    const abs = resolve(w.path);
    if (seen.has(abs)) {
      throw new BundleConsumerError(
        "CLI_OUTPUT",
        "output path collision: same destination used more than once",
      );
    }
    seen.add(abs);
    assertSafeOutputPath(w.path, w.path);
  }

  type Temp = { finalPath: string; tmpPath: string };
  const temps: Temp[] = [];
  const renamed: string[] = [];

  try {
    for (const w of writes) {
      const finalPath = resolve(w.path);
      const dir = dirname(finalPath);
      const base = basename(finalPath);
      const { fd, tmpPath } = openExclusiveTemp(dir, base);
      try {
        writeTempFile(tmpPath, fd, w.content);
      } catch (err) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        throw err instanceof BundleConsumerError
          ? err
          : new BundleConsumerError(
              "CLI_OUTPUT",
              `write failed for ${base}: ${err instanceof Error ? err.message : String(err)}`,
            );
      }
      temps.push({ finalPath, tmpPath });
    }

    for (const t of temps) {
      try {
        renameSync(t.tmpPath, t.finalPath);
        chmodSync(t.finalPath, FILE_MODE);
        renamed.push(t.finalPath);
      } catch (err) {
        throw new BundleConsumerError(
          "CLI_OUTPUT",
          `atomic rename failed for ${basename(t.finalPath)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    // Best-effort cleanup of temps not yet renamed
    for (const t of temps) {
      try {
        unlinkSync(t.tmpPath);
      } catch {
        /* ignore */
      }
    }
    // Best-effort remove finals we renamed in this failed commit
    for (const p of renamed) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}
