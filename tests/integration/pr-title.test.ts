import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/check-pr-title.mjs", import.meta.url));

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(title: string): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, PR_TITLE: title },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("pull request title validation", () => {
  it("accepts Conventional Commit titles", () => {
    for (const title of [
      "feat: add execution budget provider",
      "fix(policy): preserve budget state on cached samples",
      "docs(providers): document abort behavior",
      "chore(deps): bump the actions group",
      "feat(core)!: remove the legacy provider entry point",
      "revert: restore the previous release workflow",
    ]) {
      const result = run(title);
      assert.equal(result.status, 0, `${title} should be accepted: ${result.stderr}`);
      assert.match(result.stdout, /Pull request title OK/);
    }
  });

  it("rejects titles without an allowed type", () => {
    for (const title of [
      "Add execution budget provider",
      "Feature: add execution budget provider",
      "feat add execution budget provider",
      "feat(core)add execution budget provider",
      "feat(Core): add execution budget provider",
    ]) {
      const result = run(title);
      assert.equal(result.status, 1, `${title} should be rejected`);
      assert.match(result.stderr, /Invalid pull request title/);
    }
  });

  it("rejects empty, padded, and overlong titles", () => {
    const empty = run("");
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /empty/);

    const padded = run("  feat: add a provider  ");
    assert.equal(padded.status, 1);
    assert.match(padded.stderr, /leading or trailing whitespace/);

    const overlong = run(`feat: ${"a".repeat(100)}`);
    assert.equal(overlong.status, 1);
    assert.match(overlong.stderr, /maximum is 100/);
  });
});
