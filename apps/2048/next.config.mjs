/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Env-driven basePath. Unset on mas-2048 (serves at root, byte-identical to
  // before); set to "/2048" on the arena-2048 deployment so the app serves at
  // arena.skillos.network/2048. `|| undefined` keeps Next's default (no
  // basePath) when the env var is absent. Same-origin /api fetch() strings are
  // basePath-prefixed at the call site via @skillos/ui's apiUrl() helper —
  // Next does not auto-prefix runtime fetch.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  // Workspace packages ship TypeScript sources (no build step). Next must
  // transpile them alongside the app's own src/.
  transpilePackages: [
    "@skillos/contracts",
    "@skillos/duel-backend",
    "@skillos/game-types",
    "@skillos/lib-shared",
    "@skillos/ui",
  ],
  webpack: (config) => {
    // We only use coinbaseWallet + injected from @wagmi/connectors. The
    // package barrel-imports optional peer deps (porto, @base-org/account,
    // @metamask/connect-evm, @safe-global/*) that we don't install. Stub
    // their resolution so webpack can tree-shake the dead connectors.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      porto: false,
      "porto/internal": false,
      "porto/core/internal": false,
      "porto/wagmi": false,
      "@base-org/account": false,
      "@metamask/connect-evm": false,
      "@safe-global/safe-apps-sdk": false,
      "@safe-global/safe-apps-provider": false,
      "@walletconnect/ethereum-provider": false,
      accounts: false,
      pino: false,
      "pino-pretty": false,
      encoding: false,
      // @buildersgarden/siwa ships signer factories for Circle, Openfort, Privy
      // as peer-optional deps. apps/2048's /dev/sdk-demo only uses the wagmi
      // walletClient signer, so the others can be stubbed at bundle time.
      "@circle-fin/developer-controlled-wallets": false,
      "@openfort/openfort-node": false,
      "@privy-io/server-auth": false,
      // siwa.dist.identity imports fs for filesystem-backed keystore (server-
      // side only). Browser bundle doesn't use it; stub the Node built-in.
      fs: false,
    };
    return config;
  },
  // Browsers, RSS readers, scrapers, and link-preview tools hit /favicon.ico
  // regardless of <link rel="icon"> hints. 307 to /icon (the metadata route)
  // kills the 404 noise and keeps a single source of truth. Non-permanent so
  // we can swap in a real multi-size .ico later without poisoned caches.
  redirects: async () => [
    {
      source: "/favicon.ico",
      destination: "/icon",
      permanent: false,
    },
  ],
};

export default nextConfig;
