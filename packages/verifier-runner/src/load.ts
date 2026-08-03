import { openSync, fstatSync, readFileSync, closeSync, constants } from "node:fs";
import { parseJsonStrict } from "@skillos/protocol";
import { BundleConsumerError } from "./errors.js";

/**
 * Load a portable bundle JSON file with basic fail-closed file checks.
 * Rejects non-regular files. Does not follow the Simpl3 O_NOFOLLOW path model
 * fully (no symlink-component walk); callers should supply trusted local paths.
 */
export function loadBundleFile(path: string): Record<string, unknown> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new BundleConsumerError(
        "LOAD_FAILED",
        `path is not a regular file: ${path}`,
      );
    }
    if (st.size > 32 * 1024 * 1024) {
      throw new BundleConsumerError(
        "LOAD_FAILED",
        `bundle file exceeds 32 MiB limit: ${path}`,
      );
    }
    const buf = readFileSync(fd);
    const text = buf.toString("utf8");
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
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BundleConsumerError) throw err;
    throw new BundleConsumerError(
      "LOAD_FAILED",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
