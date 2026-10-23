# Release runbook

This project uses a two-phase release through
`.github/workflows/release.yml`:

1. **GitHub release:** pushing an annotated `v*` tag verifies the tag and creates
   a GitHub release. This phase does not publish to npm.
2. **npm publication:** when the registry account is ready, manually dispatch the
   same workflow against the tag with `publish_npm=true`. The protected `release`
   environment gates this irreversible step.

Publishing is irreversible enough that it is treated as an owner-only operation.
The current publication status is tracked in [VERIFICATION.md](VERIFICATION.md).
The examples below use `0.5.0` as the latest released version. `v0.5.0` is
published as a GitHub release; npm publication remains pending. Replace the
version in each command with the version actually being released.

## Preconditions

- The owner is the only person with write/admin access.
- `main` is clean, green in CI, and has no unreviewed changes.
- The version in `package.json` matches the intended tag.
- `CHANGELOG.md`, README, and docs are updated for the version.
- For the GitHub release phase, no npm account is required.
- For the npm phase, the npm account is authenticated and the registry name is
  available.
- npm trusted publishing (OIDC) is configured for `yusufgulerr/adaptive-runtime`
  and `.github/workflows/release.yml`. This is the primary path and needs no npm
  token.
- If the registry or account cannot use OIDC, an `NPM_TOKEN` environment secret is
  configured on the `release` environment as a fallback.
- The `release` environment requires the owner's approval.
- The owner has explicitly approved the GitHub release and, separately, the npm
  publication.

### Configuring npm Trusted Publishing (OIDC)

To configure tokenless OIDC publishing on npm:

