// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { evaluateLabelRules, type LabelRuleRow } from "./computed-fields.js";
import type { GeneratedCrudTable } from "./types.js";

const relationTable: GeneratedCrudTable = {
  name: "relations",
  schema: "erp",
  table: "relations",
  tenantScoped: true,
  domainInternal: false,
  generatedCrudEligible: true,
  primaryKey: "id",
  columns: [
    { name: "display_name", sourceField: "displayName", type: "text", required: true, primaryKey: false, generated: null },
    { name: "relation_type", sourceField: "relationType", type: "text", required: true, primaryKey: false, generated: null },
    { name: "hubble_demo_segment", sourceField: "hubbleDemoSegment", type: "text", required: false, primaryKey: false, generated: null },
  ],
  source: { authoringEntityName: "Relation", computedFields: [{ field: "labels", resolver: "labelRules" }] },
};

const rules: LabelRuleRow[] = [{
  id: "rule-finance",
  key: "financialSector",
  label: "Financiële sector",
  variant: "secondary",
  output_type: "boolean",
  expression: {
    kind: "rule",
    operator: "in",
    left: { kind: "path", path: "hubbleDemoSegment" },
    right: { kind: "literal", value: ["banking", "fintech", "insurance"] },
  },
  description_template: "{{displayName}} werkt in {{hubbleDemoSegment}}.",
  priority: 80,
}, {
  id: "rule-person",
  key: "contactPerson",
  label: "Contactpersoon",
  variant: "outline",
  output_type: "boolean",
  expression: {
    operator: "equals",
    left: { kind: "path", path: "relationType" },
    right: { kind: "literal", value: "person" },
  },
  description_template: null,
  priority: 60,
}];

describe("computed label rules", () => {
  test("evaluates canonical expressions against authored field names", () => {
    expect(evaluateLabelRules(relationTable, rules, {
      display_name: "Polderbank N.V.",
      relation_type: "organization",
      hubble_demo_segment: "banking",
    })).toEqual({
      asMap: { financialSector: true, contactPerson: false },
      items: [{
        id: "rule-finance",
        key: "financialSector",
        label: "Financiële sector",
        variant: "secondary",
        value: true,
        description: "Polderbank N.V. werkt in banking.",
      }],
    });
  });

  test("keeps nonmatching values in asMap but only exposes matching chips", () => {
    const result = evaluateLabelRules(relationTable, rules, {
      display_name: "Robin de Vries",
      relation_type: "person",
      hubble_demo_segment: "retail",
    });
    expect(result.asMap).toEqual({ financialSector: false, contactPerson: true });
    expect(result.items.map(({ label }) => label)).toEqual(["Contactpersoon"]);
  });
});
