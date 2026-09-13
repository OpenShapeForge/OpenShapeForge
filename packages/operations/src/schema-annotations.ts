// SPDX-License-Identifier: BUSL-1.1
/** Presentation metadata only: reading a choice never grants authority to use it. */
export const operationReferenceKeyword = {
  keyword: "x-osf-reference",
  schemaType: "object" as const,
  valid: true,
  metaSchema: {
    type: "object",
    required: ["entity"],
    additionalProperties: false,
    properties: {
      entity: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9._-]*$" },
      valueField: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      recordIdSourceField: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
    },
  },
};
