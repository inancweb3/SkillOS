// apiUrl — prefix a root-relative API path with the deployment basePath.
//
// Next.js `basePath` auto-prefixes <Link>/next/image and serves API routes
// under the basePath, but it does NOT rewrite runtime fetch() strings. An app
// deployed under a basePath (e.g. arena.skillos.network/2048, which sets
// NEXT_PUBLIC_BASE_PATH=/2048) must route every same-origin /api fetch through
// this helper so it resolves to `${basePath}/api/...` instead of 404ing at
// the domain root.
//
// No-op when NEXT_PUBLIC_BASE_PATH is unset — which is every non-arena build
// (mas-2048, sponsor, …). In that case it returns the path unchanged, so the
// emitted network calls are byte-identical to before. NEXT_PUBLIC_* is inlined
// at build time per consuming app (this package ships TS source via
// transpilePackages), so the basePath is resolved per deployment.
export const apiUrl = (path: string): string =>
  `${process.env.NEXT_PUBLIC_BASE_PATH || ""}${path}`;
