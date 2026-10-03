// SPDX-License-Identifier: BUSL-1.1
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadActivePlatformCompile } from "./active-manifest.js";
import { loadCompilerPluginEntries } from "./plugins.js";

test("a failed plugin lookup can be retried after the missing module is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "osf-plugin-retry-"));
  try {
    await writeFile(join(root, "authoring.config.yaml"), "layers: [authoring]\nplugins: [./plugin.ts]\n");
    const first = loadCompilerPluginEntries(root);
    expect(loadCompilerPluginEntries(root)).toBe(first);
    await expect(first).rejects.toThrow('Plugin module "./plugin.ts" not found');
    await writeFile(join(root, "plugin.ts"), 'export default { name: "recovered" };\n');
    const recovered = await loadCompilerPluginEntries(root);
    expect(recovered.map(({ plugin }) => plugin.name)).toEqual(["recovered"]);
    expect(await loadCompilerPluginEntries(root)).toBe(recovered);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed active compile rebuilds repaired authoring overlays on retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "osf-compile-retry-"));
  try {
    await mkdir(join(root, "overlay/entities"), { recursive: true });
    await writeFile(join(root, "authoring.config.yaml"), "layers: [packages/compiler/config/authoring, overlay]\n");
    const patch = join(root, "overlay/entities/relation.yaml");
    await writeFile(patch, "kind: entityPatch\nfields:\n  - key: name\n    osfType: missingRetryType\n");
    const first = loadActivePlatformCompile(root);
    expect(loadActivePlatformCompile(root)).toBe(first);
    await expect(first).rejects.toThrow("missingRetryType");
    await writeFile(patch, "kind: entityPatch\ntitle: Recovered relation\n");
    const recovered = await loadActivePlatformCompile(root);
    expect(recovered.entities.find(({ contract }) => contract.entity.name === "Relation")?.contract.entity.title)
      .toBe("Recovered relation");
    expect(await loadActivePlatformCompile(root)).toBe(recovered);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
