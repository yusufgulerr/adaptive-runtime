# Support

## Documentation first

- [README](README.md) — overview, quick start, selection semantics, limitations.
- [API reference](docs/API.md) — types, methods, errors, events, defaults.
- [Architecture](docs/ARCHITECTURE.md) — internal design and concurrency model.
- [Threat model](docs/THREAT_MODEL.md) — trust boundaries and non-goals.
- [Roadmap](docs/ROADMAP.md) — current scope and planned work.
- [Benchmarks](docs/BENCHMARKS.md) — methodology and local measurements.

## Questions and bugs

- **Usage questions / design discussion:** use the usage question issue form.
  GitHub Discussions is not enabled yet.
- **Bug reports:** use the bug report issue form and include a minimal
  reproduction, Node version, package version, and expected/actual behavior.
- **Feature requests:** use the feature request issue form and describe the
  problem before the proposed API.
- **Security issues:** follow [SECURITY.md](SECURITY.md). Never post exploit
  details publicly.

## What to include

A useful report contains:

- package version or commit;
- Node.js version and OS;
- the smallest code sample that reproduces the issue;
- the full error name, `code`, message, and `cause` if present;
- the decision metadata (`kind`, `reasons`, `budgets`) when selection is involved;
- whether a pin, adaptation override, custom clock, or custom provider is in use.

Do not include secrets, tokens, customer data, or unredacted production logs.

## Scope and expectations

Support is best effort, provided by volunteers. There is no SLA, paid support, or
guaranteed response time. The project does not currently provide:

- production incident support;
- consulting or integration services;
- guarantees that a strategy's output is correct;
- sandboxing for untrusted code.

For production use, pin a verified version, monitor decisions and provider errors,
and test your own strategies and policies under realistic load.
