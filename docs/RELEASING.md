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
- `NPM_TOKEN` exists as an environment secret on the `release` environment.
- The `release` environment requires the owner's approval.
- The owner has explicitly approved publishing this version.

Do not put `NPM_TOKEN` in repository-wide secrets, a committed `.npmrc`, a shell
history, or a pull request comment. Use an environment secret and rotate it if it
is exposed.

## 1. Prepare the release pull request

1. Update `package.json` and `package-lock.json` to the intended version.
2. Move the relevant entries from `Unreleased` to the new version in
   `CHANGELOG.md`; add the date.
3. Update any version-specific documentation and `docs/VERIFICATION.md`.
4. Run the full local gate:

   ```bash
   npm ci
   npm run check
   npm run test:coverage
   npm run benchmark
   npm pack --dry-run --json --ignore-scripts
   ```

5. Inspect the package file list and confirm that no secrets, tests, examples,
   benchmarks, coverage, or local state are included.
6. Open a pull request, wait for Node 22/24/26 and CodeQL, and merge it through the
   protected `main` branch. The owner uses the documented admin bypass only for
   their own pull request because GitHub does not allow self-approval.

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
git tag -a v0.1.0 -m "adaptive-runtime 0.1.0"
git push origin v0.1.0
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
   - publishes with `npm publish --provenance --access public`;
   - creates the GitHub release with generated notes.

Do not approve the environment until the tag and version are confirmed.

## 5. Post-publication verification

After the workflow succeeds, verify the registry rather than assuming success:

```bash
npm view adaptive-runtime version
npm view adaptive-runtime@0.1.0 dist.integrity
npm view adaptive-runtime@0.1.0 repository.url
```

Install and import from a clean temporary directory:

```bash
mkdir adaptive-runtime-smoke
cd adaptive-runtime-smoke
npm init -y
npm install adaptive-runtime@0.1.0
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
- **Compromised token:** revoke the npm token immediately, replace the
  environment secret, and review the npm account's audit log.
- **Failed post-publish check:** open an incident issue without secrets, document
  the impact, and publish a corrected patch version.

## Release checklist

- [ ] Version, changelog, and docs are consistent.
- [ ] `npm ci`, `npm run check`, coverage, benchmark, and `npm pack` pass.
- [ ] `main` is green on Node 22/24/26 and CodeQL.
- [ ] `npm view adaptive-runtime version` is 404 or the intended version is new.
- [ ] `NPM_TOKEN` is present only in the `release` environment.
- [ ] The owner approved the irreversible publish.
- [ ] The `release` environment deployment was approved.
- [ ] Registry, provenance, GitHub release, and clean-consumer checks pass.
- [ ] Results are recorded in `docs/VERIFICATION.md`.
