#!/usr/bin/env node
/**
 * Phase 1C — external consumer / publish-readiness smoke.
 *
 * 1. npm pack @skillos/protocol
 * 2. Install tarball into a clean, monorepo-outside temp project
 * 3. TypeScript typecheck (skipLibCheck: false) + Node 20 runtime smoke
 * 4. Browser IIFE bundle executed in a browser-like vm sandbox
 * 5. Assert public exports, allowlisted pack contents, Simpl3 safety binding
 *
 * All subprocesses: spawnSync(command, args, { shell: false }).
 * Local bins via: npx --no-install <tool> …
 *
 * Run: npm run test:external-consumer -w @skillos/protocol
 * Does NOT publish to npm.
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const tarballName = "skillos-protocol-0.1.0.tgz";

/** Exact top-level package files allowed in the tarball. */
const ALLOWED_EXACT = new Set([
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
]);

/** Every other entry must start with one of these prefixes. */
const ALLOWED_PREFIXES = [
  "package/dist/",
  "package/schemas/",
  "package/fixtures/",
  "package/docs/",
  "package/examples/",
];

/** Must be present for a usable package. */
const REQUIRED_ENTRIES = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/index.js",
  "package/dist/index.d.ts",
];

/** Known digest of JCS({"hello":"browser"}). Empty SHA-256 must never pass. */
const EXPECTED_HELLO_BROWSER_DIGEST =
  "sha256:46e3d490777f7b0340ac80c9e70d61a2e3157c022cc495a47782d067e6e98998";
const EMPTY_SHA256 =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function log(msg) {
  console.log(`[external-consumer] ${msg}`);
}

/**
 * Argv-only subprocess — never shell: true.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} [opts]
 */
function runArgv(command, args, opts = {}) {
  const display = [command, ...args].map((a) =>
    /\s/.test(a) ? JSON.stringify(a) : a,
  ).join(" ");
  log(`$ ${display}`);
  const r = spawnSync(command, args, {
    shell: false,
    encoding: "utf8",
    ...opts,
  });
  if (r.error) {
    throw new Error(`spawn failed: ${command}: ${r.error.message}`);
  }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) {
    throw new Error(
      `Command failed (${r.status}): ${command} ${args.join(" ")}`,
    );
  }
  return r;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function isAllowedTarballEntry(entry) {
  if (ALLOWED_EXACT.has(entry)) return true;
  return ALLOWED_PREFIXES.some((p) => entry.startsWith(p));
}

/**
 * Cross-realm-safe BufferSource → host-owned Uint8Array for Node SubtleCrypto.
 */
