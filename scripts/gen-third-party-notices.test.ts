// SPDX-License-Identifier: BUSL-1.1
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { collectPackages } from "./gen-third-party-notices";

function writePackage(
  storeRoot: string,
  key: string,
  metadata: Record<string, string>,
  licenseText: string,
): void {
  const dir = join(storeRoot, key, "node_modules", "duplicate-package");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(metadata));
  writeFileSync(join(dir, "LICENSE"), licenseText);
}

test("collectPackages uses a stable path tie-break for duplicate package records", () => {
  const root = mkdtempSync(join(tmpdir(), "osf-notices-"));
  try {
    // Write z first so a directory's insertion order cannot decide the winner.
    writePackage(
      root,
      "z-record",
      { name: "duplicate-package", version: "1.0.0", license: "Apache-2.0" },
      "Apache license text",
    );
    writePackage(
      root,
      "a-record",
      { name: "duplicate-package", version: "1.0.0", license: "MIT" },
      "MIT license text",
    );

    expect(collectPackages(root)).toEqual([
      expect.objectContaining({
        name: "duplicate-package",
        version: "1.0.0",
        license: "MIT",
        licenseText: "MIT license text",
      }),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
