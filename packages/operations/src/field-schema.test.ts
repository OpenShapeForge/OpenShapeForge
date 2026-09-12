// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { operationFieldObjectSchema } from "./field-schema.js";

test("runtime fields use the host semantic and reference-data registries", () => {
  const schema = operationFieldObjectSchema([{
    key: "reasons",
    valueType: "string",
    semanticType: "shortReason",
    cardinality: { min: 2, max: 3 },
    required: true,
    options: { type: "referentiedata", referentieGroep: "REASONS" },
  }], {
    semanticTypes: {
      shortReason: {
        valueType: "string",
        label: { en: "Reason" },
        validation: { maxLength: 80 },
      },
    },
    referentiedata: {
      REASONS: [
        { value: "accepted", label: { en: "Accepted" } },
        { value: "declined", label: { en: "Declined" } },
      ],
    },
  });

  expect(schema).toMatchObject({
    required: ["reasons"],
    properties: {
      reasons: {
        type: "array",
        title: "Reason",
        minItems: 2,
        maxItems: 3,
        items: {
          type: "string",
          maxLength: 80,
          enum: ["accepted", "declined"],
        },
      },
    },
  });
});
