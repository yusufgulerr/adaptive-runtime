# OpenSSF Best Practices readiness

**Status:** Passing-level self-assessment prepared on **2026-10-22**. The project
has **not** registered for or earned an OpenSSF Best Practices badge. This
document is a readiness record and an application checklist, not a badge claim.

## Target

| Item | Value |
| --- | --- |
| Program | [OpenSSF Best Practices Badge](https://www.bestpractices.dev/en) |
| Series | Metal (the original passing / silver / gold series) |
| Target level | Passing |
| Repository | <https://github.com/yusufgulerr/adaptive-runtime> |
| Project website | <https://github.com/yusufgulerr/adaptive-runtime#readme> |
| Version assessed | `0.3.0` |
| License | Apache-2.0 |
| Criteria snapshot | [Passing criteria](https://www.bestpractices.dev/en/criteria/0?details=true), retrieved 2026-10-22 |

The 67 passing criteria below are a snapshot of the BadgeApp criteria on the date
above. Re-check the live criteria before submitting; the BadgeApp may add
clarifications or future criteria.

The project is not listed in the BadgeApp project directory as of 2026-10-22. No
badge image is used in the README or elsewhere, and no badge URL is claimed.

## Summary

| Result | Count | Meaning |
| --- | ---: | --- |
| Met with repository evidence | 52 | Direct links or reproducible checks support the answer. |
| Owner attestation required | 2 | The owner must personally confirm secure-design and common-error knowledge. |
| Not applicable | 13 | The condition does not apply (no cryptography, no memory-unsafe code, no known vulnerabilities, no reports in the measurement window). |
| Unmet | 0 | No passing criterion is currently known to be unmet. |

The two owner attestations are the only answers that cannot be established from
the repository alone. They must be confirmed by the primary developer in the
BadgeApp form, not inferred by a tool.

## How to apply

1. Sign in at <https://www.bestpractices.dev/en/login> with GitHub. The site
   creates an account on first login.
2. Add a project at <https://www.bestpractices.dev/en/projects/new>.
3. Use these metadata values:
   - **Name:** Adaptive Runtime
   - **Description:** Deterministic, zero-dependency TypeScript runtime for
     resource-aware algorithmic strategy orchestration.
   - **Repository URL:** <https://github.com/yusufgulerr/adaptive-runtime>
   - **Homepage URL:** <https://github.com/yusufgulerr/adaptive-runtime#readme>
   - **License:** Apache-2.0
4. Choose the **metal** series and start with the **passing** badge.
5. Fill the criteria using the table below. For criteria marked **Owner
   attestation**, the owner must confirm the answer personally.
6. Submit the passing-level application. The BadgeApp may run automated checks
   and may show discrepancies; correct the application rather than forcing an
   answer.
7. Only after the badge is awarded, add the badge image and project URL to the
   README. The badge URL has the form
   `https://www.bestpractices.dev/projects/<id>` and the badge image URL is
   available from the project page.
8. Record the awarded badge ID, date, and URL in `docs/VERIFICATION.md`.

## Submission URLs

Use absolute URLs in the BadgeApp form. These are the stable values:

| Purpose | URL |
| --- | --- |
| Project website / README | <https://github.com/yusufgulerr/adaptive-runtime#readme> |
| Source repository | <https://github.com/yusufgulerr/adaptive-runtime> |
| Contributing process | <https://github.com/yusufgulerr/adaptive-runtime/blob/main/CONTRIBUTING.md> |
| Contribution requirements | <https://github.com/yusufgulerr/adaptive-runtime/blob/main/CONTRIBUTING.md#tests> |
| License | <https://github.com/yusufgulerr/adaptive-runtime/blob/main/LICENSE> |
| Documentation | <https://github.com/yusufgulerr/adaptive-runtime#readme> |
| Interface reference | <https://github.com/yusufgulerr/adaptive-runtime/blob/main/docs/API.md> |
| Discussion | <https://github.com/yusufgulerr/adaptive-runtime/discussions> |
| Bug reports | <https://github.com/yusufgulerr/adaptive-runtime/issues> |
| Bug report form | <https://github.com/yusufgulerr/adaptive-runtime/issues/new?template=bug_report.yml> |
| Release notes | <https://github.com/yusufgulerr/adaptive-runtime/blob/main/CHANGELOG.md> |
| Latest release | <https://github.com/yusufgulerr/adaptive-runtime/releases/tag/v0.3.0> |
| Vulnerability process | <https://github.com/yusufgulerr/adaptive-runtime/blob/main/SECURITY.md> |
| Private vulnerability reporting | <https://github.com/yusufgulerr/adaptive-runtime/security/advisories/new> |
| Support | <https://github.com/yusufgulerr/adaptive-runtime/blob/main/SUPPORT.md> |
| Static analysis | <https://github.com/yusufgulerr/adaptive-runtime/blob/main/.github/workflows/codeql.yml> |
| CI | <https://github.com/yusufgulerr/adaptive-runtime/blob/main/.github/workflows/ci.yml> |
| Verification record | <https://github.com/yusufgulerr/adaptive-runtime/blob/main/docs/VERIFICATION.md> |

## Criterion-by-criterion assessment

### Basics

| Criterion | Answer | Evidence / application note |
| --- | --- | --- |
| `description_good` | **Met** | The opening README paragraph and [Why](../README.md#why) explain the problem and the runtime's purpose in user-facing language. |
| `interact` | **Met** | [Installation](../README.md#installation), [Quick start](../README.md#quick-start), [Security](../README.md#security), and [Contributing](../README.md#contributing) cover obtaining, feedback, and contribution paths. |
| `contribution` | **Met** | [CONTRIBUTING.md](../CONTRIBUTING.md) documents forks, branches, pull requests, issue forms, and review expectations. |
| `contribution_requirements` | **Met** | [CONTRIBUTING.md § Tests](../CONTRIBUTING.md#tests), [§ Review criteria](../CONTRIBUTING.md#review-criteria), `biome.json`, and `tsconfig.json` define tests, style, and strict TypeScript requirements. |
| `floss_license` | **Met** | [LICENSE](../LICENSE) is Apache-2.0, an OSI-approved FLOSS license. |
| `floss_license_osi` | **Met** | Apache-2.0 is OSI-approved. |
| `license_location` | **Met** | [LICENSE](../LICENSE) is a top-level standard-location file. |
| `documentation_basics` | **Met** | README install/quick start, [COOKBOOK](COOKBOOK.md), and [SECURITY.md](../SECURITY.md) cover install, use, and secure-use boundaries. |
| `documentation_interface` | **Met** | [API.md](API.md) documents the public types, methods, errors, events, defaults, and subpath entry points; generated declarations ship in `dist`. |
| `sites_https` | **Met** | Repository, release, documentation, and issue URLs use HTTPS on GitHub. Registry delivery will use HTTPS on npm. |
| `discussion` | **Met** | GitHub Discussions is enabled; GitHub Issues and pull-request discussions provide searchable, URL-addressable, asynchronous discussion. |
| `english` | **Met** | All project documentation and issue templates are in English. |
| `maintained` | **Met** | Active 0.3.0 release, regular commits, CI, CodeQL, Dependabot, and a documented security-response path. |

### Change control

| Criterion | Answer | Evidence / application note |
| --- | --- | --- |
| `repo_public` | **Met** | Public repository at <https://github.com/yusufgulerr/adaptive-runtime>. |
| `repo_track` | **Met** | Git history records author, timestamp, and change content for every commit. |
| `repo_interim` | **Met** | Pull requests and the commit history expose interim review versions between releases. |
| `repo_distributed` | **Met** | Git is used; the repository is distributed through GitHub and normal clones/forks. |
| `version_unique` | **Met** | `0.3.0` identifies the release; annotated tag `v0.3.0` points to the release commit. |
| `version_semver` | **Met** | `package.json` and the release process use Semantic Versioning. |
| `version_tags` | **Met** | [Release v0.3.0](https://github.com/yusufgulerr/adaptive-runtime/releases/tag/v0.3.0) is identified by an annotated Git tag. |
| `release_notes` | **Met** | [CHANGELOG.md](../CHANGELOG.md) provides human-readable release notes; the GitHub release has generated categorized notes. |
| `release_notes_vulns` | **N/A** | No publicly known runtime vulnerability or CVE existed for 0.3.0 at release time; GitHub security advisories are empty. |

### Reporting

| Criterion | Answer | Evidence / application note |
| --- | --- | --- |
| `report_process` | **Met** | [SUPPORT.md](../SUPPORT.md) and the [bug report form](https://github.com/yusufgulerr/adaptive-runtime/issues/new?template=bug_report.yml) define the bug-reporting process. |
| `report_tracker` | **Met** | GitHub Issues is the issue tracker; Discussions handles open-ended usage questions. |
| `report_responses` | **Met** | No bug reports have been submitted since the public repository was created in October 2026, so there are no unacknowledged reports. The tracker and Discussions are monitored. If the form requires a ratio, use `100% (0/0)` and explain that no reports exist yet. |
| `enhancement_responses` | **Met** | No enhancement requests have been submitted since the repository became public. The feature-request form and Discussions are available and monitored. |
| `report_archive` | **Met** | GitHub Issues and Discussions retain public, searchable, URL-addressable reports and responses. |
| `vulnerability_report_process` | **Met** | [SECURITY.md](../SECURITY.md) publishes the private reporting path and the response process. |
| `vulnerability_report_private` | **Met** | [SECURITY.md](../SECURITY.md) points to GitHub private vulnerability reporting; private reporting is enabled on the repository. |
| `vulnerability_report_response` | **N/A** | No vulnerability reports have been received since the public repository was created. The documented target is acknowledgement within 72 hours, well inside the 14-day criterion. |

### Quality

| Criterion | Answer | Evidence / application note |
| --- | --- | --- |
| `build` | **Met** | `npm run build` runs `tsc -p tsconfig.json`; CI rebuilds from source on Node 22, 24, and 26. |
| `build_common_tools` | **Met** | npm, TypeScript `tsc`, and Biome are standard, widely used tools for this ecosystem. |
| `build_floss_tools` | **Met** | npm, TypeScript, Biome, tsx, and the test runner are FLOSS tools. |
| `test` | **Met** | `npm test` runs the public FLOSS test suite: 256 tests across 45 suites in `tests/unit` and `tests/integration`. |
| `test_invocation` | **Met** | `npm test` is the standard Node.js/npm invocation; `npm run test:coverage` adds the coverage gate. |
| `test_most` | **Met** | [VERIFICATION.md](VERIFICATION.md) records 99.10% lines, 96.91% branches, and 98.64% functions; every `src/**` file is above 80% branch coverage. |
| `test_continuous_integration` | **Met** | [ci.yml](../.github/workflows/ci.yml) runs the suite on Node 22/24/26 and on Windows/macOS; pull requests and `main` are covered. |
| `test_policy` | **Met** | [CONTRIBUTING.md § Tests](../CONTRIBUTING.md#tests) requires regression tests for bug fixes and unit/integration tests for new behavior. |
| `tests_are_added` | **Met** | Recent feature PRs added substantial tests: #8 (composite/web/edge providers), #10 (observability), #11 (testing SDK and packaging), and #12 (export and PR-title checks). |
| `tests_documented_added` | **Met** | The test policy is documented in CONTRIBUTING and the pull-request checklist requires added or updated tests. |
| `warnings` | **Met** | Biome lint/format and TypeScript `strict` with `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, and `noImplicitOverride`. |
| `warnings_fixed` | **Met** | `npm run check` passes lint, typecheck, tests, build, and export verification on the release tree. |
| `warnings_strict` | **Met** | `strict: true` plus the additional strictness flags in `tsconfig.json`; Biome recommended rules and `noExplicitAny: error`. |

### Security

| Criterion | Answer | Evidence / application note |
| --- | --- | --- |
| `know_secure_design` | **Owner attestation** | The owner must confirm knowledge of secure-design principles. Supporting material: [THREAT_MODEL.md](THREAT_MODEL.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [SECURITY.md](../SECURITY.md). |
| `know_common_errors` | **Owner attestation** | The owner must confirm knowledge of common vulnerability classes and mitigations. The threat model covers denial of service, data leakage, trust boundaries, input validation, and provider failure modes. |
| `crypto_published` | **N/A** | The package does not implement cryptography and uses no cryptographic protocols. |
| `crypto_call` | **N/A** | The package does not implement or call cryptographic primitives; it has no runtime dependencies. |
| `crypto_floss` | **N/A** | No cryptography is used, so there is no cryptographic functionality to implement with FLOSS. |
| `crypto_keylength` | **N/A** | The package has no cryptographic keys or security mechanisms with key lengths. |
| `crypto_working` | **N/A** | The package uses no cryptographic algorithms or cipher modes. |
| `crypto_weaknesses` | **N/A** | The package uses no cryptographic algorithms or modes. |
| `crypto_pfs` | **N/A** | The package implements no key-agreement protocol. |
| `crypto_password_storage` | **N/A** | The package does not authenticate external users or store passwords. |
| `crypto_random` | **N/A** | The package generates no cryptographic keys or nonces; it has no random-number generation for security purposes. |
| `delivery_mitm` | **Met** | Source and releases are delivered over HTTPS on GitHub; npm publication uses HTTPS and OIDC provenance when it is performed. |
| `delivery_unsigned` | **Met** | No cryptographic hash is retrieved over HTTP for verification. npm publishes `dist.integrity` and provenance through the HTTPS registry workflow. |
| `vulnerabilities_fixed_60_days` | **Met** | No publicly known medium-or-higher severity vulnerability has been reported or left unpatched. GitHub security advisories and Dependabot alerts are currently empty. |
| `vulnerabilities_critical_fixed` | **Met** | No known critical vulnerability is open; the project uses private reporting, Dependabot, and CodeQL. |
| `no_leaked_credentials` | **Met** | GitHub secret scanning and push protection are enabled; a targeted scan of the working tree and Git history found no token, private-key, or common credential patterns. |

### Analysis

| Criterion | Answer | Evidence / application note |
| --- | --- | --- |
| `static_analysis` | **Met** | [CodeQL](../.github/workflows/codeql.yml) runs `security-extended` queries for JavaScript/TypeScript; Biome adds lint/static quality checks. |
| `static_analysis_common_vulnerabilities` | **Met** | CodeQL's security queries cover common JavaScript/TypeScript vulnerability classes. |
| `static_analysis_fixed` | **Met** | No open CodeQL security findings are reported. The six open code-scanning alerts are Scorecard governance/automation findings, tracked separately from source vulnerabilities. |
| `static_analysis_often` | **Met** | CodeQL runs on pull requests, pushes to `main`, and a weekly schedule. |
| `dynamic_analysis` | **Met** | The automated test suite exercises the code with actual inputs and has 96.91% branch coverage, above the criterion's 80% branch-coverage alternative. |
| `dynamic_analysis_unsafe` | **N/A** | The project is TypeScript/JavaScript and produces no memory-unsafe native code. |
| `dynamic_analysis_enable_assertions` | **Met** | Tests use `node:test` assertions and fail on unexpected behavior; assertions are enabled in the test configuration. |
| `dynamic_analysis_fixed` | **N/A** | No medium-or-higher severity vulnerability has been discovered through dynamic analysis. |

## Owner attestations

The owner must personally confirm these two answers in the BadgeApp:

1. **`know_secure_design`** — familiarity with secure-design principles such as
   least privilege, fail-safe defaults, complete mediation, separation of
   privilege, limited attack surface, and allowlist input validation.
2. **`know_common_errors`** — familiarity with common vulnerability classes and
   at least one mitigation for each relevant class.

The repository provides supporting evidence, but it cannot substitute for the
owner's attestation. Do not submit these as "Met" unless the owner has reviewed
and confirmed them.

## Higher-level gaps

This assessment targets the passing badge. The project is not ready to claim
silver or gold:

- **Silver:** bus factor and access continuity are the main blockers because only
  the owner currently has admin access. A DCO/sign-off policy, documented
  cryptographic release signing with public verification keys, and a formal
  assurance case should be added before a silver application. Statement coverage
  (99.10%) already exceeds the silver 80% threshold.
- **Gold:** requires at least two unassociated significant contributors, per-file
  copyright/license information, independent review of at least 50% of
  modifications, and a reproducible build, among other criteria.
- **Baseline series:** OpenSSF also offers OSPS Baseline levels 1-3 through the
  same BadgeApp. This document targets the metal passing badge; the baseline
  series is a separate follow-up.
- **Fuzzing:** the current automated tests satisfy the passing dynamic-analysis
  criterion, but there is no dedicated fuzzer integration. This is a reasonable
  post-passing hardening item and would also address the Scorecard `Fuzzing`
  check.
- **Secret scanning:** GitHub secret scanning and push protection are enabled, but
  non-provider patterns and validity checks are currently disabled. Consider
  enabling them as part of supply-chain hardening.

## Relationship to OpenSSF Scorecard

The current Scorecard result is 7/10. Relevant findings:

| Check | Current result | Relationship to this work |
| --- | --- | --- |
| `CII-Best-Practices` | 0 | Registering and earning the passing badge should improve this check. |
| `Fuzzing` | 0 | Not required for the passing badge; a follow-up fuzzer integration would improve it. |
| `Code-Review` | 0 | The owner currently self-merges with admin bypass; adding a second reviewer is a silver/gold and governance follow-up. |
| `Branch-Protection` | 8 | Required review count is 1; the owner bypass is documented in GOVERNANCE. |
| `Pinned-Dependencies` | 8 | `npmCommand` is not pinned by hash; actions are SHA-pinned. |

Do not treat the Scorecard findings as code vulnerabilities. The badge application
addresses the `CII-Best-Practices` gap; the other findings need separate work.

## Maintenance

- Re-run the readiness review when the passing criteria change, when a release is
  prepared, or when a security process changes.
- Update the evidence links if documentation moves.
- Keep the application answers aligned with `SECURITY.md`, `CONTRIBUTING.md`,
  `GOVERNANCE.md`, and `docs/VERIFICATION.md`.
- Never add a badge image before the BadgeApp awards the badge.
