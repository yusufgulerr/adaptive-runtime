# ADR 0009: Repository automation and supply-chain hardening

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Project maintainers

## Context

Adaptive Runtime is a public, single-maintainer repository with a strict
zero-runtime-dependency policy and a protected `main` branch. The runtime
contract is documented, but repository operations still relied on manual
discipline for release notes, pull request titles, citation metadata, and
supply-chain posture. Those gaps do not change runtime semantics, but they affect
review quality, release consistency, and the evidence available to downstream
users.

The constraints were:

- no new runtime or production dependencies;
- no third-party JavaScript package for commit or release automation;
- every workflow action pinned to a full commit SHA;
- generated output must remain inspectable and deterministic;
- the project must not claim a security score, funding account, or release state
  that has not been verified.

## Decision

Add repository-only automation and metadata:

- `.github/release.yml` categorizes generated GitHub release notes by label, with
  an explicit `skip-changelog` escape hatch.
- `.github/DISCUSSION_TEMPLATE/q-a.yml` and `ideas.yml` provide structured Q&A and
  design-proposal forms. Security reports continue to use private vulnerability
  reporting.
- `.github/workflows/scorecard.yml` runs OpenSSF Scorecard on `main`, on a weekly
  schedule, and on branch-protection changes. It uploads SARIF, keeps a short-lived
  artifact, and publishes results for the README badge. The top-level workflow is
  read-only; the analysis job alone receives `security-events: write` and
  `id-token: write`.
- `scripts/check-pr-title.mjs` validates pull request titles against the
  Conventional Commits format already required by `CONTRIBUTING.md`. CI runs it in
  the `PR title` job without installing dependencies.
- `CITATION.cff` provides citation metadata using the project name and contributor
  entity, not an invented individual identity.
- `.vscode/extensions.json` and `.vscode/settings.json` recommend Biome and enable
  format-on-save; all other editor state remains ignored.
- `scripts/verify-package-exports.mjs` imports every built subpath through the
  package `exports` map and checks the expected named runtime symbols. It runs
  after `npm run build` in CI and in the local `check` script.

The project does not add `.github/FUNDING.yml` until an owner-controlled funding
account exists. It does not add a release automation service or a semantic-release
dependency. Existing image and action pins remain authoritative; documentation is
updated to match them rather than the reverse.

## Consequences

Positive:

- Release notes are grouped consistently without a release framework.
- Issue and Discussion intake have matching structure and labels.
- The repository has an auditable, SHA-pinned supply-chain check.
- Squash-merge titles remain readable and searchable in `main` history.
- Citation and editor setup are discoverable without changing the package
  surface.
- The built package is verified through the same export map consumers use, which
  catches missing subpaths and stale `dist` files before publication.

Negative:

- The owner must allow `ossf/scorecard-action` explicitly in the repository
  Actions policy and add `PR title` to the required status checks.
- The Scorecard badge is empty until the workflow runs successfully on the default
  branch; the workflow itself is not proof of a score.
- The PR title rule is intentionally narrow: lowercase types and scopes,
  Conventional Commits punctuation, and a 100-character maximum.
- Another script and more repository files require maintenance and Dependabot
  attention.

## Alternatives considered

- **semantic-release or release-please:** adds a third-party dependency, bot
  permissions, and configuration that duplicates the existing tag-driven release
  workflow. Rejected.
- **A third-party PR title action:** a small, dependency-free Node script is easier
  to audit, test, and run on every supported OS. Rejected the action.
- **Publish Scorecard results without SARIF:** loses code-scanning visibility and
  the standard alert workflow. Rejected.
- **Commit a funding file pointing at a generic account:** would create a false
  sponsorship path. Rejected.
- **Rely on manual export checks:** the package already has ten subpaths; manual
  checks are easy to miss and do not prove the built map. Rejected.

## Follow-up

- Apply the repository-settings changes in `docs/GITHUB_SETTINGS.md`: allow the
  Scorecard action, add `PR title` to required checks, and confirm the label set.
- Push the workflow and confirm the first Scorecard run and badge.
- Keep action pins current through Dependabot and review every permission change.
- Revisit the PR title limit if legitimate scoped titles routinely exceed it.
