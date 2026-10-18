// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import operationCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import { catalog, tablesByName } from "../catalog.js";
import { describeTool, withheldClassifiedFields } from "../entity-tool-projection.js";
import { searchOperationDefinitions } from "../operation-search.js";
import { entityFieldLabels } from "../searchable-session-operations.js";

/**
 * Search over the compiled catalogue the way a session projects it
 * (searchable-session-operations.ts): every Operation an entity tool covers,
 * shown with its tool title and description, matched also on its canonical
 * text, its entity's labels and its entity's field labels; plus the static
 * Operations. Next to it, Operations a composed plugin contributes, with their
 * compiled text verbatim (a host composing the integrations and workflow
 * packages), so a fit on this repository's own fixtures is not the only proof.
 */
type Text = string | Record<string, string>;
const schema = { kind: "json-schema" as const, schema: { type: "object" } };

function operation(id: string, fields: { intent: string; key?: string; entityName?: string; name: Text; description: Text }): RuntimeOperationDefinition {
  return {
    id,
    intent: fields.intent,
    ...(fields.key ? { key: fields.key } : {}),
    ...(fields.entityName ? { entityName: fields.entityName } : {}),
    name: typeof fields.name === "string" ? { en: fields.name } : fields.name,
    description: typeof fields.description === "string" ? { en: fields.description } : fields.description,
    input: schema,
    output: schema,
    effects: { data: "read", external: "none" },
    reliability: { idempotency: { mode: "natural" } },
  } as RuntimeOperationDefinition;
}

const tools = new Map(catalog.tools.map((tool) => [tool.operationId, tool]));
const canonicalText = new Map<string, Pick<RuntimeOperationDefinition, "name" | "description">>();
const compiled: RuntimeOperationDefinition[] = [];
for (const entry of operationCatalog.entityOperations) {
  const tool = tools.get(entry.id);
  if (!tool) continue;
  canonicalText.set(entry.id, { name: entry.name as Text, description: entry.description as Text } as Pick<RuntimeOperationDefinition, "name" | "description">);
  compiled.push(operation(entry.id, { intent: entry.intent, key: entry.key, entityName: entry.entityName, name: tool.title ?? (entry.name as Text), description: tool.description }));
}
for (const entry of operationCatalog.operations) {
  compiled.push(operation(entry.key, { intent: "invoke", name: entry.title, description: entry.description }));
}

/** Compiled text of a composed host's plugin Operations, verbatim. */
const composed = [
  ...([["delete", "Delete personal instruction", "Permanently deletes one personal instruction after a server-issued, version-bound confirmation challenge."],
    ["get", "Get personal instruction", "Returns one personal instruction by its canonical identifier."],
    ["list", "List personal instructions", "Returns a filtered and sorted page of personal instructions available to the signed-in identity."]] as const)
    .map(([key, name, description]) => operation(`PersonalInstruction.${key}`, { intent: key, key, entityName: "PersonalInstruction", name, description })),
  operation("workflow.definition.publish", { intent: "invoke", name: "Publish workflow version", description: "Check and publish the selected workflow version." }),
  operation("workflow.definition.version.list", { intent: "invoke", name: "List workflow definition versions", description: "View the saved versions of this workflow, newest first." }),
  operation("workflow.instance.inspect", { intent: "invoke", name: "Inspect workflow run", description: "Uses the published version and exact live step visit; recorded history is never inferred from variables." }),
  operation("workflow.instance.list", { intent: "invoke", name: "List workflow runs", description: "Uses the published version and exact live step visit; recorded history is never inferred from variables." }),
];
const entityLabels = new Map<string, Readonly<Record<string, string>>>([
  ...catalog.entities.flatMap((entity) => entity.labels ? [[entity.entity, entity.labels] as const] : []),
  ["PersonalInstruction", { en: "Personal instruction", nl: "Persoonlijke instructie" }],
]);
// A session that may only read: classified fields stay withheld (as in its tool schemas).
const reader = { roles: [] as string[] };
const tables = tablesByName();
const entityFields = new Map([
  ...entityFieldLabels(catalog.entities, (entity) => withheldClassifiedFields(entity, tables.get(entity.table), reader)),
  ["PersonalInstruction", ["ID", "Created at", "Updated at", "External ID", "Source authority", "Source organization", "Source administration", "Source version", "Key", "Name", "Service", "Owner", "Instruction", "Onboarding answers"]],
]);
const definitions = [...compiled, ...composed];
const byId = new Map(definitions.map((definition) => [definition.id, definition]));
const locale = { tag: "en", name: "English", englishName: "English", source: "user" as const };

function search(query: string, limit = 10): string[] {
  return searchOperationDefinitions({
    definitions, allowedIds: new Set(byId.keys()), arguments: { query, limit }, locale, canonicalText, entityLabels, entityFields,
  }).operations.map((entry) => (entry.operation as { id: string }).id);
}

