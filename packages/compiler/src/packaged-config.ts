// SPDX-License-Identifier: BUSL-1.1
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Root of the installed @openshapeforge/compiler package; src/ sits directly under it. */
const packageRoot = resolve(import.meta.dir, "..");

const IN_REPO_PREFIX = "packages/compiler/";

/**
 * The packaged copy of a `packages/compiler/...` file, or null when the path
 * is not compiler config or the package ships no such file.
 */
export function packagedConfigFallback(repoRelativePath: string): string | null {
  if (!repoRelativePath.startsWith(IN_REPO_PREFIX)) {
    return null;
  }
  const packagedPath = join(packageRoot, repoRelativePath.slice(IN_REPO_PREFIX.length));
  return existsSync(packagedPath) ? packagedPath : null;
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
