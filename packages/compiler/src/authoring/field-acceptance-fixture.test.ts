// SPDX-License-Identifier: BUSL-1.1
/**
 * The 48-field acceptance fixture.
 *
 * `__fixtures__/field-acceptance` holds one synthetic entity whose authored
 * top-level fields are exactly the 48 numbered entries of the field catalogue —
 * one entity carrying every value contract OSF can express, so the compiled
 * contract and the typed-variable rules can be checked against all of them at
 * once.
 *
 * It is compiled against a throwaway COPY of the real authoring tree, not a
 * fixture-local catalogue. That is the point: the semantic types the fixture
 * uses are the ones in `config/authoring/catalogs/osf-types.yaml`, and the
 * entities it references (Relation, Document, DocumentVersion,
 * DocumentRendition, Address, NaturalPerson, ContactMoment) are the real ones,
 * with real foreign keys. The fixture itself belongs to no layer, so it reaches
 * no generated artifact, no migration and no deployed schema.
 */
import { describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  fieldVariableSlot,
  variableCompatibility,
  type VariableSlot,
  type VariableUsage,
  type VariableValueShape,
} from "@openshapeforge/operations";
import { writableEntityFields } from "../entity-operation-json-schema.js";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import { authoringValidator } from "./schema-validation.js";
import type { CompiledEntityContract, CompiledField } from "./types/compiled.js";

const AUTHORING_DIR = join(import.meta.dir, "../../config/authoring");
const FIXTURE_DIR = join(import.meta.dir, "__fixtures__", "field-acceptance");
const SLUG = "field-acceptance";
const FIXTURE_PATH = join(FIXTURE_DIR, "entities", `${SLUG}.yaml`);

/** The authored field keys, read straight from the fixture YAML. */
const AUTHORED_KEYS: readonly string[] = (
  parse(readFileSync(FIXTURE_PATH, "utf8")) as { fields: { key: string }[] }
).fields.map((entry) => entry.key);

/**
 * The numbered field catalogue, as authored. The numbers are the catalogue's,
 * the keys are the fixture's; the correspondence is asserted in both directions
 * so neither side can drift without a failure.
 */
const CATALOGUE: Readonly<Record<number, string>> = Object.freeze({
  1: "title", 2: "summary", 3: "body", 4: "contactEmail", 5: "contactPhone",
  6: "website", 7: "reference", 8: "protectedNote",
  9: "quantity", 10: "amount", 11: "completion", 12: "netWeight",
  13: "processingTime", 14: "budgetRange",
  15: "isActive", 16: "isApproved", 17: "category", 18: "tags", 19: "status",
  20: "score",
  21: "startDate", 22: "openingTime", 23: "submittedAt", 24: "effectivePeriod",
  25: "reportingPeriod", 26: "reviewSchedule",
  27: "relatedRelation", 28: "relationContactMoments", 29: "parentAcceptance",
  30: "attachment", 31: "relationDocuments", 32: "previewRendition",
  33: "postalAddress", 34: "contactPerson", 35: "payoutIban",
  36: "commercialTotal", 37: "lineGroups", 38: "attachmentVersions",
  39: "settings", 40: "localizedTitle", 41: "labels", 42: "eligibility",
  43: "approvedAt", 44: "valueContract", 45: "location", 46: "accentColor",
  47: "signedVersion", 48: "displayTimeZone",
});

/**
 * The meta-field set `_base.yaml` merges into every core entity, and the
 * inverse collection the compiler derives from field 29's self-reference.
 * Neither is authored on the fixture, so neither is a catalogue entry — the
 * assertions below require them to be present AND to be excluded, which is
 * what keeps "48" a statement about the authored contract.
 */
const BASE_FIELDS = Object.freeze([
  "id", "createdAt", "updatedAt", "externalId", "sourceAuthority",
  "sourceOrganization", "sourceAdministration", "sourceVersion",
]);
const DERIVED_FIELDS = Object.freeze(["children"]);

