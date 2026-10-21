# ADR 0001: TypeScript, ESM, zero runtime dependencies

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** Project maintainers

## Context

The MVP is a Node.js library that must be easy to audit, install, and embed. It
needs published type declarations, modern async support, and predictable package
resolution. The project starts from an empty repository with no legacy consumers.
Potential consumers use TypeScript or plain JavaScript.

Candidate directions:

1. TypeScript compiled to ESM, zero runtime dependencies.
2. TypeScript with a small set of runtime helpers (for example a schema library).
3. CommonJS with dual ESM/CJS builds.
4. An unbuilt TypeScript package relying on a runtime loader.

## Decision

- Implement in TypeScript, strict mode, targeting ES2022.
- Publish **ESM only** (`"type": "module"`, `exports` with `import`/`types`).
- Require Node.js `>=22.0.0`.
- Keep **zero runtime dependencies**; use Node.js built-ins only.
- Build with `tsc` to `dist/`, emitting declarations, declaration maps, and source maps.
- Use dev-only tooling: TypeScript, `tsx`, Biome, and `@types/node`.

## Consequences

Positive:

- Minimal supply-chain and install surface.
- One module format and one resolution model.
- Types ship with the package; no separate `@types` package.
- Node 22+ has stable `AbortSignal`, `node:test`, and `perf_hooks` APIs.
- Consumers can inspect the emitted JavaScript easily.

Negative:

- CommonJS consumers must use dynamic `import()` or an ESM-capable loader.
- No browser or Deno support in the MVP.
- Some utility code is written locally instead of delegated.
- Node 22+ excludes older LTS lines.

## Alternatives considered

- **Dual CJS/ESM:** doubles build and test surface and introduces dual-package
  hazard for little benefit in a new library.
- **Schema validation dependency:** provider payloads are small and the validation
  rules are simple; local validation keeps the dependency count at zero.
- **Unbuilt TypeScript:** shifts loader configuration to consumers and complicates
  publishing. A compiled artifact is more predictable.

## Follow-up

- Revisit module format only with concrete consumer demand and a migration plan.
- Revisit the Node floor when a required API or support policy justifies it; the
  floor must remain consistent across `engines`, README, and CI.
