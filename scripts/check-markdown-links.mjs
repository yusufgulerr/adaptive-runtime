#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".venv", ".tmp"]);

const USAGE = `Usage: node scripts/check-markdown-links.mjs [options]

Checks every relative Markdown link and image target for an existing file or
directory.

Options:
  --root <path>  repository root to scan (default: the repository root)
  --json         print one JSON summary instead of human-readable text
  --help         show this help message
`;

function parseArguments(argv) {
  const options = { root: repoRoot, json: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--json") {
      options.json = true;
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    if (argument === "--root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--root requires a path.");
      }
      options.root = resolve(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

function toDisplayPath(path) {
  return path.split(sep).join("/");
}

function compareNames(left, right) {
  if (left.name < right.name) {
    return -1;
  }
  if (left.name > right.name) {
    return 1;
  }
  return 0;
}

function collectTrackedMarkdownFiles(root) {
  if (resolve(root) !== resolve(repoRoot)) {
    return null;
  }
  try {
    const output = execFileSync(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => resolve(root, entry))
      .sort();
  } catch {
    return null;
  }
}

async function collectMarkdownFiles(root) {
  const trackedFiles = collectTrackedMarkdownFiles(root);
  if (trackedFiles !== null) {
    return trackedFiles;
  }

  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort(compareNames);

    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          await walk(absolutePath);
        }
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(absolutePath);
      }
    }
  }

  await walk(root);
  return files;
}

function maskCode(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fenceCharacter = null;

  const maskedLines = lines.map((line) => {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceCharacter === null && fence !== null) {
      fenceCharacter = fence[1][0];
      return " ".repeat(line.length);
    }
    if (fenceCharacter !== null) {
      if (fence !== null && fence[1][0] === fenceCharacter) {
        fenceCharacter = null;
      }
      return " ".repeat(line.length);
    }
    return line;
  });

  return maskedLines
    .join("\n")
    .replace(/`[^`\n]*`/g, (match) => " ".repeat(match.length))
    .replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, " "));
}

function findClosingBracket(text, openIndex) {
  let depth = 0;

  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function findClosingParenthesis(text, openIndex) {
  let depth = 0;

  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    } else if (character === "\n") {
      return -1;
    }
  }

  return -1;
}

function parseDestination(source) {
  const trimmed = source.trimStart();
  if (trimmed.startsWith("<")) {
    const endIndex = trimmed.indexOf(">", 1);
    return endIndex === -1 ? null : trimmed.slice(1, endIndex);
  }

  let depth = 0;
  let index = 0;
  while (index < trimmed.length) {
    const character = trimmed[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (/\s/.test(character) && depth === 0) {
      break;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      if (depth === 0) {
        break;
      }
      depth -= 1;
    }
    index += 1;
  }

  const destination = trimmed.slice(0, index);
  return destination.length === 0 ? null : destination;
}

function extractDestinations(markdown) {
  const destinations = [];
  const pattern = /!?\[/g;
  let match = pattern.exec(markdown);

  while (match !== null) {
    const openBracketIndex = match.index + match[0].length - 1;
    const closeBracketIndex = findClosingBracket(markdown, openBracketIndex);
    let nextIndex = match.index + match[0].length;

    if (closeBracketIndex !== -1 && markdown[closeBracketIndex + 1] === "(") {
      const openParenthesisIndex = closeBracketIndex + 1;
      const closeParenthesisIndex = findClosingParenthesis(markdown, openParenthesisIndex);

      if (closeParenthesisIndex !== -1) {
        const destination = parseDestination(
          markdown.slice(openParenthesisIndex + 1, closeParenthesisIndex),
        );
        if (destination !== null) {
          destinations.push(destination);
        }
        nextIndex = closeParenthesisIndex + 1;
      }
    }

    pattern.lastIndex = nextIndex;
    match = pattern.exec(markdown);
  }

  return destinations;
}

function normalizeTarget(destination) {
  const target = destination.trim();
  if (target.length === 0 || target.startsWith("#") || target.startsWith("//")) {
    return null;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(target)) {
    return null;
  }

  const withoutFragment = target.split("#")[0];
  const withoutQuery = withoutFragment.split("?")[0];
  if (withoutQuery.length === 0) {
    return null;
  }
  return withoutQuery;
}

function resolveTarget(root, markdownFile, target) {
  let decoded;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }

  if (decoded.startsWith("/")) {
    return resolve(root, `.${decoded}`);
  }
  return resolve(dirname(markdownFile), decoded);
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`Markdown link check failed: ${error.message}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }

  let markdownFiles = [];
  const brokenLinks = [];
  let linkCount = 0;

  try {
    const rootStat = await stat(options.root);
    if (!rootStat.isDirectory()) {
      throw new Error(`The scan root is not a directory: ${options.root}`);
    }

    markdownFiles = await collectMarkdownFiles(options.root);

    for (const markdownFile of markdownFiles) {
      const markdown = await readFile(markdownFile, "utf8");
      const displayFile = toDisplayPath(relative(options.root, markdownFile));

      for (const destination of extractDestinations(maskCode(markdown))) {
        const target = normalizeTarget(destination);
        if (target === null) {
          continue;
        }
        linkCount += 1;

        const resolvedTarget = resolveTarget(options.root, markdownFile, target);
        try {
          await stat(resolvedTarget);
        } catch {
          brokenLinks.push(`${displayFile} -> ${target}`);
        }
      }
    }
  } catch (error) {
    console.error(`Markdown link check failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const report = {
    ok: brokenLinks.length === 0,
    root: options.root,
    files: markdownFiles.length,
    links: linkCount,
    brokenCount: brokenLinks.length,
    broken: brokenLinks,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (!report.ok) {
    console.error(`Broken relative links (${report.brokenCount}):`);
    for (const brokenLink of report.broken) {
      console.error(`  ${brokenLink}`);
    }
    process.exitCode = 1;
  }

  console.log(
    `Markdown links: ${report.files} files, ${report.links} relative links, ` +
      `${report.brokenCount} broken.`,
  );
}

main().catch((error) => {
  console.error(`Markdown link check failed: ${error.message}`);
  process.exitCode = 1;
});
