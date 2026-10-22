# Governance

## Current model

Adaptive Runtime is an open-source project founded and currently owned by
[@yusufgulerr](https://github.com/yusufgulerr). The repository is public: anyone
may fork it, open an issue, start a Discussion, or submit a pull request.

Responsibility grows through the staged contributor ladder below. Access is
granted in explicit, recorded steps rather than all at once, so that review
quality, security boundaries, and release integrity are preserved as the
contributor base expands. Only the owner currently holds write and admin access.

## Contributor ladder

| Level | Role | Responsibilities | Access and limits |
| --- | --- | --- | --- |
| 1 | **Community Contributor** | Report reproducible issues, join Discussions, propose RFCs, submit pull requests from a fork, review and comment on changes. | Public read and fork access. No write access to the repository. |
| 2 | **Triage Collaborator** | Reproduce reports, request missing information, apply `status:*`, `area:*`, and `priority:*` labels, close duplicates, and keep the issue tracker actionable. Granted by the owner after a record of accurate, constructive triage. | Triage role on issues and pull requests only. No code push, no pull-request approval, no release or settings access. |
| 3 | **Committer / Reviewer** | Take sustained ownership of a defined area such as providers, documentation, benchmarks, or the policy core; review pull requests in that area; mentor contributors. Granted after a sustained record of merged, well-tested contributions and sound review judgment. | Scoped write or review access recorded in `CODEOWNERS` or the access review. Approval rights apply only to the assigned area. No release, tag, security-setting, or repository-admin rights. |
| 4 | **Core Maintainer / Owner** | Own architectural integrity, the public contract, security policy, `CODEOWNERS` approval, dependency and supply-chain decisions, releases, and protected tags. | Repository admin. The owner is the final decision-maker for the 0.x line. |

Progression is based on demonstrated work, not on request volume: reviewed
contributions, test quality, deterministic behavior, documentation, and judgment
under security or compatibility pressure. A promotion is recorded in a pull
request that updates this file and, where relevant, `CODEOWNERS`. There is no
automatic promotion path, and no level is granted for a one-off contribution.

No outside collaborator, deploy key, or GitHub App is granted write access by
default. Triage access does not grant code push, approval, or release rights. A
Committer/Reviewer who later needs broader access must go through the same
recorded review as any other change to the access model.

## Access review

Access is reviewed whenever a role changes, a release is prepared, or a security
incident involves credentials. The review confirms:

1. the smallest role that supports the work;
2. two-factor authentication on the account;
3. no standing deploy keys or write-capable GitHub Apps without an explicit
   decision;
4. `CODEOWNERS` still routes every path to a responsible reviewer; and
5. the release environment and tag rules still require owner approval.

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
  owner-bypass exception. External pull requests still require the owner's
  approval.

The owner reviews for correctness, deterministic behavior, test quality, API
surface, documentation, and security. Review is mandatory for every change;
scheduling depends on maintainer availability.

## Maintainer promotion

Moving to Core Maintainer / Owner is deliberately stricter than the earlier
levels. It requires:

1. a sustained record of reviewed contributions and sound judgment;
2. an explicit owner decision recorded in a pull request;
3. review of the access, release, and security responsibilities;
4. two-factor authentication on the account; and
5. a documented change to this file and `CODEOWNERS`.

Access is never granted for a one-off contribution, a dependency update, or a
request made only in an issue comment. A rejected promotion can be revisited
after the missing evidence exists; the decision and its reasoning stay on record.

## Releases and tags

- Only the owner creates release tags.
- Tags matching `v*` are protected: creation, update, and deletion are restricted
  to the repository administrator role.
- The `release` GitHub environment requires owner approval.
- The tag-driven workflow runs the full checks and publishes through npm trusted
  publishing (OIDC) with provenance. An optional `NPM_TOKEN` environment secret
  provides a fallback for registries or accounts that cannot use OIDC.
- Dependency Review runs on every pull request.
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
