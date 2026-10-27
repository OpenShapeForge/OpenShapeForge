// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const script = new URL("./deploy-api-runtime.sh", import.meta.url).pathname;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "api-runtime-"));
  const calls = join(dir, "calls"), upgrade = join(dir, "upgrade");
  writeFileSync(join(dir, "helm"), `#!/bin/sh
printf '%s\\n' "$1" >> "$CALLS"
if [ "$1" = status ]; then
  [ "$STATE" != missing ] || exit 1
  printf '{"info":{"status":"%s"}}\\n' "$STATE"
else
  printf '%s\\n' "$@" > "$UPGRADE"
fi
`, { mode: 0o755 });
  const run = (extra: Record<string, string> = {}, args: string[] = []) => Bun.spawnSync(["bash", script, ...args], { env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, UPGRADE: upgrade,
    STATE: "deployed", RELEASE: "openshapeforge", NAMESPACE: "openshapeforge",
    IMAGE_TAG: "sha-73348ef", API_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`, ...extra,
  }, stdout: "pipe", stderr: "pipe" });
  return { run, calls, upgrade, clean: () => rmSync(dir, { recursive: true, force: true }) };
}
test("runtime upgrade pins the API digest, reuses identity values and keeps migration hooks", () => {
  const f = fixture(); try {
    expect(f.run().exitCode).toBe(0);
    expect(readFileSync(f.calls, "utf8")).toBe("status\nupgrade\n");
    const args = readFileSync(f.upgrade, "utf8").trim().split("\n");
    expect(args).toEqual(["upgrade", "openshapeforge", "./deploy/helm/openshapeforge-api", "--namespace", "openshapeforge", "--reuse-values",
      "--set-string", "image.repository=ghcr.io/openshapeforge/openshapeforge-api", "--set-string", `image.tag=sha-73348ef@sha256:${"a".repeat(64)}`, "--wait", "--timeout", "15m"]);
    expect(args.some(a => /keycloak|auth\.|database\.|--no-hooks|--install|reset-values/.test(a))).toBe(false);
  } finally { f.clean(); }
});
test("validation rejects mutable tags, malformed digests and another release before invoking Helm", () => {
  for (const invalid of [{ IMAGE_TAG: "main" }, { API_IMAGE_DIGEST: "sha256:bad" }, { RELEASE: "other" }, { NAMESPACE: "other" }]) {
    const f = fixture(); try { expect(f.run(invalid).exitCode).not.toBe(0); expect(existsSync(f.calls)).toBe(false); } finally { f.clean(); }
  }
});
test("validation mode does not access the cluster", () => {
  const f = fixture(); try { expect(f.run({}, ["--validate-only"]).exitCode).toBe(0); expect(existsSync(f.calls)).toBe(false); } finally { f.clean(); }
});
test("a missing or unfinished release cannot be installed or upgraded", () => {
  for (const STATE of ["missing", "failed", "pending-upgrade"]) {
    const f = fixture(); try { expect(f.run({ STATE }).exitCode).not.toBe(0); expect(existsSync(f.upgrade)).toBe(false); } finally { f.clean(); }
  }
});
test("release check does not update workloads", () => {
  const f = fixture(); try { expect(f.run({}, ["--check-release"]).exitCode).toBe(0); expect(existsSync(f.upgrade)).toBe(false); } finally { f.clean(); }
});

test("pinned Bun rejects the malformed Brotli regression before deployment", () => {
  const z = require("node:zlib");
  expect(() => z.brotliDecompressSync(Buffer.from("200010414141fcffff07002228f00b60f7f41f000000", "hex"))).toThrow(expect.objectContaining({code: "ERR__ERROR_FORMAT_BLOCK_SWITCH", errno: -17}));
});
