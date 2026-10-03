// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { GeneratedCrudTable } from "../operations/entity/types.js";
import { serializeGeneratedRestRow } from "./serialize-generated-row.js";

const table: GeneratedCrudTable = {
  name: "Example",
  schema: "example",
  table: "examples",
  tenantScoped: true,
  domainInternal: false,
  generatedCrudEligible: true,
  primaryKey: "id",
  columns: [
    {
      name: "id",
      type: "uuid",
      required: true,
      primaryKey: true,
      generated: null,
    },
    {
      name: "display_name",
      sourceField: "displayName",
      type: "text",
      required: true,
      primaryKey: false,
      generated: null,
    },
  ],
  source: {
    computedFields: [{ field: "labels", resolver: "labelRules" }],
  },
};

describe("serializeGeneratedRestRow", () => {
  test("preserves declared computed output alongside authored column names", () => {
    const labels = {
      asMap: { contactPerson: true },
      items: [{ key: "contactPerson", label: "Contactpersoon" }],
    };

    expect(serializeGeneratedRestRow(table, {
      id: "example-id",
      display_name: "Dennis Bos",
      labels,
      internalRuntimeValue: "must not cross the transport boundary",
    })).toEqual({
      id: "example-id",
      displayName: "Dennis Bos",
      labels,
    });
  });
});