function compileFixture() {
  const directory = mkdtempSync(join(tmpdir(), "osf-field-acceptance-"));
  try {
    cpSync(AUTHORING_DIR, directory, { recursive: true });
    cpSync(join(FIXTURE_DIR, "entities"), join(directory, "entities"), { recursive: true });
    const allowlist = [
      SLUG,
      ...readdirSync(join(directory, "entities/core"))
        .filter((name) => name.endsWith(".yaml"))
        .map((name) => name.slice(0, -".yaml".length)),
    ];
    let contract: CompiledEntityContract | undefined;
    const manifest = compileAuthoringBackendManifest(directory, {
      mode: "promote",
      entityAllowlist: allowlist,
      generatedCrudAllowlist: allowlist,
      schemaByModule: { core: "erp" },
      onCandidate: (candidate) => {
        if (candidate.slug === SLUG) contract = candidate.contract as CompiledEntityContract;
      },
    });
    const table = manifest.tables.find((candidate) => candidate.source?.authoringEntitySlug === SLUG)!;
    return { contract: contract!, table };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Compiled twice, deliberately: the second compile is the determinism evidence
// and every other assertion reads the first.
const first = compileFixture();
const second = compileFixture();

const fields = new Map(first.contract.model.fields.map((field) => [field.key, field]));
const columns = new Map(first.table.columns.map((column) => [column.name, column]));
const field = (key: string): CompiledField => {
  const found = fields.get(key);
  if (!found) throw new Error(`The fixture authors no field "${key}".`);
  return found;
};

/** The variable slot of one authored field, from its compiled contract alone. */
function slotOf(key: string): VariableSlot {
  const compiled = field(key);
  const choices = compiled.options?.type === "static"
    ? compiled.options.items?.map((item) => item.value)
    : undefined;
  return fieldVariableSlot(
    {
      key: compiled.key,
      osfType: compiled.osfType,
      baseType: compiled.baseType,
      cardinality: compiled.cardinality,
      required: compiled.required,
      ...(compiled.validation ? { validation: compiled.validation } : {}),
      ...(compiled.relationship?.target ? { relationship: { target: compiled.relationship.target } } : {}),
      ...(compiled.variables ? { variables: compiled.variables } : {}),
    } as Parameters<typeof fieldVariableSlot>[0],
    choices && choices.length > 0 ? { enum: choices } : {},
  );
}

const offer = (shape: Partial<VariableValueShape> & Pick<VariableValueShape, "osfType" | "baseType">): VariableValueShape =>
  ({ cardinality: "single", ...shape });

function refusal(key: string, source: VariableValueShape, usage: VariableUsage = "whole"): string | undefined {
  const result = variableCompatibility(slotOf(key), source, usage);
  return result.compatible ? undefined : result.code;
}

describe("the 48-field acceptance fixture", () => {
  it("is valid authoring, which no repository gate reaches under __fixtures__", () => {
    expect(authoringValidator().validateFile(FIXTURE_PATH, "field acceptance fixture").schema)
      .toBe("core-entity.schema.json");
  });

  it("compiles deterministically", () => {
    expect(second.contract).toEqual(first.contract);
    expect(second.table).toEqual(first.table);
  });

  it("authors exactly 48 top-level fields, one per numbered catalogue entry", () => {
    // Read from the YAML, because "authored" is a fact about the authoring and
    // not about what the compiler adds to it.
    expect(AUTHORED_KEYS).toHaveLength(48);
    expect(new Set(AUTHORED_KEYS).size).toBe(48);

    const numbers = Object.keys(CATALOGUE).map(Number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 48 }, (_, index) => index + 1));
    // Both directions: every catalogue number names an authored field, and no
    // authored field is missing from the catalogue.
    expect(new Set(Object.values(CATALOGUE))).toEqual(new Set(AUTHORED_KEYS));
  });

  it("carries the base meta-fields and the derived collection without counting them", () => {
    const compiled = first.contract.model.fields.map((entry) => entry.key);
    expect(new Set(compiled)).toEqual(new Set([...BASE_FIELDS, ...AUTHORED_KEYS, ...DERIVED_FIELDS]));
    for (const key of [...BASE_FIELDS, ...DERIVED_FIELDS]) {
      expect(fields.has(key)).toBe(true);
      expect(Object.values(CATALOGUE)).not.toContain(key);
    }
  });

  it("keeps the one type axis on every field: osfType, base type and cardinality", () => {
    expect(field("title")).toMatchObject({ osfType: "string", baseType: "string", cardinality: "single" });
    expect(field("amount")).toMatchObject({ osfType: "currency", baseType: "number", cardinality: "single" });
    expect(field("completion")).toMatchObject({ osfType: "percentage", baseType: "number" });
    expect(field("processingTime")).toMatchObject({ osfType: "durationSeconds", baseType: "integer" });
    expect(field("score")).toMatchObject({ osfType: "rating", baseType: "integer" });
    expect(field("openingTime")).toMatchObject({ osfType: "localTime", baseType: "string" });
    expect(field("reportingPeriod")).toMatchObject({ osfType: "calendarPeriod", baseType: "string" });
    expect(field("displayTimeZone")).toMatchObject({ osfType: "timeZone", baseType: "string" });
    expect(field("tags")).toMatchObject({ osfType: "string", cardinality: "collection" });
    expect(field("isApproved")).toMatchObject({ baseType: "boolean", required: false });
    expect(field("isActive")).toMatchObject({ baseType: "boolean", required: true, defaultValue: false });
  });

  it("gives every typed object its children from the catalogue, not from the field", () => {
    const children = (key: string) => (field(key).children ?? []).map((child) => `${child.key}:${child.baseType}`);
    expect(children("netWeight")).toEqual(["value:number", "unit:string"]);
    expect(children("budgetRange")).toEqual(["from:number", "to:number"]);
    expect(children("effectivePeriod")).toEqual(["from:date", "to:date"]);
    expect(children("location")).toEqual(["latitude:number", "longitude:number"]);
    expect(children("reviewSchedule"))
      .toEqual(["frequency:string", "interval:integer", "dayOfMonth:integer", "occurrences:integer"]);
    // 36 and 37 are authored compositions, so their children come from the field.
    expect(children("commercialTotal")).toEqual(["net:number", "vatRate:number", "gross:number"]);
    expect(children("lineGroups"))
      .toEqual(["lineId:string", "description:string", "quantity:integer", "lineTotal:number"]);
    // 39 is a keyed map: unique keys by construction and bounded text values.
    expect(field("settings").children).toBeUndefined();
    expect(field("settings").osfType).toBe("keyValueMap");
    expect(field("lineGroups").validation?.uniqueBy).toBe("lineId");
  });

  it("keeps the real bounds of a bounded type", () => {
    expect(field("score").validation).toMatchObject({ min: 1, max: 5 });
    expect(field("processingTime").validation).toMatchObject({ min: 0 });
    const coordinates = field("location").children!;
    expect(coordinates.find((child) => child.key === "latitude")!.validation).toMatchObject({ min: -90, max: 90 });
    expect(coordinates.find((child) => child.key === "longitude")!.validation).toMatchObject({ min: -180, max: 180 });
  });

  it("lands each semantic pattern in the database as a CHECK", () => {
    const checks = new Map(
      (first.table.constraints ?? [])
        .filter((constraint) => constraint.kind === "check")
        .map((constraint) => [constraint.name, constraint.expression]),
    );
    const table = first.table.name;
    expect(checks.get(`${table}_reference_pattern_check`)).toContain("[A-Za-z0-9][A-Za-z0-9._\\-]*");
    expect(checks.get(`${table}_opening_time_pattern_check`)).toContain("2[0-3]");
    expect(checks.get(`${table}_reporting_period_pattern_check`)).toContain("Q[1-4]");
    expect(checks.get(`${table}_display_time_zone_pattern_check`)).toContain("UTC");
    // Every pattern that reached a CHECK is anchored, so it constrains the
    // whole value rather than matching somewhere inside it.
    for (const [name, expression] of checks) {
      if (!name.endsWith("_pattern_check")) continue;
      expect(expression).toContain("'^");
      expect(expression).toContain("$'");
    }
  });

  it("stores each value where its base type belongs, and stores nothing computed", () => {
    expect(columns.get("amount")?.type).toBe("numeric");
    expect(columns.get("completion")?.type).toBe("numeric");
    expect(columns.get("processing_time")?.type).toBe("integer");
    expect(columns.get("net_weight")?.type).toBe("jsonb");
    expect(columns.get("location")?.type).toBe("jsonb");
    expect(columns.get("value_contract")?.type).toBe("jsonb");
    expect(columns.get("relation_id")?.type).toBe("uuid");
    // 41 is resolved per request from label_rules; it has no column at all.
    expect([...columns.keys()].some((name) => name.startsWith("label"))).toBe(false);
    // A traversal collection is a read, not storage: no column of this table
    // is backed by one.
    const backing = new Set((first.table.columns ?? []).map((column) => column.sourceField));
    for (const key of ["relationContactMoments", "relationDocuments", "attachmentVersions", "labels"]) {
      expect(backing.has(key)).toBe(false);
    }
  });

  it("references the real entities, with the target on the compiled relationship", () => {
    const target = (key: string) => field(key).relationship?.target;
    expect(target("relatedRelation")).toBe("Relation");
    expect(target("attachment")).toBe("Document");
    expect(target("previewRendition")).toBe("DocumentRendition");
    expect(target("postalAddress")).toBe("Address");
    expect(target("contactPerson")).toBe("NaturalPerson");
    expect(target("signedVersion")).toBe("DocumentVersion");
    // 29 is the hierarchy: a self-reference whose `children` side is derived.
    expect(target("parentAcceptance")).toBe("FieldAcceptance");
    expect(first.contract.model.relationships.some((relationship) => relationship.key === "children")).toBe(true);
  });

  it("lets only the approve transition write the status, the stamp and the signed version", () => {
    // The status is written by every rule of its own machine; the stamp and the
    // signed version only by the rule that actually records the approval.
    expect(field("status").writtenBy).toEqual(["FieldAcceptance.approve", "FieldAcceptance.withdraw"]);
    expect(field("approvedAt").writtenBy).toEqual(["FieldAcceptance.approve"]);
    expect(field("signedVersion").writtenBy).toEqual(["FieldAcceptance.approve"]);
    for (const operation of ["create", "update"] as const) {
      const writable = writableEntityFields(first.contract.model.fields, operation).map((entry) => entry.key);
      expect(writable).not.toContain("status");
      expect(writable).not.toContain("approvedAt");
      expect(writable).not.toContain("signedVersion");
      // An ordinary authored field is still writable, so the exclusion above is
      // the field contract and not a filter that drops everything.
      expect(writable).toContain("title");
    }
    const machine = first.contract.transitions!.find((entry) => entry.field === "status")!;
    expect(machine.initial).toBe("draft");
    expect(machine.rules.map((rule) => [rule.key, rule.operation, rule.to]))
      .toEqual([["approve", "FieldAcceptance.approve", "approved"], ["withdraw", "FieldAcceptance.withdraw", "withdrawn"]]);
    const approve = machine.rules[0]!;
    expect(approve.writes).toEqual([{ field: "signedVersion", required: true }]);
    expect(approve.stamps).toEqual([{ field: "approvedAt", value: "now" }]);
    // The approval has a condition of its own, so it is a real state change
    // rather than a flag someone sets.
    expect(approve.preconditions).toEqual([
      expect.objectContaining({ field: "reference", present: true }),
    ]);
  });

  it("carries the authored variable mode, and no mode where none is authored", () => {
    expect(field("title").variables).toBe("both");
    expect(field("body").variables).toBe("template");
    expect(field("amount").variables).toBe("whole");
    expect(field("netWeight").variables).toBeUndefined();
    expect(field("status").variables).toBeUndefined();
    expect(field("localizedTitle").variables).toBeUndefined();
  });

  it("admits only an exactly compatible variable as a whole value", () => {
    // Money is not an arbitrary number, in either direction of refinement.
    expect(refusal("amount", offer({ osfType: "number", baseType: "number" }))).toBe("INCOMPATIBLE_TYPE");
    expect(refusal("amount", offer({ osfType: "currency", baseType: "number" }))).toBeUndefined();
    expect(refusal("completion", offer({ osfType: "number", baseType: "number" }))).toBe("INCOMPATIBLE_TYPE");
    expect(refusal("completion", offer({ osfType: "percentage", baseType: "number" }))).toBeUndefined();
    // A percentage is not a currency either, though both are numbers.
    expect(refusal("amount", offer({ osfType: "percentage", baseType: "number" }))).toBe("INCOMPATIBLE_TYPE");
    // An unrefined base type keeps its exact base type and nothing more.
    expect(refusal("title", offer({ osfType: "multilineText", baseType: "string" }))).toBeUndefined();
    expect(refusal("title", offer({ osfType: "integer", baseType: "integer" }))).toBe("INCOMPATIBLE_TYPE");
    // A date never silently becomes a datetime.
    expect(refusal("submittedAt", offer({ osfType: "date", baseType: "date" }))).toBe("INCOMPATIBLE_TYPE");
    expect(refusal("startDate", offer({ osfType: "datetime", baseType: "datetime" }))).toBe("INCOMPATIBLE_TYPE");
    // A semantic string type is not plain text.
    expect(refusal("displayTimeZone", offer({ osfType: "string", baseType: "string" }))).toBe("INCOMPATIBLE_TYPE");
    expect(refusal("openingTime", offer({ osfType: "localTime", baseType: "string" }))).toBeUndefined();
  });

  it("refuses a reference that is merely a uuid, or a reference to another entity", () => {
    expect(refusal("relatedRelation", offer({ osfType: "string", baseType: "string" })))
      .toBe("INCOMPATIBLE_REFERENCE");
    expect(refusal("relatedRelation", offer({ osfType: "Address", baseType: "string", target: "Address" })))
      .toBe("INCOMPATIBLE_REFERENCE");
    expect(refusal("relatedRelation", offer({ osfType: "Relation", baseType: "string", target: "Relation" })))
      .toBeUndefined();
    expect(refusal("title", offer({ osfType: "Relation", baseType: "string", target: "Relation" })))
      .toBe("INCOMPATIBLE_REFERENCE");
  });

  it("keeps scalars and collections apart", () => {
    expect(refusal("tags", offer({ osfType: "string", baseType: "string" })))
      .toBe("INCOMPATIBLE_CARDINALITY");
    expect(refusal("tags", offer({ osfType: "string", baseType: "string", cardinality: "collection", enum: ["urgent"] })))
      .toBeUndefined();
    expect(refusal("title", offer({ osfType: "string", baseType: "string", cardinality: "collection" })))
      .toBe("INCOMPATIBLE_CARDINALITY");
  });

  it("holds a narrowed option domain against a variable that does not declare one", () => {
    expect(refusal("category", offer({ osfType: "string", baseType: "string" })))
      .toBe("INCOMPATIBLE_DOMAIN");
    expect(refusal("category", offer({ osfType: "string", baseType: "string", enum: ["housing", "finance"] })))
      .toBeUndefined();
    expect(refusal("category", offer({ osfType: "string", baseType: "string", enum: ["housing", "elsewhere"] })))
      .toBe("INCOMPATIBLE_DOMAIN");
  });

  it("permits each shape only where the field authored it", () => {
    // `template` only, so the whole value cannot be one binding.
    expect(refusal("body", offer({ osfType: "markdown", baseType: "string" }), "whole"))
      .toBe("VARIABLES_NOT_PERMITTED");
    expect(refusal("body", offer({ osfType: "string", baseType: "string" }), "template")).toBeUndefined();
    // `whole` only, so its text holds no template.
    expect(refusal("amount", offer({ osfType: "string", baseType: "string" }), "template"))
      .toBe("VARIABLES_NOT_PERMITTED");
    // `both` permits either.
    expect(refusal("title", offer({ osfType: "string", baseType: "string" }), "template")).toBeUndefined();
    expect(refusal("title", offer({ osfType: "string", baseType: "string" }), "whole")).toBeUndefined();
    // No mode authored: a `{{…}}` sequence here is literal text, not a binding.
    for (const usage of ["whole", "template"] as const) {
      expect(refusal("netWeight", offer({ osfType: "measurement", baseType: "object" }), usage))
        .toBe("VARIABLES_NOT_PERMITTED");
      expect(refusal("localizedTitle", offer({ osfType: "string", baseType: "string" }), usage))
        .toBe("VARIABLES_NOT_PERMITTED");
    }
  });

  it("writes only a formattable scalar into text", () => {
    expect(refusal("title", offer({ osfType: "coordinates", baseType: "object" }), "template"))
      .toBe("UNFORMATTABLE_VALUE");
    expect(refusal("title", offer({ osfType: "currency", baseType: "number" }), "template")).toBeUndefined();
    expect(refusal("body", offer({ osfType: "Relation", baseType: "string", target: "Relation" }), "template"))
      .toBe("INCOMPATIBLE_REFERENCE");
    expect(refusal("body", offer({ osfType: "string", baseType: "string", cardinality: "collection" }), "template"))
      .toBe("INCOMPATIBLE_CARDINALITY");
  });

  it("keeps the protected field's own roles and its display metadata", () => {
    expect(field("protectedNote")).toMatchObject({
      classification: { sensitivity: "confidential" },
      authorization: { roles: { read: ["Relations.All.ReadWrite"], write: ["Relations.All.ReadWrite"] } },
      audit: true,
    });
    // Display decimals and scale reach the field from the catalogue type — a
    // schema-3 field may not author `render` at all. They are presentation, so
    // the stored column stays exact numeric.
    expect(field("amount").render).toMatchObject({
      component: "MoneyInput",
      props: { currency: "EUR", decimalPlaces: 2, scale: "units" },
    });
    expect(field("completion").render).toMatchObject({
      component: "NumberInput",
      props: { unit: "%", decimalPlaces: 2 },
    });
    expect(columns.get("amount")?.type).toBe("numeric");
  });
});
