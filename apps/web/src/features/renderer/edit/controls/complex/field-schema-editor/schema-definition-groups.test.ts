// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { Field } from "@/generated/compiler/field-contract";
import { FIELD_AUTHORING_PROFILES } from "@/lib/field-authoring/profiles";
import { buildFieldSchemaGroups } from "./schema-definition-groups";

test("only expression computed fields expose expression authoring controls", () => {
  const profile = FIELD_AUTHORING_PROFILES.fullFieldDefinition;
  const groups = (computed: Field["computed"]) => JSON.stringify(buildFieldSchemaGroups({ computed } as Field, profile));
  expect(groups({ kind: "temporalThreshold", field: "stage", thresholdDays: "threshold" })).not.toContain("schemaComputedExpression");
  expect(groups({ expression: "{{name}}", dependencies: ["name"] })).toContain("schemaComputedExpression");
});
