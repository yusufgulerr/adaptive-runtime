# Security policy

## Supported versions

The project is at **0.1.0 and has not been published**. No version is currently
supported for production use. Once releases begin, the latest 0.x minor line will
receive security fixes on a best-effort basis; older lines may require an upgrade.

| Version | Supported |
| --- | --- |
| 0.1.x | Evaluation only, no production support |
| < 0.1 | Not released |

## Reporting a vulnerability

**Do not open a public issue with exploit details.**

Use **Security → Report a vulnerability** in the repository. That creates a
private discussion visible only to maintainers and the reporter.

If private advisories are not yet available, open a minimal public issue asking
for a private contact channel. Do not include reproduction steps, payloads,
tokens, or affected downstream users in that issue.

Please include, in the private report:

- affected version or commit;
- a description of the issue and its impact;
- reproduction steps or a minimal proof of concept;
- whether the issue is already public;
- any suggested mitigation.

## What to expect

This is a volunteer project without a bug bounty or a guaranteed response time.
Maintainers will make a best effort to:

1. acknowledge a report within a reasonable period;
2. reproduce and assess severity;
3. prepare a fix and tests;
4. coordinate disclosure and credit if desired;
5. publish an advisory once a fix is available.

Do not disclose the issue publicly until a fix or coordinated disclosure date is
agreed.

## Scope

In scope:

- the runtime's policy, state machine, and public API;
- provider lifecycle, timeout, abort, and validation behavior;
- package contents, build output, and release workflow integrity;
- denial-of-service issues caused by the library's own code;
- information disclosure through library-generated metadata.

Out of scope:

- vulnerabilities in application-supplied strategies or providers;
- incorrect `qualityTier` declarations;
- the inherent inability to preempt synchronous JavaScript;
- missing authorization or authentication in the host application;
- resource exhaustion caused solely by unbounded application concurrency;
- vulnerabilities in Node.js itself or third-party dev tooling.

The [threat model](docs/THREAT_MODEL.md) explains these boundaries in detail.

## Secure usage notes

- Treat strategies and providers as trusted code. The runtime is not a sandbox.
- Set operation and provider timeouts.
- Apply application-level concurrency limits and bound the number of operation ids.
- Never place secrets in signal `details`, provider `error`, or quality `detail`.
- Verify package provenance and pin versions in production.
- Redact telemetry before exporting it to third parties.

## Dependency and release security

- The published package has no runtime dependencies.
- Development dependencies are locked by `package-lock.json`.
- CI runs CodeQL and Dependabot is configured for npm and GitHub Actions.
- Releases are intended to be tag-driven and published with npm provenance.
- The repository is public, but npm publication and remote CI verification are
  still pending; do not assume those controls are active yet.
