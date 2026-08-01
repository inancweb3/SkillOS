# Privacy and onchain placement (v0.1)

Normative map from ADR 0005 D4. Protocol v0.1 **does not require** writing any field onchain.

## Onchain-safe (summaries / digests)

- Identity / reference IDs
- Manifest / evidence / result digests (`sha256:…`)
- Verifier identity digests
- Optional summary measurements
- Settlement receipt refs (later phases)

## Offchain / private only

- Prompts, chain-of-thought
- Raw tool traces
- Hidden tests / private datasets
- User portfolio balances, enterprise data
- CDP / provider API keys and secrets
- Large blobs

## Public evidence rules

Public `EvidenceEnvelope` fields **MUST NOT** contain:

- raw prompts
- private tool traces
- hidden tests
- user portfolio balances
- CDP secrets or provider API keys

Those live only in private offchain stores; public evidence may carry **digests** and `availability: "redacted"` artifacts.

## Evaluation identity

Simpl3 production CDP / Server Wallet / live-fund Base Accounts **MUST NOT** be the default evaluation subject. Use a dedicated evaluation identity per build/config for pilots.
