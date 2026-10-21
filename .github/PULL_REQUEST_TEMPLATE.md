<!--
Keep pull requests focused. Do not include secrets, tokens, or production data.
-->
## Summary

<!-- What changed and why? -->

## Related issue

<!-- e.g. Closes #123 -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation only
- [ ] Tooling / CI
- [ ] Refactor with no behavior change

## Behavior and compatibility

<!--
Describe public API changes, decision semantics, defaults, or error changes.
Write "none" when not applicable. Breaking changes require an ADR and a major
version plan.
-->

## Verification

<!-- Paste the exact commands and their final result lines. -->

```text
$ npm run lint
$ npm run typecheck
$ npm test
$ npm run test:coverage
$ npm run build
```

## Checklist

- [ ] I read CONTRIBUTING.md and followed the project conventions.
- [ ] I added or updated tests for the change.
- [ ] I updated documentation and CHANGELOG.md for user-visible changes.
- [ ] I did not add a runtime dependency without an accepted ADR.
- [ ] I did not introduce placeholders, TODOs, or disabled tests.
- [ ] I did not commit `dist/`, secrets, tokens, or local paths.
- [ ] Timeouts and aborts remain cooperative and are documented as such.
- [ ] Missing signals are still not coerced to zero.
- [ ] No automatic retry or mid-run strategy switch was introduced.
