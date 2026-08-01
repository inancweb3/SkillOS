/**
 * Browser-bundle smoke: esbuild IIFE without node: builtins, exercise Web Crypto path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "browser-entry.ts");

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

    // Sandbox approximates a browser: Web Crypto present, no Node builtins.
    const sandbox: Record<string, unknown> = {
      crypto: globalThis.crypto,
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
    assert.match(out.digest, /^sha256:[0-9a-f]{64}$/);
  });
});
