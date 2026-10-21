<!--
Keep pull requests focused. Do not include secrets, tokens, or production data.
Read CONTRIBUTING.md before opening the pull request.
-->
## Summary

<!-- What changed and why? Keep this to a few sentences. -->

## Related issue

Fixes #

<!--
Use `Fixes #123` when this pull request closes an issue. If there is no issue,
write `N/A` and explain the motivation above. Do not leave this blank.
-->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation only
- [ ] Tooling / CI
- [ ] Refactor with no behavior change

## What changed

<!-- List the concrete code, tests, and documentation changes. -->

## Behavior and compatibility

<!--
Describe public API changes, decision semantics, defaults, or error changes.
Write "none" when not applicable. Breaking changes require an ADR and a major
version plan.
-->

## Security and privacy

- [ ] I did not include secrets, tokens, `.env` contents, or customer data.
- [ ] I did not add unsanitized input, signal details, or error text to logs.
- [ ] I considered the trust boundary described in `docs/THREAT_MODEL.md`.

## Verification

<!-- Paste the exact commands and their final result lines. -->

```text
$ npm ci
$ npm run check
$ npm run test:coverage
$ npm pack --dry-run
```

## Checklist

- [ ] I read `CONTRIBUTING.md` and followed the project conventions.
- [ ] I used a Conventional Commit message and a focused branch.
- [ ] I added or updated tests for the change.
- [ ] I updated documentation and `CHANGELOG.md` for user-visible changes.
- [ ] I did not add a runtime dependency without an accepted ADR.
- [ ] I did not introduce placeholders, TODOs, or disabled tests.
- [ ] I did not commit `dist/`, secrets, tokens, local paths, or editor state.
- [ ] Timeouts and aborts remain cooperative and are documented as such.
- [ ] Missing signals are still not coerced to zero.
- [ ] No automatic retry or mid-run strategy switch was introduced.
- [ ] I have the right to submit this contribution under Apache-2.0.
