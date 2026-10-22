import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/check-markdown-links.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

const temporaryDirectories: string[] = [];

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(root: string, extraArguments: readonly string[] = []): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, "--root", root, ...extraArguments], {
      encoding: "utf8",
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

function createTree(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "adaptive-runtime-markdown-links-"));
  temporaryDirectories.push(directory);

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(directory, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }

  return directory;
}

describe("markdown link validation", () => {
  it("accepts relative links, images, root-relative paths, and fragments", () => {
    const root = createTree({
      "README.md": [
        "# Fixture",
        "",
        "[guide](docs/guide.md)",
        "![logo](assets/logo.png)",
        "[root-relative](/docs/guide.md)",
        "[query and fragment](docs/guide.md?view=1#intro)",
        "",
      ].join("\n"),
      "docs/guide.md": "# Guide\n",
      "assets/logo.png": "not really an image\n",
    });

    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /4 relative links/);
    assert.match(result.stdout, /0 broken/);
  });

  it("reports every broken relative link", () => {
    const root = createTree({
      "README.md": ["# Fixture", "", "[missing](docs/missing.md)", "[outside](../outside.md)"].join(
        "\n",
      ),
    });

    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /README\.md -> docs\/missing\.md/);
    assert.match(result.stderr, /README\.md -> \.\.\/outside\.md/);
    assert.match(result.stdout, /2 broken/);
  });

  it("skips external, protocol-relative, data, mail, telephone, and anchor links", () => {
    const root = createTree({
      "README.md": [
        "# Fixture",
        "",
        "[https](https://example.com/docs)",
        "[http](http://example.com/docs)",
        "[mail](mailto:maintainer@example.com)",
        "[telephone](tel:+15555550100)",
        "[data](data:text/plain,hello)",
        "[protocol-relative](//cdn.example.com/file.md)",
        "[anchor](#fixture)",
        "",
        "```md",
        "[inside code fence](missing.md)",
        "```",
        "",
        "`[inline code](missing.md)`",
        "",
      ].join("\n"),
    });

    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 relative links/);
    assert.match(result.stdout, /0 broken/);
  });

  it("supports angle-bracket destinations, titles, and percent-encoded paths", () => {
    const root = createTree({
      "README.md": [
        "# Fixture",
        "",
        "[space](<docs/with space.md>)",
        "[encoded](docs/with%20space.md)",
        '[title](<docs/with space.md> "Guide title")',
        "[single title](<docs/other file.md> 'Other title')",
        "",
      ].join("\n"),
      "docs/with space.md": "# Spaced\n",
      "docs/other file.md": "# Other\n",
    });

    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /4 relative links/);
    assert.match(result.stdout, /0 broken/);
  });

  it("excludes generated and tooling directories", () => {
    const root = createTree({
      "README.md": "[guide](docs/guide.md)\n",
      "docs/guide.md": "# Guide\n",
      "node_modules/package/README.md": "[broken](missing.md)\n",
      ".git/README.md": "[broken](missing.md)\n",
      "dist/README.md": "[broken](missing.md)\n",
      "coverage/README.md": "[broken](missing.md)\n",
      ".venv/README.md": "[broken](missing.md)\n",
      ".tmp/README.md": "[broken](missing.md)\n",
    });

    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 files/);
    assert.match(result.stdout, /0 broken/);
  });

  it("prints a parseable JSON summary for success and failure", () => {
    const validRoot = createTree({
      "README.md": "[guide](docs/guide.md)\n",
      "docs/guide.md": "# Guide\n",
    });

    const success = run(validRoot, ["--json"]);
    assert.equal(success.status, 0, success.stderr);

    const successReport = JSON.parse(success.stdout) as {
      ok: boolean;
      files: number;
      links: number;
      brokenCount: number;
      broken: string[];
    };
    assert.equal(successReport.ok, true);
    assert.equal(successReport.files, 2);
    assert.equal(successReport.links, 1);
    assert.equal(successReport.brokenCount, 0);
    assert.deepEqual(successReport.broken, []);

    const brokenRoot = createTree({ "README.md": "[missing](missing.md)\n" });
    const failure = run(brokenRoot, ["--json"]);
    assert.equal(failure.status, 1);

    const failureReport = JSON.parse(failure.stdout) as {
      ok: boolean;
      brokenCount: number;
      broken: string[];
    };
    assert.equal(failureReport.ok, false);
    assert.equal(failureReport.brokenCount, 1);
    assert.deepEqual(failureReport.broken, ["README.md -> missing.md"]);
  });

  it("passes against the repository with zero broken links", () => {
    const result = run(repoRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /0 broken/);

    const match = /(\d+) files, (\d+) relative links, 0 broken/.exec(result.stdout);
    assert.ok(match, result.stdout);
    assert.ok(Number(match[1] ?? "0") > 0);
    assert.ok(Number(match[2] ?? "0") > 0);
  });
});
