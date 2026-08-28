// SPDX-License-Identifier: BUSL-1.1
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Root of the installed @openshapeforge/compiler package; src/ sits directly under it. */
const packageRoot = resolve(import.meta.dir, "..");

const IN_REPO_PREFIX = "packages/compiler/";

const announcedFallbacks = new Set<string>();

/**
 * The packaged copy of a `packages/compiler/...` file, or null when the path
 * is not compiler config or the package ships no such file. Using the packaged
 * copy is announced once per path: a host that MEANT to override but misplaced
 * its copy would otherwise silently compile against the upstream default and
 * find out at migrate time (the same reasoning that makes
 * authoring.config.local.yaml loud in layers.ts).
 */
export function packagedConfigFallback(repoRelativePath: string): string | null {
  if (!repoRelativePath.startsWith(IN_REPO_PREFIX)) {
    return null;
  }
  const packagedPath = join(packageRoot, repoRelativePath.slice(IN_REPO_PREFIX.length));
  if (!existsSync(packagedPath)) {
    return null;
  }
  if (!announcedFallbacks.has(repoRelativePath)) {
    announcedFallbacks.add(repoRelativePath);
    console.info(
      `[compiler] ${repoRelativePath} is not present in this repo; using the copy packaged with @openshapeforge/compiler.`,
    );
  }
  return packagedPath;
}

/**
 * The repo-canonical spelling of an absolute path: a path inside the installed
 * compiler package maps back to its `packages/compiler/...` name, so emitted
 * provenance (e.g. manifest `source.path`) never encodes the host's install
 * layout — node_modules paths, versioned isolated-linker paths, or a linked
 * checkout's machine-specific location.
 */
export function canonicalRepoRelativePath(repoRoot: string, absolutePath: string): string {
  const withinPackage = relative(packageRoot, absolutePath);
  if (withinPackage && !withinPackage.startsWith("..") && !isAbsolute(withinPackage)) {
    return join("packages/compiler", withinPackage);
  }
  return relative(repoRoot, absolutePath);
}

/**
 * Resolve a `packages/compiler/...` config path against a host repo.
 *
 * In this monorepo the file exists at `<repoRoot>/packages/compiler/...` and
 * that copy always wins — which also lets a host repo override a packaged
 * default by providing the file at the same canonical path. A host that ships
 * no copy falls back to the file packaged with the compiler itself, so
 * consuming the compiler does not require mirroring its config tree into the
 * host. When neither exists, the host path is returned so the caller's error
 * names the canonical location.
 */
export function resolvePackagedConfigPath(repoRoot: string, repoRelativePath: string): string {
  const hostPath = resolve(repoRoot, repoRelativePath);
  if (existsSync(hostPath)) {
    return hostPath;
  }
  return packagedConfigFallback(repoRelativePath) ?? hostPath;
}
