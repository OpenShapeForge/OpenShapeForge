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

test("an unclosed description placeholder is left as text in linear time", () => {
  const unclosed = `{{${" ".repeat(1_998)}x`;
  const started = performance.now();
  const result = evaluateLabelRules(relationTable, [{ ...rules[1]!, description_template: unclosed }], {
    display_name: "Robin de Vries",
    relation_type: "person",
  });
  expect(performance.now() - started).toBeLessThan(250);
  expect(result.items[0]!.description).toBe(unclosed);
  expect(evaluateLabelRules(relationTable, [{ ...rules[1]!, description_template: "Hi {{ displayName \n}}" }], {
    display_name: "Robin", relation_type: "person",
  }).items[0]!.description).toBe("Hi Robin");
});
