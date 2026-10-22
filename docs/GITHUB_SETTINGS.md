# GitHub repository settings

This is the repository-specific settings and access checklist for
<https://github.com/yusufgulerr/adaptive-runtime>. The repository is owned by
`@yusufgulerr`; there is no organization or team layer to configure.

Only the owner changes these settings. Any change should be made through a pull
request that updates this file, `GOVERNANCE.md`, or both.

## Repository profile

| Item | Value |
| --- | --- |
| Description | `Deterministic, resource-aware adaptive execution runtime for TypeScript & Node.js — dynamic strategy orchestration via explicit signals, budgets, and hysteresis.` |
| Homepage | `https://github.com/yusufgulerr/adaptive-runtime#readme` |
| Topics | `adaptive-runtime`, `nodejs`, `typescript`, `policy-engine`, `resource-management`, `graceful-degradation`, `load-shedding`, `hysteresis`, `resilience`, `observability`, `performance`, `quality-of-service`, `zero-dependencies`, `esm` |
| Discussions | Enabled |
| Wiki | Not used; documentation lives in `docs/` |
| Issues | Enabled; blank issues disabled, forms only |

The repository label taxonomy covers `type:*`, `area:*`, `priority:*`, plus
`status:needs-triage`, `good first issue`, `help wanted`, `dependencies`,
`documentation`, `accessibility`, `skip-changelog` for release-note exclusion, and
the GitHub default labels. Keep label names stable; templates and saved searches
reference them. The issue forms and Discussion templates use these exact label
spellings.

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
it supports required code-owner reviews and the owner admin bypass
described below.

| Setting | Value |
| --- | --- |
| Require a pull request before merging | Enabled |
| Required approvals | 1 |
| Require review from Code Owners | Enabled |
| Dismiss stale pull request approvals when new commits are pushed | Enabled |
| Require approval of the most recent reviewable push | Enabled |
| Require status checks to pass | Enabled |
| Required checks | `Node 22`, `Node 24`, `Node 26`, `Analyze JavaScript/TypeScript`, `PR title` |
| Require branches to be up to date | Enabled |
| Require conversation resolution | Enabled |
| Require linear history | Enabled |
| Allow force pushes | Disabled |
| Allow deletions | Disabled |
| Enforce for administrators (`enforce_admins`) | Disabled; owner-only bypass documented below |

`enforce_admins` is intentionally off so the owner can merge their own pull
requests. GitHub does not allow a user to approve their own pull request, and the
project currently has one write-capable maintainer. External pull requests still
require the owner's code-owner approval; no other collaborator has write access to
satisfy it. See the contributor ladder in [GOVERNANCE.md](../GOVERNANCE.md).

The `.github/CODEOWNERS` file assigns every path, including the critical runtime,
policy, provider, documentation, and workflow directories, to `@yusufgulerr`.

If you migrate `main` from branch protection to a repository ruleset, use the
equivalent `pull_request`, `required_status_checks`, `non_fast_forward`,
`deletion`, and `required_linear_history` rules, with the repository admin role as
the only bypass actor. Do not enable both mechanisms at the same time unless you
have verified how their requirements combine.

Reference ruleset payload (OpenSSF-aligned; not applied today because branch
protection already enforces the same gate):

```json
{
  "name": "Protect main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Node 22" },
          { "context": "Node 24" },
          { "context": "Node 26" },
          { "context": "Analyze JavaScript/TypeScript" },
          { "context": "PR title" }
        ]
      }
    }
  ]
}
```

Apply it with `gh api --method POST repos/yusufgulerr/adaptive-runtime/rulesets
--input ruleset.json` only after disabling the overlapping branch protection
rule. Verify the resulting `required_status_checks` contexts before relying on it.

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
| Allowed actions | GitHub-owned actions plus the SHA-pinned `ossf/scorecard-action` |
| Require actions to be pinned to a full-length commit SHA | Enabled |
| Default workflow permissions | Read repository contents |
| Allow GitHub Actions to create or approve pull requests | Disabled |
| Fork pull request workflows | Require approval for all external contributors |

The workflows declare the minimum permissions they need. CI adds a cross-platform
job on Windows and macOS without changing the required Linux check names. The
fuzz workflow uses `contents: read` only, with SHA-pinned actions, and cannot
write to the repository or publish artifacts. The release workflow's
`github-release` job is the only job that requests `contents: write`;
`security-events: write` is limited to CodeQL and Scorecard, and
`id-token: write` is limited to the npm publication job and the Scorecard badge
publication. The npm publication job is additionally gated by the `release`
environment. GitHub release creation is a separate tag-push step and does not
publish to npm.

`actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294`
(v5.0.0) runs on every pull request and fails on high-severity vulnerable
dependency changes. It has `contents: read` and `pull-requests: write` (for the
summary comment) and does not run on tags.

