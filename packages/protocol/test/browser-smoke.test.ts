/**
 * Browser-bundle smoke: esbuild IIFE without node: builtins, exercise Web Crypto path.
 *
 * Runs the bundle in a vm sandbox approximating a browser. Node's SubtleCrypto
 * rejects cross-realm ArrayBuffers from `vm`, so digest is bridged to the host
 * crypto with a host-owned Buffer copy (real browsers do not have this issue).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import vm from "node:vm";
import { Buffer } from "node:buffer";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "browser-entry.ts");

function hostCryptoBridge(): Crypto {
  const host = globalThis.crypto;
  return {
    getRandomValues: host.getRandomValues.bind(host),
    subtle: {
      digest(
        algorithm: AlgorithmIdentifier,
        data: BufferSource,
      ): Promise<ArrayBuffer> {
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(
                (data as ArrayBufferView).buffer,
                (data as ArrayBufferView).byteOffset,
                (data as ArrayBufferView).byteLength,
              );
        // Host-realm Buffer — accepted by Node SubtleCrypto under vm.
        const hostOwned = Buffer.from(view);
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

    const sandbox: Record<string, unknown> = {
      crypto: hostCryptoBridge(),
      TextEncoder,
      TextDecoder,
      console,
      Buffer,
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
    assert.match(out.digest, /^sha256:[0-9a-f]{64}$/);
  });
});
