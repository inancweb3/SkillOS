/**
 * Browser-bundle smoke: esbuild IIFE without node: builtins, exercise Web Crypto path.
 *
 * Runs the bundle in a vm sandbox approximating a browser. Node's SubtleCrypto
 * rejects cross-realm ArrayBuffers from `vm`, so digest is bridged to the host
 * crypto with a host-owned Uint8Array copy (real browsers do not have this issue).
 *
 * Cross-realm caveat: `data instanceof ArrayBuffer` is false for vm ArrayBuffers.
 * Always branch with `ArrayBuffer.isView(data)` first, then treat the rest as
 * ArrayBuffer and copy with `Uint8Array.from(...)`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "browser-entry.ts");

/** Known digest of JCS({"hello":"browser"}) — empty SHA-256 must never pass. */
const EXPECTED_HELLO_BROWSER_DIGEST =
  "sha256:46e3d490777f7b0340ac80c9e70d61a2e3157c022cc495a47782d067e6e98998";

const EMPTY_SHA256 =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Copy a BufferSource that may originate in another JS realm into a host-owned
 * Uint8Array that Node SubtleCrypto accepts.
 */
function bufferSourceToHostUint8Array(data: BufferSource): Uint8Array {
  // Cross-realm ArrayBuffer fails `instanceof ArrayBuffer` in the host realm.
  // Prefer ArrayBuffer.isView (works across realms) before treating as ArrayBuffer.
  if (ArrayBuffer.isView(data)) {
    return Uint8Array.from(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  // Remaining BufferSource is ArrayBuffer (possibly cross-realm).
  return Uint8Array.from(new Uint8Array(data as ArrayBuffer));
}

function hostCryptoBridge(): Crypto {
  const host = globalThis.crypto;
  return {
    getRandomValues: host.getRandomValues.bind(host),
    subtle: {
      digest(
        algorithm: AlgorithmIdentifier,
        data: BufferSource,
      ): Promise<ArrayBuffer> {
        const hostOwned = bufferSourceToHostUint8Array(data);
        return host.subtle.digest(algorithm, hostOwned);
      },
    } as SubtleCrypto,
  } as Crypto;
}

describe("browser bundle smoke", () => {
  it("bundles without node builtins and runs smoke()", async () => {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "SkillOSProtocolBrowser",
      platform: "browser",
      target: ["es2022"],
      logLevel: "silent",
    });
    const code = result.outputFiles[0]?.text ?? "";
    assert.ok(code.length > 100, "bundle non-empty");
    // Must not pull Node-only modules (Web Crypto is global in browsers).
    assert.equal(code.includes("node:crypto"), false);
    assert.equal(code.includes("node:fs"), false);
    assert.equal(code.includes("node:path"), false);
    assert.equal(code.includes("node:url"), false);
    assert.equal(/from ["']fs["']/.test(code), false);

    // No Node Buffer in sandbox — browser-like globals only.
    const sandbox: Record<string, unknown> = {
      crypto: hostCryptoBridge(),
      TextEncoder,
      TextDecoder,
      console,
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { timeout: 5000 });

    const api = sandbox.SkillOSProtocolBrowser as {
      browserSmoke: () => Promise<{
        ok: true;
        protocolVersion: string;
        digest: string;
        canonical: string;
      }>;
    };
    assert.equal(typeof api?.browserSmoke, "function");
    const out = await api.browserSmoke();
    assert.equal(out.ok, true);
    assert.equal(out.protocolVersion, "0.1.0");
    assert.equal(out.canonical, '{"a":1,"b":2}');
    // Exact digest — must not equal empty-input SHA-256 (false-green trap).
    assert.notEqual(out.digest, EMPTY_SHA256);
    assert.equal(out.digest, EXPECTED_HELLO_BROWSER_DIGEST);
  });
});
