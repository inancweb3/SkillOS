# Semver rules (v0.1)

## Two version axes

| Axis | Field / package | v0.1 rule |
|------|-----------------|-----------|
| **Protocol document version** | `protocolVersion` on every top-level document | Exact const **`"0.1.0"`** under the v0.1 schema registry |
| **npm package version** | `@skillos/protocol` | Currently **`0.1.0`**; may patch independently |

## Package patch ≠ protocol document version

npm/package **patch** releases (`0.1.1`, `0.1.2`, …) **MUST NOT**:

- change the accepted `protocolVersion` string
- change the normative v0.1 document shape
- silently accept other protocol versions

Patches may fix validators, docs, fixtures, or tooling only.

## New schema fields

Adding fields, removing required fields, or changing semantics requires:

1. A **new protocol version** (e.g. `"0.2.0"`)
2. A **new schema registry entry**

v0.1 clients **MUST NOT** silently accept other protocol versions (`UNSUPPORTED_PROTOCOL_VERSION`).

## Compatibility intent (future)

- Minor protocol versions may add optional fields only when a new registry entry documents them.
- Breaking changes require a major protocol bump.
- Both SkillOS and Simpl3 should pin the same golden fixtures for contract tests.
