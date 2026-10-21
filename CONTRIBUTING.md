# Contributing

Thank you for considering a contribution. This project prioritizes predictable
behavior, a minimal dependency surface, and auditable code. Discussions and pull
requests should optimize for correctness and clarity before performance or
feature count.

## Before you start

- Read [README.md](README.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
  [docs/API.md](docs/API.md), [docs/PROVIDERS.md](docs/PROVIDERS.md), and
  [docs/COOKBOOK.md](docs/COOKBOOK.md).
- Review [GOVERNANCE.md](GOVERNANCE.md) and
  [docs/GITHUB_SETTINGS.md](docs/GITHUB_SETTINGS.md) for access and review rules.
- Search existing issues and pull requests.
- For a behavior change or new public API, open an issue first. Describe the use
  case, the failure mode, and how determinism is preserved.
- For security vulnerabilities, follow [SECURITY.md](SECURITY.md), not the public
  issue tracker.

## Roles and access

Adaptive Runtime is a single-maintainer project. Public contributors do not need
write access: fork the repository, create a branch in your fork, and open a pull
request. Only [@yusufgulerr](https://github.com/yusufgulerr) has write/admin
access and can approve external pull requests. Do not ask for write access for a
one-off change.

All changes to `main` require a pull request, the owner's code-owner approval,
the Node 22/24/26 CI checks, and CodeQL. See [GOVERNANCE.md](GOVERNANCE.md) for
the full role and access policy.

## Development setup

Requirements: Node.js 22 or newer and npm. `.nvmrc` pins the recommended local
version (Node 24); CI covers Node 22, 24, and 26. No environment variables or
`.env` file are required: all configuration is explicit in code.

```bash
nvm use        # optional, reads .nvmrc
npm ci         # reproducible install from package-lock.json
npm run check
```

`npm run check` runs Biome, TypeScript (including tests/examples/benchmarks),
the test suite, and the production build. Use `npm install` only when you
intentionally need to update the lockfile.

Useful commands:

```bash
npm run lint
npm run format
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run benchmark
npm run benchmark:concurrency
npm run example:basic
npm run example:search
npm run example:planning
npm run example:quick-start
npm run example:observability
```

## Project conventions

- **ESM only.** Use `.js` extensions in relative imports, even from `.ts` files.
- **Strict TypeScript.** No `any` in public contracts; prefer `unknown` at boundaries.
- **No runtime dependencies** without an accepted ADR and a strong justification.
- **Pure policy core.** `src/policy/engine.ts` must not import Node APIs or providers.
- **Explicit unavailability.** Never coerce a missing signal to zero.
- **No automatic retries.** Do not add hidden second executions or mid-run switches.
- **Document new public API** in `docs/API.md` and add tests.
- **Keep errors typed.** Use existing classes; extend them only with a clear reason.
- **No secrets in telemetry.** `details`, `error`, and quality `detail` are exported.

Formatting is enforced by Biome. Run `npm run format` before committing.

## Tests

- Bug fixes require a regression test that fails before the fix.
- New behavior requires unit tests at the appropriate layer.
- Policy tests should use the pure engine and a fake clock; avoid real sleeps.
- Provider tests should inject clocks/factories rather than depend on wall time.
- Integration tests should exercise the public entry point and examples.
- Keep the suite deterministic and fast. Tests must not require network access.

Coverage thresholds are enforced at 80% for lines, branches, and functions. New
code should not lower coverage materially.

## Documentation

- Update README for user-visible behavior.
- Update `CHANGELOG.md` under `Unreleased`.
- Record significant design decisions in `docs/adr/` using the existing format.
- Use [docs/COOKBOOK.md](docs/COOKBOOK.md) for pattern-level guidance and
  [docs/MIGRATION.md](docs/MIGRATION.md) for adoption or compatibility changes.
- For a new provider, follow [docs/PROVIDERS.md](docs/PROVIDERS.md) and document
  its signal names, units, availability rules, and resource lifecycle.
- Use relative links so the docs work in the repository and in package previews.

## Fork and branch workflow

External contributors do not have write access. Use this flow:

1. Fork <https://github.com/yusufgulerr/adaptive-runtime> on GitHub.
2. Clone your fork and add the upstream remote:

   ```bash
   git clone https://github.com/<your-user>/adaptive-runtime.git
   cd adaptive-runtime
   git remote add upstream https://github.com/yusufgulerr/adaptive-runtime.git
   git fetch upstream
   ```

3. Create a focused branch from `upstream/main`:

   ```bash
   git switch -c fix/preserve-budget-state upstream/main
   ```

   Use a descriptive prefix: `feat/`, `fix/`, `docs/`, `test/`, `refactor/`,
   `perf/`, `ci/`, or `chore/`.

4. Make the smallest coherent change, add tests, and run the checks.
5. Commit with a Conventional Commit message, push to your fork, and open a pull
   request against `main` with `Fixes #<issue>` when applicable.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) for every
commit:

```text
<type>(<scope>): <imperative summary>

<why this change is needed>
```

Allowed types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`,
`chore`, and `revert`. Useful scopes include `policy`, `runtime`, `providers`,
`signals`, `docs`, and `ci`.

Examples:

```text
fix(policy): preserve pending state on cached samples
docs(providers): document abort behavior for custom probes
test(runtime): cover close during an in-flight read
```

## Commit and pull request guidelines

- Open pull requests from a fork; direct pushes to `main` are blocked.
- Every pull request needs one approval from the code owner, the Node 22/24/26
  CI checks, and CodeQL. Resolve all review conversations before merging.
- Keep commits focused; one logical change per commit.
- Follow Conventional Commits, for example
  `fix(policy): preserve budget state on cached reads`.
- Explain **why** in the body, not just what changed.
- Use `Fixes #<issue>` in the pull request when it closes an issue; otherwise
  write `N/A` and explain the motivation.
- Fill out the pull request template, including verification commands and output.
- Keep the branch up to date and resolve review conversations before merging.
- Do not include generated `dist/` output, unless a release process explicitly requires it.
- Do not commit `.env` files, secrets, tokens, local paths, or editor state.

All contributions are accepted under the Apache License 2.0. By submitting a pull
request, you agree that your contribution is licensed under the same terms. No
separate CLA is required at this stage.

## Review criteria

Maintainers evaluate:

1. Correctness and explicit edge-case behavior.
2. Compatibility with the documented semantics and no-retry guarantee.
3. Test quality and determinism.
4. API surface: is the new concept necessary, and can it be explained?
5. Documentation and changelog.
6. Performance only when measured and attributable.

Reviews are mandatory for every change. Review latency depends on maintainer
availability; the quality gate itself is not optional.

## Release process (owner only)

1. Ensure `main` is green in CI.
2. Update `CHANGELOG.md` and the version in `package.json`.
3. Run `npm run check`, `npm run test:coverage`, `npm run build`, and
   `npm pack --dry-run`.
4. Confirm the npm name and repository metadata immediately before publishing.
5. Tag the release and publish through the release workflow with provenance.
6. Verify a clean consumer install and import from the published tarball.

The complete tag, approval, verification, and failure-handling checklist is in
[docs/RELEASING.md](docs/RELEASING.md). No one should publish from an unverified
or dirty working tree.
