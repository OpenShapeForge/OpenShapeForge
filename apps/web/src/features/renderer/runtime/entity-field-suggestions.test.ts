// SPDX-License-Identifier: BUSL-1.1
/**
 * The entity-field variable source, end to end from authoring to picker,
 * with nothing but the base composed: LabelRule authors `entityFields` with
 * `sourceField: entityType`, the resolver reads the compiler-owned
 * `entity-fields` contract, and the pickers see the entity's fields. This
 * used to reach a workflow-owned table over a route nothing served, which
 * emptied every autocomplete silently.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPILER_ENTITY_FIELDS } from "@/generated/compiler/entity-fields";
import { entityFieldsResolver } from "@/features/renderer/runtime/resolvers/entity-fields-resolver";
import {
  getEntityConditionFilterFields,
  getEntityFieldSuggestions,
} from "@/features/renderer/runtime/entity-field-suggestions";

const labelRule = Bun.YAML.parse(readFileSync(
  join(import.meta.dir, "../../../../../../packages/compiler/config/authoring/entities/core/label-rule.yaml"),
  "utf8",
)) as { interfaces: { web: { views: { record: { variableSources: Array<{ key: string; resolver: string; params?: Record<string, unknown> }> } } } } };

const entityFieldsSource = labelRule.interfaces.web.views.record.variableSources.find((source) => source.resolver === "entityFields")!;

describe("entity field suggestions come from the compiled contract", () => {
  test("every base entity has readable fields, and the tenant fence is not one of them", () => {
    expect(Object.keys(COMPILER_ENTITY_FIELDS).length).toBeGreaterThan(100);
    for (const [entity, fields] of Object.entries(COMPILER_ENTITY_FIELDS)) {
      expect(fields.length, entity).toBeGreaterThan(0);
      expect(fields.some((field) => field.key === "tenantId" || field.osfType === "tenantId"), entity).toBe(false);
    }
  });

  test("the LabelRule form resolves entityFields for the chosen entity type", async () => {
    expect(entityFieldsSource.params).toEqual({ sourceField: "entityType" });
    const resolve = (entityType: string | undefined) => entityFieldsResolver.resolve(entityFieldsSource.params, {
      formState: entityType === undefined ? {} : { entityType },
      lang: "nl",
    } as never);

    const relation = await resolve("Relation");
    expect(relation.map((suggestion) => suggestion.path)).toContain("displayName");
    expect(relation.find((suggestion) => suggestion.path === "displayName")).toMatchObject({
      insertText: "{{displayName}}",
      sourceNodeLabel: "Relation",
      valueType: "string",
    });
    // Reference-typed fields carry their options, so a condition can offer a
    // dropdown rather than a free-text literal.
    expect(relation.find((suggestion) => suggestion.path === "relationType")?.options?.length).toBeGreaterThan(0);

    expect(await resolve(undefined)).toEqual([]);
    expect(await resolve("NoSuchEntity")).toEqual([]);
  });

  test("condition builders get the same fields, typed for their inputs", () => {
    const fields = getEntityConditionFilterFields("Task", "en");
    expect(fields.find((field) => field.key === "title")).toMatchObject({ inputKind: "text" });
    expect(fields.find((field) => field.key === "status")).toMatchObject({ inputKind: "select" });
    expect(getEntityFieldSuggestions("Task", "en")).toBe(getEntityFieldSuggestions("Task", "en"));
  });
});
