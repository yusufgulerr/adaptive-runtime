# Release runbook

This project publishes from a protected tag through
`.github/workflows/release.yml`. Publishing is irreversible enough that it is
treated as an owner-only operation. The current publication status is tracked in
[VERIFICATION.md](VERIFICATION.md).

## Preconditions

- The owner is the only person with write/admin access.
- `main` is clean, green in CI, and has no unreviewed changes.
- The version in `package.json` matches the intended tag.
- `CHANGELOG.md`, README, and docs are updated for the version.
- The npm account is authenticated and the registry name is available.
- npm trusted publishing (OIDC) is configured for `yusufgulerr/adaptive-runtime`
  and `.github/workflows/release.yml`. This is the primary path and needs no npm
  token.
- If the registry or account cannot use OIDC, an `NPM_TOKEN` environment secret is
  configured on the `release` environment as a fallback.
- The `release` environment requires the owner's approval.
- The owner has explicitly approved publishing this version.

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

5. Inspect the package file list and confirm that no secrets, tests, examples,
   benchmarks, coverage, or local state are included.
6. Open a pull request, wait for Node 22/24/26, CodeQL, Dependency Review, and the
   `PR title` check, and merge it through the protected `main` branch. The owner
   uses the documented admin bypass only for their own pull request because GitHub
   does not allow self-approval.

## 2. Confirm the registry state

Immediately before tagging:

```bash
npm view adaptive-runtime version
```

- A 404 means the name is still available for the first publish.
- If a version already exists, do not reuse or overwrite it. Publish a new patch
  version instead.

Confirm the tag does not exist:

```bash
git ls-remote --tags origin "refs/tags/v*"
```

## 3. Create and push the tag

Use an annotated tag on the exact release commit:

```bash
git switch main
git pull --ff-only
git tag -a v0.3.0 -m "adaptive-runtime 0.3.0"
git push origin v0.3.0
```

The tag ruleset restricts creation, update, and deletion to the repository admin.
Never force-push or move a published tag.

## 4. Approve and watch the workflow

1. Open **Actions → Release**.
2. Approve the `release` environment deployment for the tag.
3. Confirm the workflow:

   - verifies the tag matches `package.json`;
   - runs `npm run check` and coverage;
   - runs `npm pack --dry-run`;
   - publishes with `npm publish --provenance --access public`, preferring OIDC
     trusted publishing and falling back to `NPM_TOKEN` only when it is set;
   - creates the GitHub release with generated notes categorized by
     `.github/release.yml`;
   - then runs the `verify-publish` job, which waits for registry propagation,
     checks version, integrity, and repository metadata, verifies the provenance
     attestation, and installs the package in a clean consumer.

   The release job does not use the npm download cache; it always resolves the
   registry metadata fresh.

Do not approve the environment until the tag and version are confirmed.

## 5. Post-publication verification

The workflow's `verify-publish` job performs the registry propagation, version,
integrity, provenance, and clean-consumer checks automatically. Treat the commands
below as an independent owner check and as the evidence to record, rather than
assuming the workflow result is sufficient.

```bash
npm view adaptive-runtime version
npm view adaptive-runtime@0.3.0 dist.integrity
npm view adaptive-runtime@0.3.0 repository.url
```

Install and import from a clean temporary directory:

```bash
mkdir adaptive-runtime-smoke
cd adaptive-runtime-smoke
npm init -y
npm install adaptive-runtime@0.3.0
node --input-type=module -e "import { createAdaptiveRuntime } from 'adaptive-runtime'; const r = createAdaptiveRuntime(); console.log(typeof r.run); await r.close();"
```

Verify provenance and the published tarball according to the npm documentation.
Record the registry version, integrity, provenance result, GitHub release URL, CI
run, and clean-consumer result in [VERIFICATION.md](VERIFICATION.md).

## 6. If something fails

- **Before publish:** fix the release pull request, delete the local tag if it has
  not been pushed, and re-run the checks. Do not reuse a pushed tag.
- **After publish:** do not rewrite the tag. If the package is broken, publish a
  new patch version with a fix. Use `npm deprecate` to warn consumers. Unpublish
  only when npm's policy allows it and the owner explicitly approves.
- **Compromised token:** revoke the npm token immediately, remove or replace the
  environment secret, and review the npm account's audit log. If OIDC was used,
  review the trusted-publisher configuration and the workflow run.
- **Failed post-publish check:** open an incident issue without secrets, document
  the impact, and publish a corrected patch version.

## Release checklist

- [ ] Version, changelog, and docs are consistent.
- [ ] `npm ci`, `npm run check`, coverage, benchmark, and `npm pack` pass.
- [ ] `main` is green on Node 22/24/26, CodeQL, Dependency Review, and `PR title`.
- [ ] `npm view adaptive-runtime version` is 404 or the intended version is new.
- [ ] npm trusted publishing (OIDC) is configured; `NPM_TOKEN` is set only if the
      fallback is required and only in the `release` environment.
- [ ] The owner approved the irreversible publish.
- [ ] The `release` environment deployment was approved.
- [ ] Registry, provenance, GitHub release, and clean-consumer checks pass,
      including the automated `verify-publish` job.
- [ ] Results are recorded in `docs/VERIFICATION.md`.
