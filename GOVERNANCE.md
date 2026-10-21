# Governance

## Current model

Adaptive Runtime is a single-maintainer open-source project owned by
[@yusufgulerr](https://github.com/yusufgulerr). The repository is public: anyone
may fork it, open an issue, or submit a pull request. Only the owner has write or
admin access.

This is intentionally conservative for an experimental 0.x package. It keeps the
release path, security settings, and dependency updates under one accountable
maintainer while still allowing public review and contribution.

## Roles

| Role | Who | Access |
| --- | --- | --- |
| Owner / maintainer | [@yusufgulerr](https://github.com/yusufgulerr) | Admin: repository settings, access, security, releases, tags, and branch rules |
| Contributor | Anyone with a GitHub account | Fork, open issues, submit pull requests, and review/comment; no write access |
| Future maintainer | Not assigned | Would require an explicit owner decision and the access review below |

No outside collaborator, deploy key, or GitHub App is granted write access by
default. Triage access, if ever granted for issue management, does not grant code
push, approval, or release rights.

## Pull requests and review

- `main` is protected. Direct pushes, force pushes, and branch deletion are
  blocked for non-owner accounts.
- Every change lands through a pull request.
- `CODEOWNERS` assigns all files to `@yusufgulerr`.
- A pull request needs **one approval** from a code owner. Because the owner is
  the only write-capable collaborator, only the owner can satisfy that approval
  requirement for external contributions.
- Node.js 22, 24, and 26 CI checks and the CodeQL analysis must pass.
- Conversations must be resolved, stale approvals are dismissed after new
  commits, and the most recent reviewable push must be approved.
- The history is linear; only squash merges are enabled, and merged branches are
  deleted automatically.
- GitHub does not allow a user to approve their own pull request. The owner can
  use the administrator bypass to merge their own pull requests; this is the only
  solo-maintainer exception. External pull requests still require the owner's
  approval.

The owner reviews for correctness, deterministic behavior, test quality, API
surface, documentation, and security. Review is best effort; there is no SLA.

## Becoming a maintainer

There is no automatic promotion path today. A future maintainer would be added
only after:

1. a sustained record of reviewed contributions and good judgment;
2. an explicit owner decision recorded in a pull request;
3. review of the access, release, and security responsibilities;
4. two-factor authentication on the account; and
5. a documented change to this file and `CODEOWNERS`.

Write access is never granted for a one-off contribution, a dependency update, or
a request made only in an issue comment.

## Releases and tags

- Only the owner creates release tags.
- Tags matching `v*` are protected: creation, update, and deletion are restricted
  to the repository administrator role.
- The `release` GitHub environment requires owner approval. `NPM_TOKEN` must be
  stored as an environment secret before the first publish.
- The tag-driven workflow runs the full checks and is configured to publish with
  npm provenance and create the GitHub release.
- Publishing from a local dirty working tree is not permitted.
- The complete repository-settings checklist is in
  [docs/GITHUB_SETTINGS.md](docs/GITHUB_SETTINGS.md).

## Security and repository settings

- Private vulnerability reporting is enabled.
- Secret scanning and push protection are enabled.
- Dependabot alerts and automated security updates are enabled.
- The default `GITHUB_TOKEN` is read-only; workflows request write permissions
  explicitly.
- GitHub Actions are pinned by commit SHA, and only GitHub-owned actions are
  allowed.
- Workflows on pull requests from external forks require owner approval before
  they run.
- The release environment and protected tags are separate from normal pull
  request access.

## References

The model follows the least-privilege principles documented by GitHub and the
role separation used by established open-source projects:

- [GitHub repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)
- [GitHub protected branches and required reviews](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Kubernetes community membership and OWNERS](https://github.com/kubernetes/community/blob/master/community-membership.md)
- [Node.js project governance](https://github.com/nodejs/node/blob/main/GOVERNANCE.md)
- [OpenSSF Scorecard branch-protection guidance](https://github.com/ossf/scorecard/blob/main/docs/checks.md#branch-protection)
