#!/usr/bin/env node

const ALLOWED_TYPES = [
  "feat",
  "fix",
  "docs",
  "test",
  "refactor",
  "perf",
  "build",
  "ci",
  "chore",
  "revert",
];

const TITLE_PATTERN = new RegExp(
  `^(?:${ALLOWED_TYPES.join("|")})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S.*$`,
);
const MAX_LENGTH = 100;

function validate(title) {
  if (title.length === 0) {
    return "the pull request title is empty.";
  }
  if (title !== title.trim()) {
    return "the title has leading or trailing whitespace.";
  }
  if (title.length > MAX_LENGTH) {
    return `the title is ${title.length} characters; the maximum is ${MAX_LENGTH}.`;
  }
  if (!TITLE_PATTERN.test(title)) {
    return "the title does not match the Conventional Commits format.";
  }
  return null;
}

const title = process.env.PR_TITLE ?? process.argv.slice(2).join(" ");
const error = validate(title);

if (error !== null) {
  console.error(`Invalid pull request title: ${error}`);
  console.error("");
  console.error("Expected: <type>(<scope>): <summary>");
  console.error(`Types: ${ALLOWED_TYPES.join(", ")}`);
  console.error("Example: feat(providers): add execution budget provider");
  process.exit(1);
}

console.log(`Pull request title OK: ${title}`);