describe("operation search over the compiled catalogue", () => {
  test("the corpus is the compiled one", () => {
    expect(byId.has("Relation.list")).toBe(true);
    expect(byId.has("ContactDetail.get")).toBe(true);
    // Relation's own text never says "person"; its authored field labels do.
    expect(entityFields.get("Relation")).toEqual(expect.arrayContaining(["Display name", "Natural persons"]));
  });

  test("a person looked up by name is a relation read, not a personal instruction", () => {
    const found = search("find person by name");
    expect(found).toEqual(expect.arrayContaining(["Relation.get", "Relation.list"]));
    // "find" asks to read: every hit is a read.
    expect(found.every((id) => ["get", "list"].includes(byId.get(id)!.intent))).toBe(true);
    // "person" is not "personal": the relation's persons outrank the personal instruction.
    expect(found.indexOf("Relation.list")).toBeLessThan(found.indexOf("PersonalInstruction.list"));
  });

  test("the same question in Dutch, in the entity's authored Dutch labels", () => {
    expect(search("zoek relatie op naam").slice(0, 2)).toEqual(["Relation.get", "Relation.list"]);
  });

  test("a contact detail is found by its own name, before the entities that only reference it", () => {
    expect(search("contact detail email").slice(0, 5).every((id) => id.startsWith("ContactDetail."))).toBe(true);
  });

  test("a word the model adds does not hide the entity the query names", () => {
    // ContactDetail never says "person"; it is still listed, read first.
    const found = search("find contact details of a person", 20);
    expect(found).toEqual(expect.arrayContaining(["ContactDetail.get", "ContactDetail.list"]));
    expect(found.indexOf("ContactDetail.list")).toBeLessThan(found.indexOf("ContactDetail.delete"));
  });

  test("a second domain: a workflow's runs and its definitions are told apart", () => {
    expect(search("workflow run status").slice(0, 2)).toEqual(["workflow.instance.inspect", "workflow.instance.list"]);
    expect(search("list workflow definitions")[0]).toBe("workflow.definition.version.list");
  });

  test("an unmatched subject finds nothing, whatever the verb", () => {
    expect(search("create payroll")).toEqual([]);
    expect(search("find payroll")).toEqual([]);
  });

  test("a whole walk over the compiled catalogue reaches every match once", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = searchOperationDefinitions({
        definitions, allowedIds: new Set(byId.keys()), arguments: { query: "relation", limit: 7, ...(cursor ? { cursor } : {}) }, locale, canonicalText, entityLabels, entityFields,
      });
      seen.push(...page.operations.map((entry) => (entry.operation as { id: string }).id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 20)).toEqual(search("relation", 20));
    expect(seen.slice(0, 5).every((id) => id.startsWith("Relation."))).toBe(true);
  });
});

describe("a classified field's label is searched exactly where its tool schema shows the field", () => {
  // The compiled PaymentDetail entity classifies "iban"; its label is the only "IBAN" in the catalogue.
  const entity = catalog.entities.find((candidate) => candidate.classifiedFields.includes("iban"))!;
  const table = tables.get(entity.table)!;
  const roles = table.source!.authorization!.roles!;
  const readOnly = { roles: (roles.read ?? []).filter((role) => !(roles.update ?? []).includes(role)) };
  const writer = { roles: [(roles.update ?? [])[0]!] };
  const tool = catalog.tools.find((candidate) => candidate.entity === entity.entity && candidate.operation === "get")!;
  const ids = (session: { roles: string[] }, fromTable: typeof table | null = table) => {
    const fields = entityFieldLabels(catalog.entities, (candidate) =>
      withheldClassifiedFields(candidate, candidate.entity === entity.entity ? fromTable ?? undefined : tables.get(candidate.table), session));
    return searchOperationDefinitions({
      definitions, allowedIds: new Set(byId.keys()), arguments: { query: "iban" }, locale, canonicalText, entityLabels, entityFields: fields,
    }).operations.map((entry) => (entry.operation as { id: string }).id);
  };
  const schemaShows = (session: { roles: string[] }) =>
    JSON.stringify(describeTool(tool, entity, table, session).outputSchema).includes('"iban"');

  test("the fixture is the compiled entity and its own roles", () => {
    expect(entity.entity).toBe("PaymentDetail");
    expect(readOnly.roles.length).toBeGreaterThan(0);
    expect(entity.fields.filter((field) => field.label === "IBAN")).toHaveLength(1);
  });

  test("withheld from a read-only session: neither its schema nor its search shows it", () => {
    expect(schemaShows(readOnly)).toBe(false);
    expect(ids(readOnly).some((id) => id.startsWith(`${entity.entity}.`))).toBe(false);
  });

  test("shown to a writer: the same schema shows it and the search finds the entity", () => {
    expect(schemaShows(writer)).toBe(true);
    expect(ids(writer).slice(0, 2).every((id) => id.startsWith(`${entity.entity}.`))).toBe(true);
  });

  test("a table without authorization withholds it, as the projection does", () => {
    expect(withheldClassifiedFields(entity, undefined, writer)).toEqual(entity.classifiedFields);
    expect(ids(writer, null).some((id) => id.startsWith(`${entity.entity}.`))).toBe(false);
  });
});

