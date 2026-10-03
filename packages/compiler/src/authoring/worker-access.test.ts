// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { authoringValidator } from "./schema-validation.js";

test("authored named worker access survives lowering without widening unrelated entities", () => {
  const directory = mkdtempSync(join(tmpdir(), "osf-authored-worker-"));
  try {
    cpSync(join(import.meta.dir, "__fixtures__/rowaccess"), directory, { recursive: true });
    const path = join(directory, "entities/secure-input-v2.yaml");
    const original = readFileSync(path, "utf8");
    const document = Bun.YAML.parse(original) as Record<string, unknown>;
    document.workerAccess = "example-completion-worker";
    expect(() => authoringValidator().validate(document, path)).not.toThrow();
    for (const invalid of ["", " ", true, "../worker"]) {
      expect(() => authoringValidator().validate({ ...document, workerAccess: invalid }, path)).toThrow();
    }
    writeFileSync(path, `${original}\nworkerAccess: example-completion-worker\n`);
    const manifest = compileAuthoringBackendManifest(directory, {
      mode: "promote", entityAllowlist: ["secure-input-v2", "rowaccess-owner-target"],
      generatedCrudAllowlist: ["secure-input-v2"], schemaByModule: { core: "erp" },
    });
    const worker = manifest.tables.find(table => table.name === "secure_input_v2s");
    expect(worker).toBeDefined();
    expect(worker?.tenantScoped).toBe(true);
    expect(worker?.workerAccess).toBe("example-completion-worker");
    expect(manifest.tables.find(table => table.name === "row_access_owner_targets")?.workerAccess).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
