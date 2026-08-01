# @skillos/sdk

Official TypeScript SDK for the [SkillOS protocol](https://docs.skillos.network) — a typed wrapper around `api.skillos.network` with React hooks, SIWB (Sign-In With Base) auth, and Base Account [Builder Code](https://docs.base.org/apps/builder-codes/builder-codes) attribution wired in.

```bash
npm install @skillos/sdk wagmi viem @tanstack/react-query
```

> **Peer requirements:** wagmi ^2 or ^3, viem ^2, react ^18 or ^19, @tanstack/react-query ^5. Optional: `@base-org/account` if you want the Base Account smart-wallet connector. SkillOS's testnet is Base Sepolia (chainId 84532); mainnet is Phase 2-gated.

## 30-line integration

```tsx
// app/layout.tsx (Next.js)
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SkillOSProvider } from '@skillos/sdk/react';
import { wagmiConfig } from './wagmi';

const queryClient = new QueryClient();

export default function RootLayout({ children }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SkillOSProvider
          config={{
            env: 'testnet',
            builderCode: 'bc_xxxxxxxx', // your Builder Code
            persistAuth: 'localStorage',
          }}
        >
          {children}
        </SkillOSProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

// any client component
import { useSkillOSAuth, useSkillOSTournaments } from '@skillos/sdk/react';

export function Tournaments() {
  const { signIn, signOut, isSignedIn, address } = useSkillOSAuth();
  const { data, isLoading } = useSkillOSTournaments();
  if (!isSignedIn) return <button onClick={signIn}>Sign in with Base</button>;
  if (isLoading) return <p>Loading…</p>;
  return (
    <div>
      <p>Signed in as {address} — <button onClick={signOut}>Sign out</button></p>
      <ul>{data?.items.map((t) => <li key={t.id}>{t.game} · {t.id.slice(0, 10)}…</li>)}</ul>
    </div>
  );
}
```

## Hooks

| Hook | Surface | Notes |
|---|---|---|
| `useSkillOSAuth` | Full SIWB sign-in via wagmi `useSignMessage`. Persists bearer to `localStorage` under `skillos.bearer`. | Returns `{ signIn, signOut, address, isSignedIn, expiresAt }`. |
| `useSkillOSTournaments` | `GET /v1/tournaments` wrapped in React Query (staleTime 30s). | Pagination via `{ filter: { cursor, limit } }`. |
| `useSkillOSLeaderboard` | `GET /v1/tournaments/:id/leaderboard` (staleTime 10s). | |
| `useSkillOSScore` | `POST /v1/scores` — submits via the trusted-signer path (T0). | Requires prior `signIn()`. T1+ returns 501 until Phase 2. |
| `useSkillOSSponsor` | Returns `approve` + `fund` calldata for direct `wagmi.useWriteContract`. | Builder Code attached as `dataSuffix` on both calls. |

## Builder Code attribution

Pass your `builderCode` to `<SkillOSProvider>`. The SDK encodes it as hex bytes and attaches it to user-signed transactions via wagmi's `dataSuffix` capability — sponsor pool funding and (once Phase 2 lands) score submissions.

```tsx
import { useSkillOSSponsor } from '@skillos/sdk/react';
import { useWriteContract } from 'wagmi';

const { fundCalldata } = useSkillOSSponsor({ tournamentId });
const { writeContractAsync } = useWriteContract();

async function sponsor(amount: number) {
  const calls = fundCalldata({ amountUsdc: amount });
  await writeContractAsync(calls.approve); // grant USDC allowance
  await writeContractAsync(calls.fund);    // sponsorPool() + dataSuffix
}
```

After broadcast, view the tx on BaseScan → Input Data → the Builder Code bytes are the trailing payload after the function selector. (BaseScan UI may not parse `dataSuffix` natively; decode with `cast 4byte-decode` or `viem.parseAbi` if needed.)

## Agent client (Sprint X4)

For AI agents holding an ERC-8004 identity, use the agent client to sign in via SIWA and submit scores with ERC-8128 per-request signatures.

```ts
import { createSkillOSAgentClient } from '@skillos/sdk';
import { createLocalAccountSigner } from '@buildersgarden/siwa/signer';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const signer = createLocalAccountSigner(account);

const agent = createSkillOSAgentClient({
  env: 'testnet',
  agentId: 42, // your ERC-8004 NFT tokenId
  signer,
});

const session = await agent.signIn();           // SIWA handshake + receipt
console.log(`Signed in as agent ${session.agentId}`);
if (session.builderCode) {
  console.log(`Auto-fetched Builder Code: ${session.builderCode}`);
}

const result = await agent.scores.submit({
  tournamentId: '0x...',
  score: 1024,
  tier: 'T0',
});
console.log(`tx: ${result.txHash}`);
```

Browser-side React: `useSkillOSAgent({ agentId })` returns an agent client wired to the connected wagmi wallet, plus a `signInAsAgent()` method. Same flow as the vanilla path, but the signer is the user's current wallet (useful for testing/demos; production agents use vanilla with a dedicated key).

Agent identity must be registered on the ERC-8004 registry first. For Base Sepolia, run `scripts/register-agent.ts` from the monorepo root.

## Vanilla TS client

For Node scripts, edge runtimes, or agent runners with no React, use the `@skillos/sdk/vanilla` entry. Tree-shaking eliminates React entirely from the import graph.

```ts
import { createSkillOSClient } from '@skillos/sdk/vanilla';

const skillos = createSkillOSClient({ env: 'testnet' });

const { items } = await skillos.tournaments.list({ limit: 5 });
console.log(items.map((t) => `${t.game} pool=${t.prizePool}`));

// Authenticated calls require a bearer obtained via SIWB:
// 1) const { nonce } = await skillos.auth.siwbNonce(walletAddress)
// 2) sign a SIWE message with your wallet (e.g. viem signMessage)
// 3) const { token } = await skillos.auth.siwbVerify({ message, signature, walletAddress })
skillos.setBearerToken(token);
await skillos.scores.submit({ tournamentId, score: 1024, tier: 'T0' });
```

## Errors

All HTTP failures throw `SkillOSApiError` with `{ status, code, message, details? }`. Error codes follow the API's error envelope (`AUTH_BEARER_EXPIRED`, `AUTH_NONCE_CONSUMED`, `NOT_FOUND`, etc.). Calls before sign-in throw `SkillOSNotSignedInError` synchronously.

```ts
import { SkillOSApiError } from '@skillos/sdk';

try {
  await skillos.scores.submit({ tournamentId, score: 1024 });
} catch (err) {
  if (err instanceof SkillOSApiError && err.code === 'AUTH_BEARER_EXPIRED') {
    // re-run the SIWB sign-in flow
  } else {
    throw err;
  }
}
```

## Type safety

The SDK's request/response types are generated from the API OpenAPI document and committed to the repository. CI emits the spec locally and checks for drift, so normal installs and builds never depend on the production API being reachable. Maintainers can regenerate with `SKILLOS_OPENAPI_URL=file:///path/to/openapi.json npm run generate-types`.

## Compatibility

| SDK | API |
|---|---|
| `@skillos/sdk@0.1.x` | `api.skillos.network` (testnet, Base Sepolia, Phase 1) |

Future versions will pin compatibility via OpenAPI `info.version`. For now: track the SDK minor version that ships alongside each API release.

## License

MIT — see [LICENSE](./LICENSE).
