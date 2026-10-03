// SPDX-License-Identifier: BUSL-1.1
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { compileAuthoringBackendManifest } from "../backend-manifest.js";

/** Compile a real authored partial-index entity without changing the shipped corpus. */
export function compilePartialDerivedIdentifierFixture() {
  const fixture = join(import.meta.dir, "../__fixtures__/rowaccess");
  const directory = mkdtempSync(join(tmpdir(), "osf-derived-identifier-"));
  try {
    cpSync(join(fixture, "catalogs"), join(directory, "catalogs"), { recursive: true });
    mkdirSync(join(directory, "entities"));
    cpSync(join(fixture, "entities/_base.yaml"), join(directory, "entities/_base.yaml"));
    const entity = parse(readFileSync(join(fixture, "entities/immutable-field.yaml"), "utf8"));
    entity.entity = "DerivedIdentifierFixture";
    entity.title = "Derived identifier fixture";
    entity.displayTemplate = "{{name}}";
    entity.filterField = "name";
    entity.fields = [
      { key: "key", osfType: "string", required: true, label: { en: "Key" },
        deriveOnCreate: { from: "name", transform: "slug", onConflict: "suffix" },
        persisted: { column: "key", storageClass: "core" } },
      { key: "name", osfType: "string", required: true, label: { en: "Name" },
        persisted: { column: "name", storageClass: "core" } },
      { key: "active", osfType: "boolean", required: true, label: { en: "Active" },
        persisted: { column: "active", storageClass: "core" } },
    ];
    entity.indexes = [{ name: "active_identifier_keys", fields: ["key"], unique: true,
      where: { field: "active", equals: true } }];
    writeFileSync(join(directory, "entities/derived-identifier-fixture.yaml"), stringify(entity));
    return compileAuthoringBackendManifest(directory, {
      mode: "promote",
      entityAllowlist: ["derived-identifier-fixture"],
      generatedCrudAllowlist: ["derived-identifier-fixture"],
      schemaByModule: { core: "erp" },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
