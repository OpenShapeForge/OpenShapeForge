// SPDX-License-Identifier: BUSL-1.1
/**
 * The renderer's entity-field contract carries the entity a host sees: its
 * own fields and the fields its context partials add, each with a base
 * type, nested shapes intact, the tenant fence left out.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEntity } from "../loader.js";
import { generateWebContractModules } from "./web-contract.js";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-contract-"));
  const write = (path: string, value: unknown) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify(value));
  };
  write("catalogs/components.yaml", { defaults: { string: { label: { en: "Text", nl: "Tekst" }, component: "Input" } }, components: {} });
  write("catalogs/transforms.yaml", { transforms: {} });
  write("catalogs/osf-types.yaml", { types: {
    shortText: { kind: "scalar", baseType: "string", validation: { maxLength: 80 }, label: { en: "Text" } },
    tenantId: { kind: "scalar", baseType: "string", label: { en: "Tenant" } },
  } });
  write("entities/widget.yaml", {
    schemaVersion: 3, kind: "coreEntity", module: "core", entity: "Widget", title: "Widget", labels: { en: "Widget", nl: "Widget" },
    language: "en", domains: ["example"], baseEntity: false,
    authorization: { roles: { read: ["Example.Read"], create: ["Example.Create"], update: ["Example.Update"] } },
    fields: [
      { key: "id", osfType: "string", required: true, validation: { format: "uuid" }, persisted: { column: "id", storageClass: "core" } },
      { key: "tenantId", osfType: "tenantId", required: true, persisted: { column: "tenant_id", storageClass: "core" } },
      { key: "name", osfType: "shortText", required: true, label: { en: "Name", nl: "Naam" }, persisted: { column: "name", storageClass: "core" } },
      { key: "dimensions", osfType: "object", persisted: { column: "dimensions", storageClass: "core" }, children: [
        { key: "width", osfType: "integer", label: { en: "Width" } },
      ] },
    ],
    operations: Object.fromEntries(["list", "get"].map((action) => [action, {
      name: action, description: action, implementation: { type: "entity", action },
      effects: { data: "read", external: "none" }, reliability: { idempotency: { mode: "natural" } }, confirmation: { mode: "none" },
    }])),
    interfaces: { rest: {}, graphql: {}, mcp: { tools: "generic" } },
  });
  write("contexts/care/partial/widget.yaml", {
    schemaVersion: 3, kind: "entityProfile", entity: "Widget", extends: "Widget", profile: "care", language: "en",
    fields: [
      { key: "careLevel", osfType: "shortText", label: { en: "Care level", nl: "Zorgniveau" } },
      // The core field of the same key wins; a partial cannot redefine it.
      { key: "name", osfType: "string" },
    ],
  });
  return dir;
}

test("entity fields carry the context partials' fields with derived base types", () => {
  const dir = fixture();
  try {
    const loaded = loadEntity(dir, "widget");
    expect(loaded.profiles).toHaveLength(1);
    const modules = generateWebContractModules(dir, [{ entity: loaded.coreEntity, profiles: loaded.profiles }]);
    const source = modules.get("entity-fields.ts")!;
    const parsed = JSON.parse(JSON.parse(source.slice(source.indexOf("JSON.parse(") + "JSON.parse(".length, source.lastIndexOf(") as")))) as Record<string, any[]>;

    const keys = parsed.Widget!.map((field) => field.key);
    expect(keys).toEqual(["id", "name", "dimensions", "careLevel"]);
    expect(parsed.Widget!.find((field) => field.key === "careLevel")).toMatchObject({ osfType: "shortText", baseType: "string", label: { nl: "Zorgniveau" } });
    expect(parsed.Widget!.find((field) => field.key === "name")).toMatchObject({ osfType: "shortText", validation: { maxLength: 80 } });
    expect(parsed.Widget!.find((field) => field.key === "dimensions")?.children).toEqual([
      { key: "width", osfType: "integer", baseType: "integer", label: { en: "Width" } },
    ]);
    // Picker fields carry no storage or policy.
    expect(JSON.stringify(parsed)).not.toContain("persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
