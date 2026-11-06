// SPDX-License-Identifier: BUSL-1.1
/** The canonical OperationError contract, projected by every transport. */
export function operationErrorSchema() {
  return {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "retryable"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    detail: { type: "string" },
    retryable: { type: "boolean" },
    retryAt: { type: "string", format: "date-time" },
    violations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          field: { type: "string" },
          code: { type: "string" },
          message: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
    data: { type: "object", additionalProperties: true },
  },
};
}
