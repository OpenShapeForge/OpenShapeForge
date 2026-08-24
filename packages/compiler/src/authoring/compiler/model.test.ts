// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import type { ComponentCatalog, Field } from "../types.js";
import { resolveModelFields } from "./model.js";

const catalog: ComponentCatalog = {
  schemaVersion: 1,
  kind: "componentCatalog",
  defaults: {
    string: { component: "TextInput" },
    collection: { component: "CollectionInput" },
  },
  viewDefaults: {},
  components: {},
};

describe("resolveModelFields", () => {
  it("preserves authored collection bounds on the compiled field", () => {
    const fields: Field[] = [
      {
        key: "recipients",
        valueType: "string",
        cardinality: { min: 1, max: 4 },
      },
    ];

    expect(resolveModelFields(fields, catalog)[0]).toMatchObject({
      cardinality: "collection",
      cardinalityBounds: { min: 1, max: 4 },
    });
  });
});
