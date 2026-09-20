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
import { loadEntity, loadOsfTypes } from "../loader.js";
import type { EntityProfile } from "../types.js";
import { composedEntityFields, generateWebContractModules } from "./web-contract.js";

const BASE_AUTHORING = join(import.meta.dir, "../../../config/authoring");

function parseEntityFields(source: string): Record<string, any> {
  return JSON.parse(JSON.parse(source.slice(source.indexOf("JSON.parse(") + "JSON.parse(".length, source.lastIndexOf(") as"))));
}

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
    const parsed = parseEntityFields(source) as Record<string, any[]>;

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

test("two context partials defining one field are refused, naming both", () => {
  const dir = fixture();
  try {
    const loaded = loadEntity(dir, "widget");
    const second: EntityProfile = { ...loaded.profiles[0]!, profile: "billing", fields: [{ key: "careLevel", osfType: "string" }] };
    expect(() => composedEntityFields({ entity: loaded.coreEntity, profiles: [...loaded.profiles, second] }, loadOsfTypes(dir)))
      .toThrow("Widget[billing].careLevel is also defined by Widget[care]; a field belongs to one context partial.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the web type catalogue keeps every identity alias; enumerability is the alias's own optionSource", () => {
  const modules = generateWebContractModules(BASE_AUTHORING, []);
  const source = modules.get("osf-types-entity-ids.ts")!;
  const aliases = JSON.parse(source.slice(source.indexOf("= ") + 2, source.lastIndexOf(" as const"))) as Record<string, any>;
  // Listable: the picker can enumerate the records through the list Operation.
  expect(aliases.relationId).toMatchObject({ kind: "entityId", entity: "Relation", options: { type: "entity", source: "Relation" } });
  // Not listable, still a type a field may name: present, without an option source.
  expect(aliases.caseStepActionId).toMatchObject({ kind: "entityId", entity: "CaseStepAction", render: { input: "EntityReferenceSelect" } });
  expect(aliases.caseStepActionId.optionSource).toBeUndefined();
  expect(aliases.caseStepActionId.options).toBeUndefined();
});
