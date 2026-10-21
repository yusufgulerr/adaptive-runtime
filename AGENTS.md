# Adaptive Runtime — Project Rules for Agents

## Release and VCS policy (highest priority)

- Public repository: `https://github.com/yusufgulerr/adaptive-runtime`.
- Normal work may be committed and pushed to `main`. Do not force-push `main` or
  rewrite published release tags.
- Publishing a new npm version or creating a GitHub release requires explicit
  user approval for that version.
- Do not describe a release as published, released, or remotely verified until
  the actual npm/GitHub commands succeed and the result is checked.
- Never add fake repository URLs, badges, maintainer identities, tokens, or
  secrets. Never commit `.env`, credentials, local state, `node_modules`, `dist`,
  or coverage output.
- Only `@yusufgulerr` has write/admin access. External contributions use forks and
  pull requests. Do not grant write, triage, admin, deploy-key, or GitHub App
  access without explicit user approval.
- Do not bypass required reviews for external pull requests. The owner's admin
  bypass is only for the owner's own pull requests, because GitHub does not allow
  self-approval.

## Current position

- Version 0.1.0 on the 0.x line. The public repository exists and CI/CodeQL pass
  remotely on Node 22/24/26. npm publication is prepared but not yet performed.
- The core runtime is implemented: bounded operation state, modular policy core,
  root/policy/provider subpath exports, observability, and release automation.
- Continue hardening: post-publish verification, benchmark trend tracking, and
  the remaining 0.2/0.3 roadmap items.
- Node.js `>=22.0.0`; locally verified on Node 24.15.0, CI configured for
  22/24/26.

## Commands

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run benchmark
npm pack --dry-run
```

Run the full set before claiming a change is complete. Use real command output,
not expectations.

## Engineering invariants

- ESM only; zero runtime dependencies.
- Policy core stays pure and provider-independent; no Node APIs in
  `src/policy/`.
- Exactly one strategy execution per `run()`; no automatic retries, hedges, or
  mid-run switches.
- Unavailable signals are never coerced to `0`; statuses stay explicit.
- Deterministic tie-breaking uses code-unit id comparison, not locale-dependent
  comparison.
- Cancellation/timeouts are cooperative; never claim synchronous preemption.
- Strategy and provider code is trusted; this is not a security sandbox.
- Provider and listener failures must not crash the operation.
- Keep the public API minimal and intentional. Document new public behavior in
  `docs/API.md`, `CHANGELOG.md`, and tests.
- Add an ADR for decisions that change semantics or public contracts.
- No placeholders, TODOs, disabled tests, or invented measurements.

## Windows shell

- Shell is PowerShell; use UTF-8 output settings for commands that print text.
- Prefer `%TEMP%\opencode` for temporary files.
- Do not chain noise-producing separators in reported command output.

## Known external facts

- `npm view adaptive-runtime version` returned 404 on 2026-10-21; the name was
  not reserved at that time.
- An unrelated public repository named `sevlaq-labs/adaptive-runtime` exists.
- `origin` is `https://github.com/yusufgulerr/adaptive-runtime.git`. `main`
  requires a pull request, one code-owner approval, `Node 22`, `Node 24`,
  `Node 26`, and `Analyze JavaScript/TypeScript`. Only `@yusufgulerr` has
  write/admin access.
