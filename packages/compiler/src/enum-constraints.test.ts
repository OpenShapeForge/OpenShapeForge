// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { CompiledField } from "./authoring/types.js";
import {
  applyEnumConstraints,
  enumConstraintForField,
  resolveFieldEnum,
} from "./enum-constraints.js";
import { generateArtifacts } from "./generate.js";
import type { PlatformSchemaManifest } from "./schema.js";

const field = (overrides: Partial<CompiledField> & { key: string }): CompiledField =>
  ({
    valueType: "string",
    cardinality: "single",
    required: false,
    label: { en: overrides.key },
    render: { component: "Input" },
    ...overrides,
  }) as CompiledField;

const referentiedata = {
  STATUS: [
    { value: "open", label: { en: "Open", nl: "Open" } },
    { value: "closed", label: { en: "Closed", nl: "Gesloten" } },
  ],
};

describe("resolveFieldEnum", () => {
  it("resolves static and referentiedata authoring through one function", () => {
    expect(
      resolveFieldEnum(
        field({
          key: "mode",
          options: {
            type: "static",
            items: [
              { value: "fast", label: { en: "Fast" } },
              { value: "safe", label: { en: "Safe" } },
            ],
          },
        }),
        referentiedata,
      )?.values,
    ).toEqual(["fast", "safe"]);

    expect(
      resolveFieldEnum(
        field({
          key: "status",
          render: {
            component: "ReferenceSelect",
            props: { referentieGroep: "STATUS" },
          },
        }),
        referentiedata,
      )?.values,
    ).toEqual(["open", "closed"]);
  });
});

describe("enumConstraintForField", () => {
  it("models scalar collections, object properties and arrays of objects", () => {
    const mode = field({
      key: "mode",
      options: {
        type: "static",
        items: [{ value: "safe", label: { en: "Safe" } }],
      },
    });
    const tag = field({
      key: "tags",
      cardinality: "collection",
      options: {
        type: "static",
        items: [{ value: "urgent", label: { en: "Urgent" } }],
      },
    });
    const settings = field({
      key: "settings",
      valueType: "object",
      children: [mode],
    });
    const rules = field({
      key: "rules",
      valueType: "object",
      cardinality: "collection",
      item: field({
        key: "rule",
        valueType: "object",
        children: [mode],
      }),
    });

    expect(enumConstraintForField(tag, referentiedata)).toEqual({
      items: { values: ["urgent"] },
    });
    expect(enumConstraintForField(settings, referentiedata)).toEqual({
      properties: { mode: { values: ["safe"] } },
    });
    expect(enumConstraintForField(rules, referentiedata)).toEqual({
      items: { properties: { mode: { values: ["safe"] } } },
    });
  });
});

describe("applyEnumConstraints", () => {
  it("stamps and serializes the authored enum on both manifest column views", () => {
    const manifest: PlatformSchemaManifest = {
      version: 1,
      tables: [
        {
          schema: "erp",
          name: "widgets",
          tenantScoped: false,
          generatedCrud: true,
          columns: [
            { name: "id", type: "uuid", primaryKey: true },
            { name: "status", type: "text", sourceField: "status" },
          ],
          source: {
            authoringEntityName: "Widget",
            graphql: {
              typeName: "Widget",
              singleQueryName: "widget",
              listQueryName: "widgets",
              createMutationName: "createWidget",
              updateMutationName: "updateWidget",
              deleteMutationName: "deleteWidget",
              relationships: [],
            },
          },
        },
      ],
    };
    const enriched = applyEnumConstraints(
      manifest,
      [
        {
          contract: {
            entity: { name: "Widget" },
            model: {
              fields: [
                field({
                  key: "status",
                  options: {
                    type: "referentiedata",
                    referentieGroep: "STATUS",
                  },
                }),
              ],
            },
          } as never,
        },
      ],
      referentiedata,
    );

    expect(enriched.tables[0]?.columns[1]?.enumConstraint).toEqual({
      values: ["open", "closed"],
    });

    const artifact = generateArtifacts(enriched).find((item) =>
      item.path.endsWith("db/manifest.json"),
    );
    const rendered = JSON.parse(artifact!.contents);
    expect(rendered.tables[0].columns[1].enumConstraint).toEqual({
      values: ["open", "closed"],
    });
    expect(rendered.capabilities.generatedEntities[0].fields[1].enumConstraint).toEqual({
      values: ["open", "closed"],
    });
  });
});
