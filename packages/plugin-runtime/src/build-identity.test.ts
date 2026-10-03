// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIdentity, readBuildIdentity } from "./build-identity.js";

const roots: string[] = [];
function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "osf-build-identity-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("deployment build identity", () => {
  test("keeps software release and build distinct in an immutable version", () => {
    const identity = buildIdentity("0.2.0-rc.1", "a".repeat(40));
    expect(identity).toEqual({ release: "0.2.0-rc.1", build: "a".repeat(40), version: `0.2.0-rc.1+${"a".repeat(40)}` });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(() => buildIdentity("1.0.0\r\nx-header: value", "valid")).toThrow("Invalid software release version.");
    for (const build of ["", "\ninvalid", "invalid/path", "a".repeat(129)]) {
      expect(() => buildIdentity("1.0.0", build)).toThrow("Invalid software build identity.");
    }
  });

  test("uses explicit deployment environment before the package release fallback", () => {
    expect(readBuildIdentity({ OPENSHAPEFORGE_BUILD_RELEASE: "2.3.4", OPENSHAPEFORGE_BUILD_REVISION: "deployed-123" }, "0.1.0"))
      .toEqual({ release: "2.3.4", build: "deployed-123", version: "2.3.4+deployed-123" });
    expect(readBuildIdentity({}, "0.1.0").version).toBe("0.1.0+unknown");
    expect(readBuildIdentity({}).version).toBe("0.0.0+unknown");
  });

  test("prefers the artifact stamp and fails closed on missing, malformed or inconsistent stamps", () => {
    const file = join(temporaryRoot(), "identity.json");
    const env = { OPENSHAPEFORGE_BUILD_IDENTITY_FILE: file, OPENSHAPEFORGE_BUILD_RELEASE: "9.0.0", OPENSHAPEFORGE_BUILD_REVISION: "ignored" };
    expect(() => readBuildIdentity(env, "0.1.0")).toThrow();
    const stamped = buildIdentity("1.2.3", "committed-123");
    writeFileSync(file, JSON.stringify(stamped));
    expect(readBuildIdentity(env, "0.1.0")).toEqual(stamped);
    for (const malformed of [
      { release: "1.0.0", build: 123, version: "1.0.0+123" },
      { release: ["1.0.0"], build: "abc", version: "1.0.0+abc" },
      { release: "1.0.0", build: ["abc"], version: "1.0.0+abc" },
    ]) {
      writeFileSync(file, JSON.stringify(malformed));
      expect(() => readBuildIdentity(env, "0.1.0")).toThrow(/Invalid software/);
    }
    writeFileSync(file, JSON.stringify({ ...stamped, version: "9.0.0+ignored" }));
    expect(() => readBuildIdentity(env, "0.1.0")).toThrow("Inconsistent software build identity.");
    writeFileSync(file, "not json");
    expect(() => readBuildIdentity(env, "0.1.0")).toThrow();
  });

  test("the package root stays browser-safe without loading the server-side helper", async () => {
    const entry = join(temporaryRoot(), "browser.ts");
    const rootEntry = Bun.resolveSync("@openshapeforge/plugin-runtime", import.meta.dir);
    writeFileSync(entry, `import * as runtime from ${JSON.stringify(rootEntry)}; console.log(Object.keys(runtime));`);
    const bundled = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
    expect(bundled.success).toBe(true);
    const source = await bundled.outputs[0]!.text();
    expect(source).not.toContain("readBuildIdentity");
    expect(source).not.toContain("node:fs");
  });
});
