// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packagedConfigFallback, resolvePackagedConfigPath } from "./packaged-config.js";

const packageRoot = resolve(import.meta.dir, "..");

describe("resolvePackagedConfigPath", () => {
  test("the host repo's copy wins when it exists", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "osf-host-"));
    const hostConfig = join(repoRoot, "packages/compiler/config");
    mkdirSync(hostConfig, { recursive: true });
    writeFileSync(join(hostConfig, "platform-schema.yaml"), "tables: []\n");
    expect(
      resolvePackagedConfigPath(repoRoot, "packages/compiler/config/platform-schema.yaml"),
    ).toBe(join(hostConfig, "platform-schema.yaml"));
  });

  test("a host without the file falls back to the packaged copy", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "osf-host-"));
    expect(
      resolvePackagedConfigPath(repoRoot, "packages/compiler/config/platform-schema.yaml"),
    ).toBe(join(packageRoot, "config/platform-schema.yaml"));
  });

  test("a path outside packages/compiler never falls back", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "osf-host-"));
    expect(resolvePackagedConfigPath(repoRoot, "authoring/base")).toBe(
      resolve(repoRoot, "authoring/base"),
    );
    expect(packagedConfigFallback("authoring/base")).toBeNull();
  });

  test("a compiler path the package does not ship resolves to the host path", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "osf-host-"));
    expect(resolvePackagedConfigPath(repoRoot, "packages/compiler/config/absent.yaml")).toBe(
      resolve(repoRoot, "packages/compiler/config/absent.yaml"),
    );
  });

  test("the packaged base authoring layer is reachable as a fallback", () => {
    expect(packagedConfigFallback("packages/compiler/config/authoring")).toBe(
      join(packageRoot, "config/authoring"),
    );
  });
});