function bufferSourceToHostUint8Array(data) {
  if (ArrayBuffer.isView(data)) {
    return Uint8Array.from(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  return Uint8Array.from(new Uint8Array(data));
}

function hostCryptoBridge() {
  const host = globalThis.crypto;
  return {
    getRandomValues: host.getRandomValues.bind(host),
    subtle: {
      digest(algorithm, data) {
        const hostOwned = bufferSourceToHostUint8Array(data);
        return host.subtle.digest(algorithm, hostOwned);
      },
    },
  };
}

let tarballPath = join(pkgRoot, tarballName);
let consumerRoot = null;

try {
  // ── 1. Pack ───────────────────────────────────────────────────────────
  log(`package root: ${pkgRoot}`);
  process.chdir(pkgRoot);

  if (existsSync(tarballPath)) unlinkSync(tarballPath);

  runArgv("npm", ["pack"], { cwd: pkgRoot });
  assert(existsSync(tarballPath), `expected tarball at ${tarballPath}`);

  // ── 2. Tarball allowlist ──────────────────────────────────────────────
  const listOut = runArgv("tar", ["-tzf", tarballPath], {
    cwd: pkgRoot,
  }).stdout;
  const entries = listOut
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  log(`tarball entries: ${entries.length}`);
  for (const req of REQUIRED_ENTRIES) {
    assert(entries.includes(req), `tarball missing required entry: ${req}`);
  }
  for (const e of entries) {
    assert(
      isAllowedTarballEntry(e),
      `tarball entry not on allowlist: ${e}`,
    );
  }
  for (const prefix of ALLOWED_PREFIXES) {
    assert(
      entries.some((e) => e.startsWith(prefix)),
      `tarball missing any file under ${prefix}`,
    );
  }

  // ── 3. Clean external consumer (outside monorepo) ─────────────────────
  consumerRoot = mkdtempSync(join(tmpdir(), "skillos-protocol-consumer-"));
  log(`consumer root: ${consumerRoot}`);
  mkdirSync(join(consumerRoot, "src"), { recursive: true });

  const consumerPkg = {
    name: "skillos-protocol-external-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: {
      "@skillos/protocol": `file:${tarballPath}`,
    },
    devDependencies: {
      typescript: "^5.6.3",
      esbuild: "^0.25.0",
      "@types/node": "^20",
    },
    engines: { node: ">=20.0.0" },
  };

  writeFileSync(
    join(consumerRoot, "package.json"),
    JSON.stringify(consumerPkg, null, 2) + "\n",
  );

  writeFileSync(
    join(consumerRoot, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          // Must surface published .d.ts errors (publish-readiness).
          skipLibCheck: false,
          noEmit: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          types: ["node"],
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ) + "\n",
  );

  // Node smoke: public API + package-specifier resolve for schema + fixture.
  const nodeSmokeSrc = `/**
 * External consumer Node smoke — only @skillos/protocol public package surface.
 * Schema and fixture paths are resolved via package exports (createRequire).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  parseAndValidateSchema,
  assertDigestBinding,
  digestManifest,
  digestEvidence,
  digestJsonValue,
  canonicalize,
  type BenchmarkManifest,
  type EvidenceEnvelope,
  type VerificationResult,
  type VerifierDescriptor,
} from "@skillos/protocol";

const require = createRequire(import.meta.url);

/** Resolve + parse a JSON resource published under package exports. */
function loadPackageJson(specifier: string): unknown {
  const resolved = require.resolve(specifier);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

// Exported schema (package specifier — not a filesystem path into monorepo).
const evidenceSchema = loadPackageJson(
  "@skillos/protocol/schemas/evidence-envelope.schema.json",
) as { $id?: string; title?: string; type?: string };
if (evidenceSchema.title !== "EvidenceEnvelope") {
  throw new Error(
    \`unexpected schema title: \${String(evidenceSchema.title)}\`,
  );
}
if (evidenceSchema.type !== "object") {
  throw new Error("evidence schema type must be object");
}

// Exported fixture via package specifier.
const manifest = loadPackageJson(
  "@skillos/protocol/fixtures/simpl3-safety/manifest.json",
) as BenchmarkManifest;
const evidence = loadPackageJson(
  "@skillos/protocol/fixtures/simpl3-safety/evidence.json",
) as EvidenceEnvelope;
const verifier = loadPackageJson(
  "@skillos/protocol/fixtures/shared/verifier.json",
) as VerifierDescriptor;
const result = loadPackageJson(
  "@skillos/protocol/fixtures/simpl3-safety/result.json",
) as VerificationResult;

if (PROTOCOL_VERSION !== "0.1.0") {
  throw new Error(\`unexpected PROTOCOL_VERSION \${PROTOCOL_VERSION}\`);
}

parseAndValidateSchema(manifest, "BenchmarkManifest");
parseAndValidateSchema(evidence, "EvidenceEnvelope");
parseAndValidateSchema(verifier, "VerifierDescriptor");
parseAndValidateSchema(result, "VerificationResult");

await assertDigestBinding({
  manifest,
  evidence,
  verifier,
  result,
  checkMeasurements: true,
});

const md = await digestManifest(manifest);
const ed = await digestEvidence(evidence);
if (md !== evidence.manifestDigest) {
  throw new Error("manifest digest mismatch vs evidence.manifestDigest");
}
if (ed !== result.evidenceDigest) {
  throw new Error("evidence digest mismatch vs result.evidenceDigest");
}

const pin = await digestJsonValue({ consumer: "external", v: 1 });
const miniManifest: BenchmarkManifest = {
  ...manifest,
  benchmarkId: "external.consumer.smoke",
  inputSchemaHash: pin,
};
parseAndValidateSchema(miniManifest, "BenchmarkManifest");
const c = canonicalize({ b: 2, a: 1 });
if (c !== '{"a":1,"b":2}') throw new Error(\`bad JCS: \${c}\`);

console.log(
  JSON.stringify({
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    taskType: manifest.taskType,
    schemaTitle: evidenceSchema.title,
    manifestDigest: md,
    evidenceDigest: ed,
    resultStatus: result.status,
  }),
);
`;

  writeFileSync(join(consumerRoot, "src/node-smoke.ts"), nodeSmokeSrc);

  writeFileSync(
    join(consumerRoot, "src/browser-entry.ts"),
    `import {
  canonicalize,
  digestJsonValue,
  PROTOCOL_VERSION,
  parseAndValidateSchema,
} from "@skillos/protocol";

export async function browserConsumerSmoke(): Promise<{
  ok: true;
  protocolVersion: string;
  digest: string;
  canonical: string;
}> {
  const canonical = canonicalize({ b: 2, a: 1 });
  if (canonical !== '{"a":1,"b":2}') {
    throw new Error(\`unexpected JCS: \${canonical}\`);
  }
  const digest = await digestJsonValue({ hello: "browser" });
  parseAndValidateSchema(
    { id: "score", valueType: "number", required: true },
    "MeasurementDefinition",
  );
  return { ok: true, protocolVersion: PROTOCOL_VERSION, digest, canonical };
}
`,
  );

  // ── 4. Install tarball ────────────────────────────────────────────────
  runArgv("npm", ["install", "--no-fund", "--no-audit"], {
    cwd: consumerRoot,
  });

  const nmProtocol = join(consumerRoot, "node_modules/@skillos/protocol");
  assert(existsSync(nmProtocol), "node_modules/@skillos/protocol missing");

  // Workspace-link guard: lstat symlink + realpath under consumer nm only.
  const linkStat = lstatSync(nmProtocol);
  assert(
    !linkStat.isSymbolicLink(),
    "installed package must not be a symbolic link (workspace link)",
  );
  const realPkg = realpathSync(nmProtocol);
  const realConsumerNm = realpathSync(join(consumerRoot, "node_modules"));
  assert(
    realPkg.startsWith(realConsumerNm + sep),
    `installed package realpath must be under consumer node_modules${sep} (got ${realPkg})`,
  );

  const installedPkg = JSON.parse(
    readFileSync(join(nmProtocol, "package.json"), "utf8"),
  );
  assert(installedPkg.name === "@skillos/protocol", "installed name");
  assert(installedPkg.version === "0.1.0", "installed version");
  assert(
    existsSync(join(nmProtocol, "dist/index.js")),
    "dist/index.js present after install",
  );
  assert(
    existsSync(join(nmProtocol, "dist/index.d.ts")),
    "dist/index.d.ts present after install",
  );

  // ── 5. TypeScript typecheck (skipLibCheck: false) ─────────────────────
  // Local bin only — package already installed in consumer.
  runArgv("npx", ["--no-install", "tsc", "--noEmit"], {
    cwd: consumerRoot,
  });
  log("TypeScript typecheck PASS (skipLibCheck: false)");

  // ── 6. Node 20 runtime smoke ──────────────────────────────────────────
  mkdirSync(join(consumerRoot, "dist-smoke"), { recursive: true });
  runArgv(
    "npx",
    [
      "--no-install",
      "esbuild",
      "src/node-smoke.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--packages=external",
      "--outfile=dist-smoke/node-smoke.js",
    ],
    { cwd: consumerRoot },
  );
  const nodeSmoke = runArgv(process.execPath, ["dist-smoke/node-smoke.js"], {
    cwd: consumerRoot,
  });
  assert(
    nodeSmoke.stdout.includes('"ok":true'),
    "node smoke must print ok:true",
  );
  assert(
    nodeSmoke.stdout.includes('"schemaTitle":"EvidenceEnvelope"'),
    "node smoke must confirm package-specifier schema resolve",
  );
  log("Node 20 runtime smoke PASS");

  // ── 7. Browser IIFE + browser-like vm sandbox ─────────────────────────
  runArgv(
    "npx",
    [
      "--no-install",
      "esbuild",
      "src/browser-entry.ts",
      "--bundle",
      "--platform=browser",
      "--format=iife",
      "--global-name=ExternalProtocolConsumer",
      "--target=es2022",
      "--outfile=dist-smoke/browser.iife.js",
    ],
    { cwd: consumerRoot },
  );
  const browserJs = readFileSync(
    join(consumerRoot, "dist-smoke/browser.iife.js"),
    "utf8",
  );
  assert(browserJs.length > 100, "browser IIFE non-empty");
  assert(!browserJs.includes("node:crypto"), "browser IIFE has node:crypto");
  assert(!browserJs.includes("node:fs"), "browser IIFE has node:fs");
  assert(!browserJs.includes("node:path"), "browser IIFE has node:path");
  assert(!browserJs.includes("node:url"), "browser IIFE has node:url");
  assert(
    !browserJs.includes("packages/protocol"),
    "browser IIFE must not embed monorepo paths",
  );
  assert(
    !/require\(["']node:/.test(browserJs),
    "browser IIFE must not require node: modules",
  );

  const sandbox = {
    crypto: hostCryptoBridge(),
    TextEncoder,
    TextDecoder,
    console,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  Object.defineProperty(sandbox, "process", {
    get() {
      throw new Error("process is not available in browser sandbox");
    },
    configurable: true,
  });
  Object.defineProperty(sandbox, "Buffer", {
    get() {
      throw new Error("Buffer is not available in browser sandbox");
    },
    configurable: true,
  });
  Object.defineProperty(sandbox, "require", {
    get() {
      throw new Error("require is not available in browser sandbox");
    },
    configurable: true,
  });

  vm.createContext(sandbox);
  vm.runInContext(browserJs, sandbox, { timeout: 10_000 });

  const api = sandbox.ExternalProtocolConsumer;
  assert(
    api && typeof api.browserConsumerSmoke === "function",
    `ExternalProtocolConsumer.browserConsumerSmoke missing (keys: ${api ? Object.keys(api).join(",") : "null"})`,
  );

  const out = await api.browserConsumerSmoke();
  assert(out.ok === true, "browser smoke not ok");
  assert(out.protocolVersion === "0.1.0", "protocolVersion");
  assert(out.canonical === '{"a":1,"b":2}', "canonical");
  assert(out.digest !== EMPTY_SHA256, "digest must not be empty SHA-256");
  assert(
    out.digest === EXPECTED_HELLO_BROWSER_DIGEST,
    `digest mismatch: got ${out.digest}`,
  );
  log("Browser IIFE vm sandbox smoke PASS");

  // ── 8. Exports map sanity ─────────────────────────────────────────────
  const exportsMap = installedPkg.exports;
  assert(exportsMap["."], "exports[.] required");
  assert(exportsMap["."].import === "./dist/index.js", "exports import path");
  assert(exportsMap["."].types === "./dist/index.d.ts", "exports types path");
  assert(exportsMap["./fixtures/*"], "fixtures export");
  assert(exportsMap["./schemas/*"], "schemas export");
  assert(installedPkg.license === "Apache-2.0", "license");
  assert(installedPkg.engines?.node === ">=20.0.0", "engines.node");

  const distJs = readFileSync(join(nmProtocol, "dist/index.js"));
  const distHash = createHash("sha256").update(distJs).digest("hex").slice(0, 16);

  log("ALL EXTERNAL CONSUMER CHECKS PASS");
  console.log(
    JSON.stringify(
      {
        ok: true,
        package: "@skillos/protocol@0.1.0",
        tarball: tarballName,
        distIndexSha256Prefix: distHash,
        browserDigest: out.digest,
      },
      null,
      2,
    ),
  );
} finally {
  const keepConsumer = process.env.KEEP_CONSUMER === "1";
  if (consumerRoot && existsSync(consumerRoot)) {
    if (!keepConsumer) {
      try {
        rmSync(consumerRoot, { recursive: true, force: true });
        log("consumer temp dir removed (finally)");
      } catch (e) {
        console.error("finally: failed to remove consumer", e);
      }
    } else {
      log(`KEEP_CONSUMER=1 — left at ${consumerRoot}`);
    }
  }
  const keepTarball = process.env.KEEP_TARBALL === "1";
  if (!keepTarball && tarballPath && existsSync(tarballPath)) {
    try {
      unlinkSync(tarballPath);
      log("tarball removed (finally)");
    } catch (e) {
      console.error("finally: failed to remove tarball", e);
    }
  }
}