1. Sign in to your npm account at [npmjs.com](https://www.npmjs.com) as `@yusufgulerr`.
2. For an existing package: navigate to `adaptive-runtime` → **Settings** → **Publishing Access** → **Trusted Publishers** → **Add Trusted Publisher**.
3. For a first publication: navigate to your account **Settings** → **Publishing Access** → **Trusted Publishers** → **Add Trusted Publisher**.
4. Select **GitHub Actions** as the provider and configure:
   - **Repository Owner / Organization:** `yusufgulerr`
   - **Repository Name:** `adaptive-runtime`
   - **Workflow Filename:** `release.yml`
   - **Environment Name:** `release`
5. Save the configuration. GitHub Actions jobs running `.github/workflows/release.yml` targeting the `release` environment will now receive short-lived OIDC tokens directly from npm during `npm publish --provenance`, requiring zero static secrets.

Do not put `NPM_TOKEN` in repository-wide secrets, a committed `.npmrc`, a shell
history, or a pull request comment. Prefer OIDC. Use an environment secret only
for the fallback path and rotate it if it is exposed.

## 1. Prepare the release pull request

1. Update `package.json` and `package-lock.json` to the intended version.
2. Move the relevant entries from `Unreleased` to the new version in
   `CHANGELOG.md`; add the date.
3. Confirm the merged pull requests carry labels recognized by
   `.github/release.yml`, so generated release notes group them correctly. Use
   `skip-changelog` only for changes that should not appear.
4. Update any version-specific documentation and `docs/VERIFICATION.md`.
5. Run the full local gate:

   ```bash
   npm ci
   npm run check
   npm run test:coverage
   npm run benchmark
   npm pack --dry-run --json --ignore-scripts
   ```

6. Inspect the package file list and confirm that no secrets, tests, examples,
   benchmarks, coverage, or local state are included.
7. Open a pull request, wait for Node 22/24/26, CodeQL, Dependency Review, and the
   `PR title` check, and merge it through the protected `main` branch. The owner
   uses the documented admin bypass only for their own pull request because GitHub
   does not allow self-approval.

## 2. Confirm the tag is new

Immediately before tagging:

```bash
git ls-remote --tags origin "refs/tags/v*"
```

The intended tag must not exist. Release tags are immutable; do not move,
recreate, or reuse a tag after it has been pushed.

## 3. Create and push the tag

Use an annotated tag on the exact release commit:

```bash
git switch main
git pull --ff-only
git tag -a v0.5.0 -m "adaptive-runtime 0.5.0"
git push origin v0.5.0
```

The tag ruleset restricts creation, update, and deletion to the repository admin.
Never force-push or move a published tag.

The tag push runs the `Verify release tag` job and, if verification passes, the
`Create GitHub release` job. It does **not** publish to npm.

## 4. Confirm the GitHub release

1. Open **Actions → Release** and confirm the `Verify release tag` and
   `Create GitHub release` jobs succeed.
2. Inspect the generated release notes and their categories.
3. Confirm the release points at the intended tag:

   ```bash
   gh release view v0.5.0
   ```

If verification fails, do not move the tag. Fix the source in a new commit and
release a new patch version; if the failure is only in release-note
configuration, re-run the failed workflow or create the release manually from the
existing tag.

## 5. Publish to npm when the registry is ready

Do this only after the npm account, package name, and trusted publisher are
configured and the owner has approved the irreversible publish.

Check the registry state immediately before publishing:

```bash
npm view adaptive-runtime version
```

- A 404 means the name is still available for the first publish.
- If a version already exists, do not reuse or overwrite it. Publish a new patch
  version instead.

Dispatch the workflow against the existing tag:

```bash
gh workflow run release.yml --ref v0.5.0 -f publish_npm=true
```

The workflow re-runs `npm run check`, coverage, and package inspection, then waits
for approval on the `release` environment. Approve it in **Actions → Release →
Review deployments**. The `Publish to npm` job uses `npm publish --provenance
--access public`, preferring OIDC trusted publishing and falling back to
`NPM_TOKEN` only when it is set. The `Verify published package` job then waits for
registry propagation, checks version, integrity, and repository metadata, verifies
the provenance attestation, and installs the package in a clean consumer.

The workflow does not re-create or move the GitHub release during the npm phase.

## 6. Post-publication verification

The workflow's `verify-publish` job runs
`scripts/verify-published-package.mjs` against the tag version. The script waits
for registry propagation, checks the exact version, `dist.integrity`
(`sha512-`), and `repository.url`, verifies the provenance attestation, then
installs the package in a clean temporary consumer and imports the root,
`/policy`, and `/providers` entry points before running one operation and
closing the runtime.

Run the same verification locally:

```bash
node scripts/verify-published-package.mjs --version 0.5.0
node scripts/verify-published-package.mjs --version 0.5.0 --json
node scripts/verify-published-package.mjs --help
```

`--json` prints exactly one machine-readable summary to stdout. Failures go to
stderr and exit non-zero.

For an offline dry run or script test, supply fixtures and skip the install:

```bash
node scripts/verify-published-package.mjs --version 0.5.0 \
  --metadata-file ./metadata.json \
  --attestations-file ./attestations.json \
  --skip-consumer
```

- `--metadata-file` reads registry metadata from JSON and disables all registry
  access, including the consumer install.
- `--attestations-file` reads the provenance record from JSON instead of
  `npm view`.
- `--skip-provenance` and `--skip-consumer` skip those checks entirely.
- `--wait-attempts` and `--wait-delay-ms` tune registry propagation polling.

The integration test
`tests/integration/published-package-verification.test.ts` uses these switches
and never contacts npm.

Treat the commands below as an independent owner check and as the evidence to
record, rather than assuming the workflow result is sufficient.

```bash
npm view adaptive-runtime version
npm view adaptive-runtime@0.5.0 dist.integrity
npm view adaptive-runtime@0.5.0 repository.url
```

Install and import from a clean temporary directory:

```bash
mkdir adaptive-runtime-smoke
cd adaptive-runtime-smoke
npm init -y
npm install adaptive-runtime@0.5.0
node --input-type=module -e "import { createAdaptiveRuntime } from 'adaptive-runtime'; const r = createAdaptiveRuntime(); console.log(typeof r.run); await r.close();"
```

Verify provenance and the published tarball according to the npm documentation.
Record the registry version, integrity, provenance result, GitHub release URL, CI
run, and clean-consumer result in [VERIFICATION.md](VERIFICATION.md).

The automated job and offline dry runs do not replace owner approval:
`npm publish` requires explicit owner approval for that version, as described
in Section 5.

## 7. If something fails

- **Before the tag:** fix the release pull request, delete the local tag if it has
  not been pushed, and re-run the checks. Do not reuse a pushed tag.
- **GitHub release phase:** the tag remains immutable. Fix release-note
  configuration and re-run the failed workflow, or create the release manually
  from the existing tag. If the tagged source is broken, release a new patch
  version with a new tag.
- **npm phase, before publish:** fix the workflow or environment configuration
  and dispatch again against the same tag. The GitHub release already exists and
  is not affected.
- **After publish:** do not rewrite the tag. If the package is broken, publish a
  new patch version with a fix. Use `npm deprecate` to warn consumers. Unpublish
  only when npm's policy allows it and the owner explicitly approves.
- **Compromised token:** revoke the npm token immediately, remove or replace the
  environment secret, and review the npm account's audit log. If OIDC was used,
  review the trusted-publisher configuration and the workflow run.
- **Failed post-publish check:** open an incident issue without secrets, document
  the impact, and publish a corrected patch version.

## Release checklist

### GitHub release

- [ ] Version, changelog, and docs are consistent.
- [ ] `npm ci`, `npm run check`, coverage, benchmark, and `npm pack` pass.
- [ ] `main` is green on Node 22/24/26, CodeQL, Dependency Review, and `PR title`.
- [ ] `git ls-remote --tags origin "refs/tags/v*"` shows the intended tag is new.
- [ ] The owner approved the tag and GitHub release.
- [ ] The tag was pushed and the `Verify release tag` and `Create GitHub release`
      jobs succeeded.
- [ ] The generated release notes and target tag were checked.

### npm publication

- [ ] `npm view adaptive-runtime version` is 404 or the intended version is new.
- [ ] npm trusted publishing (OIDC) is configured; `NPM_TOKEN` is set only if the
      fallback is required and only in the `release` environment.
- [ ] The owner approved the irreversible npm publish.
- [ ] `gh workflow run release.yml --ref v0.5.0 -f publish_npm=true` was dispatched.
- [ ] The `release` environment deployment was approved.
- [ ] Registry, provenance, GitHub release, and clean-consumer checks pass,
      including the automated `verify-publish` job.
- [ ] Results are recorded in `docs/VERIFICATION.md`.
