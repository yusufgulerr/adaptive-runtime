# ADR 0010: Two-phase GitHub and npm release

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** Project maintainers

## Context

The original release workflow treated a `v*` tag push as a single operation:
verify the tagged tree, publish to npm, and create the GitHub release. That coupling
is appropriate when the npm account and trusted publisher are ready. It is not
appropriate when the repository wants to mark a source release before the npm
account exists.

With the coupled workflow, a tag push without npm credentials produces a remote
tag but no GitHub release, because the publish step fails before the release step.
The tag ruleset makes the tag effectively permanent, so the failed state is
expensive to correct. The repository needs to create the GitHub release and mark
the source version without publishing to npm.

## Decision

Split the release workflow into two phases:

1. **Tag phase:** a `v*` tag push runs the full verification gate, then creates the
   GitHub release with generated notes. It never publishes to npm.
2. **npm phase:** a manual `workflow_dispatch` against the existing tag with
   `publish_npm=true` runs the same verification, publishes with provenance, and
   runs the post-publish verification job. The `release` environment gates this
   phase with an owner approval.

The npm phase uses the same workflow file and the tag as its ref. It does not
create or move the GitHub release, and it does not move the tag.

## Consequences

Positive:

- The GitHub release can exist before the npm account is configured.
- A tag push cannot leave the repository in the “tag exists but no release” state
  because npm credentials are missing.
- npm publication remains independently retryable against the same tag.
- Both phases retain the full verification gate, provenance, and post-publish
  checks.

Negative:

- npm publication is a two-step operation instead of a single tag push.
- The release runbook and checklist are longer.
- A workflow-dispatch run must target the tag, not `main`, so the `release`
  environment's `v*` tag policy is satisfied.

## Alternatives considered

- **Disable the release workflow temporarily, push the tag, then create the
  release manually.** Rejected: it relies on an out-of-band repository setting and
  leaves no auditable workflow record for the tag phase.
- **Use a non-`v*` tag for the GitHub-only release.** Rejected: it breaks the tag
  taxonomy and the environment's tag policy.
- **Publish to npm from a branch after the tag.** Rejected: it weakens the link
  between the tagged source and the published artifact.
- **Keep the coupled workflow and wait for npm.** Rejected for this release
  because the npm account is not ready and the source release should not be
  blocked on it.

## Follow-up

- Use the two-phase process for `v0.3.0`; npm publication remains pending.
- Record the GitHub release and, later, the npm registry evidence in
  `docs/VERIFICATION.md`.
- Revisit the split if npm trusted publishing becomes available before the tag.