Do not add a third-party action without an explicit owner decision, a pinned SHA,
and a review of its permissions. The Scorecard workflow is the only current
exception to the GitHub-owned-actions setting; allow `ossf/scorecard-action` by
its full SHA in **Settings → Actions → General → Allow specified actions**.

## Release notes

`.github/release.yml` configures generated GitHub release notes. `gh release
create --generate-notes` categorizes pull requests into Breaking Changes,
Features, Bug Fixes, Performance, Documentation, Dependencies, Tooling and CI,
and Other Changes. Add one of the matching labels before merging; use
`skip-changelog` for changes that should not appear. The tag-push path creates
generated notes; it does not publish to npm or move tags. npm publication is a
separate `workflow_dispatch` against the existing tag.

## Discussions templates

`.github/DISCUSSION_TEMPLATE/q-a.yml` and `ideas.yml` give Q&A and design
proposals structured fields. Discussions are enabled; the templates complement
the issue forms rather than replacing them. Security reports still go through
private vulnerability reporting, never a public Discussion.

## Pull request titles

`scripts/check-pr-title.mjs` validates the pull request title against the
Conventional Commits format used by [CONTRIBUTING.md](../CONTRIBUTING.md). The CI
`PR title` job runs on `pull_request` only. Add `PR title` to the required status
checks so an invalid title blocks merge. The validator is dependency-free, limits
the title to 100 characters, and accepts the types `feat`, `fix`, `docs`, `test`,
`refactor`, `perf`, `build`, `ci`, `chore`, and `revert`, with an optional
lowercase scope and an optional `!`.

## OpenSSF Scorecard

`.github/workflows/scorecard.yml` runs the OpenSSF Scorecard on `main`, on a weekly
schedule, and when branch-protection settings change. It uploads SARIF to code
scanning, keeps a five-day artifact, and publishes results to the Scorecard API so
the README badge can render. The workflow uses `permissions: read-all` at the top
level; only the analysis job gets `security-events: write` and
`id-token: write`. All actions are pinned to full commit SHAs, and the analysis
job uses only GitHub-owned actions plus `ossf/scorecard-action`.

The Scorecard result appears only after the first successful run on `main`.
Adding or changing the workflow does not prove a score; check the workflow run and
the badge before citing a result.

The separate OpenSSF Best Practices passing-level readiness assessment is in
[OPENSSF_BEST_PRACTICES.md](OPENSSF_BEST_PRACTICES.md). The project has not
registered for or earned that badge; the assessment is not a badge claim.

## Citation and editor metadata

`CITATION.cff` provides the repository citation metadata shown by GitHub's **Cite
this repository** action. `.vscode/extensions.json` recommends the Biome
extension, and `.vscode/settings.json` enables Biome as the formatter with
format-on-save. Both files are committed; all other `.vscode/` state remains
ignored.

There is no `.github/FUNDING.yml` because no GitHub Sponsors, Open Collective, or
other funding account is configured. Do not add a funding file that points to an
account the owner has not approved.

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
- Deployment branches and tags: tags matching `v*`
- Trusted publishing: npm publisher `yusufgulerr` / repository `adaptive-runtime`
  / workflow `release.yml` / environment `release`
- Environment secret: `NPM_TOKEN` only if the OIDC fallback is required; never add
  it to repository-wide secrets

The `release` environment is the irreversible npm publish gate. OIDC trusted
publishing needs no long-lived npm token: the job requests `id-token: write` and
npm verifies the workflow identity. See [RELEASING.md](RELEASING.md) for the
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
gh api repos/yusufgulerr/adaptive-runtime/actions/permissions/selected-actions
gh api repos/yusufgulerr/adaptive-runtime/actions/permissions/fork-pr-contributor-approval
gh run list --workflow=scorecard.yml --limit 1
gh api repos/yusufgulerr/adaptive-runtime/automated-security-fixes
gh api repos/yusufgulerr/adaptive-runtime/vulnerability-alerts
gh api repos/yusufgulerr/adaptive-runtime/topics
gh api repos/yusufgulerr/adaptive-runtime --jq '{description, homepage, has_discussions}'
```

Never print `NPM_TOKEN`, npm auth tokens, or private vulnerability reports in a
terminal transcript, issue, pull request, or CI log.

## References

- [GitHub repository roles](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)
- [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
- [Automatically generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)
- [About Discussions](https://docs.github.com/en/discussions)
- [OpenSSF Scorecard](https://github.com/ossf/scorecard)
- [OpenSSF Scorecard GitHub Action](https://github.com/ossf/scorecard-action)
- [CITATION.cff files](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-citation-files)
- [Managing GitHub Actions settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)
- [Using secrets in GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)
