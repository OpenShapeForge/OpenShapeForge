// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared file-discovery and header helpers for the SPDX license-header tooling.
 *
 * A single source of truth so the inserter (`scripts/add-license-headers.mjs`)
 * and the checker (`scripts/check-license-headers.mjs`) agree on exactly which
 * first-party source files must carry an `SPDX-License-Identifier` tag.
 *
 * Scope: first-party TypeScript/JavaScript source under apps/, packages/,
 * scripts/, and examples/, plus the Java Keycloak SPI under packages/. All use
 * `//` line-comment syntax. Compiler-generated artifacts are gitignored and
 * therefore never enumerated here; EJS templates (`*.ejs`) are excluded so the
 * header is not emitted into generated output. See issue #52 (BUSL-1.1
 * conspicuous-display requirement).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const SPDX_TAG = "SPDX-License-Identifier: BUSL-1.1";

/** Line inserted at the top of every first-party source file. */
export const SPDX_LINE = `// ${SPDX_TAG}`;

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SOURCE_ROOTS = ["apps", "packages", "scripts", "examples"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".java"]);

/**
 * Directives that TypeScript/Babel require to stay in the very first comment of
 * a file (`#!` shebang for executables, `// @ts-nocheck` for the type checker).
 * The SPDX line is inserted immediately AFTER any such leading directive lines
 * so their semantics are preserved.
 */
function leadingDirectiveLineCount(lines) {
  let count = 0;
  if (lines[0]?.startsWith("#!")) count += 1;
  // A `@ts-nocheck` / `@ts-check` directive must remain in the first comment.
  const next = lines[count]?.trim();
  if (next === "// @ts-nocheck" || next === "// @ts-check") count += 1;
  return count;
}

/**
 * Returns the repo-relative paths of first-party source files, sorted, using
 * `git ls-files` so gitignored generated artifacts are excluded by construction.
 */
export function listFirstPartySourceFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--", ...SOURCE_ROOTS.map((root) => `${root}/`)],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output
    .split("\n")
    .filter(Boolean)
    .filter((rel) => {
      if (rel.endsWith(".ejs")) return false;
      return SOURCE_EXTENSIONS.has(path.extname(rel));
    })
    .sort();
}

/** True when the file content already carries the SPDX tag near the top. */
export function hasSpdxTag(content) {
  // Only inspect the leading portion so a match deep in the file (e.g. a string
  // literal) does not count as a header.
  const head = content.split("\n", 12).join("\n");
  return head.includes(SPDX_TAG);
}

/**
 * Returns the file content with the SPDX line inserted after any leading
 * shebang / ts-directive lines. No-op if the tag is already present.
 */
export function withSpdxHeader(content) {
  if (hasSpdxTag(content)) return content;
  const lines = content.split("\n");
  const at = leadingDirectiveLineCount(lines);
  lines.splice(at, 0, SPDX_LINE);
  return lines.join("\n");
}
