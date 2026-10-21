# GitHub repository settings

This is the repository-specific settings and access checklist for
<https://github.com/yusufgulerr/adaptive-runtime>. The repository is owned by
`@yusufgulerr`; there is no organization or team layer to configure.

Only the owner changes these settings. Any change should be made through a pull
request that updates this file, `GOVERNANCE.md`, or both.

## Access model

| Item | Required state |
| --- | --- |
| Collaborators | Only `@yusufgulerr`, role `admin` |
| Pending invitations | None |
| Deploy keys | None |
| GitHub Apps with write access | None without explicit owner approval |
| External contributors | Fork the repository and open a pull request |
| Default repository role | No write access |

Do not grant write, maintain, triage, or admin access for a one-off contribution.
Do not add a deploy key or a write-capable GitHub App without an explicit owner
decision. Triage access, if ever granted for issue management, does not grant code
push, pull-request approval, or release rights.

## Protect `main`

Use **Settings → Branches → Add branch protection rule** for `main` (the current
setup), or the equivalent repository ruleset. Branch protection is used because
it supports required code-owner reviews and the solo-maintainer admin bypass
described below.

| Setting | Value |
| --- | --- |
| Require a pull request before merging | Enabled |
| Required approvals | 1 |
| Require review from Code Owners | Enabled |
| Dismiss stale pull request approvals when new commits are pushed | Enabled |
| Require approval of the most recent reviewable push | Enabled |
| Require status checks to pass | Enabled |
| Required checks | `Node 22`, `Node 24`, `Node 26`, `Analyze JavaScript/TypeScript` |
| Require branches to be up to date | Enabled |
| Require conversation resolution | Enabled |
| Require linear history | Enabled |
| Allow force pushes | Disabled |
| Allow deletions | Disabled |
| Enforce for administrators (`enforce_admins`) | Disabled; owner-only bypass documented below |

`enforce_admins` is intentionally off so the owner can merge their own pull
requests. GitHub does not allow a user to approve their own pull request, and this
is a single-maintainer project. External pull requests still require the owner's
code-owner approval; no other collaborator has write access to satisfy it.

The `.github/CODEOWNERS` file assigns every path, including the critical runtime,
policy, provider, documentation, and workflow directories, to `@yusufgulerr`.

If you migrate `main` from branch protection to a repository ruleset, use the
equivalent `pull_request`, `required_status_checks`, `non_fast_forward`,
`deletion`, and `required_linear_history` rules, with the repository admin role as
the only bypass actor. Do not enable both mechanisms at the same time unless you
have verified how their requirements combine.

## Protect release tags

Use **Settings → Rules → Rulesets → New tag ruleset**. The repository currently has
a tag ruleset named **Protect release tags**.

| Setting | Value |
| --- | --- |
| Target | Tags |
| Include | `refs/tags/v*` |
| Rules | Restrict creations, updates, and deletions |
| Bypass | Repository admin role only |
| Enforcement | Active |

Release tags are immutable. A bad release should be deprecated or, within npm's
policy window, unpublished; do not move or rewrite a published tag.

## Merge settings

Use **Settings → General → Pull requests**:

- Allow squash merging: **on**
- Allow merge commits: **off**
- Allow rebase merging: **off**
- Automatically delete head branches: **on**
- Allow auto-merge: **off**
- Allow update branch: **on**

Squash-only merging keeps `main` linear and makes each pull request one reviewable
change. The owner controls when a branch is merged.

## GitHub Actions

Use **Settings → Actions → General**:

| Setting | Value |
| --- | --- |
| Actions permissions | Allow selected actions |
| Allowed actions | GitHub-owned actions only |
| Require actions to be pinned to a full-length commit SHA | Enabled |
| Default workflow permissions | Read repository contents |
| Allow GitHub Actions to create or approve pull requests | Disabled |
| Fork pull request workflows | Require approval for all external contributors |

The workflows declare the minimum permissions they need. The release workflow is
the only workflow that requests `contents: write` and `id-token: write`, and it is
gated by the `release` environment.

Do not add a third-party action without an explicit owner decision, a pinned SHA,
and a review of its permissions.

## Security features

Use **Settings → Code security and analysis**:

- Private vulnerability reporting: **enabled**
- Secret scanning: **enabled**
- Push protection: **enabled**
- Dependabot alerts: **enabled**
- Dependabot security updates: **enabled**
- CodeQL: provided by `.github/workflows/codeql.yml`

The repository needs no runtime secrets. Application secrets and `.env` files must
never be committed; `.gitignore` excludes them.

## Release environment

Use **Settings → Environments → release**:

- Required reviewer: `@yusufgulerr`
- Prevent self-review: **off** (the owner is the only reviewer)
- Environment secret: `NPM_TOKEN`, added only after npm authentication
- Deployment branches and tags: tags matching `v*`

The `release` environment is the irreversible publish gate. Do not add the npm
token to repository-wide secrets. See [RELEASING.md](RELEASING.md) for the
runbook and [VERIFICATION.md](VERIFICATION.md) for the current publication status.

## Verify from the command line

These checks are read-only:

```bash
gh api repos/yusufgulerr/adaptive-runtime/collaborators \
  --jq '.[] | {login, role_name}'
gh api repos/yusufgulerr/adaptive-runtime/invitations
gh api repos/yusufgulerr/adaptive-runtime/keys
gh api repos/yusufgulerr/adaptive-runtime/branches/main/protection
gh api repos/yusufgulerr/adaptive-runtime/rulesets
gh api repos/yusufgulerr/adaptive-runtime/actions/permissions
gh api repos/yusufgulerr/adaptive-runtime/actions/permissions/workflow
gh api repos/yusufgulerr/adaptive-runtime/actions/permissions/fork-pr-contributor-approval
gh api repos/yusufgulerr/adaptive-runtime/automated-security-fixes
```

Never print `NPM_TOKEN`, npm auth tokens, or private vulnerability reports in a
terminal transcript, issue, pull request, or CI log.

## References

- [GitHub repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)
- [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Managing GitHub Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
- [Using secrets in GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)
