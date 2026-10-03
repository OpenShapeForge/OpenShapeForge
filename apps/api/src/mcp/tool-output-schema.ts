// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/server";

const failureSchema = {
  type: "object",
  required: ["error"],
  additionalProperties: false,
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "retryable"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        retryable: { type: "boolean" },
        detail: { type: "string" },
        retryAt: { type: "string", format: "date-time" },
        hint: { type: "string" },
        data: { type: "object", additionalProperties: true },
        category: { enum: ["policy_blocked", "timeout", "input", "authorization", "rate_limit", "availability", "provider_contract"] },
        requiredAction: { enum: ["wait", "change_input", "contact_admin"] },
        correlationId: { type: "string" },
        violations: { type: "array", items: {
          type: "object", required: ["code", "message"], additionalProperties: false,
          properties: { code: { type: "string" }, message: { type: "string" }, field: { type: "string" }, detail: { type: "string" } },
        } },
      },
      additionalProperties: false,
    },
  },
} as const;

function schemaIdentity(schema: unknown): string {
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}

/** MCP wire projection only; canonical Operation and REST contracts stay unchanged. */
export function toolWithFailureOutputSchema(tool: Tool): Tool {
  if (!tool.outputSchema) return tool;
  const original = tool.outputSchema;
  // A resource boundary keeps local refs (#, $defs, anchors) rooted at success.
  const success = { ...original, $id: original.$id ?? `urn:osf:mcp:success:${schemaIdentity(original)}` };
  const outputSchema = {
    type: "object" as const,
    anyOf: [success, failureSchema],
  };
  return {
    ...tool,
    // Stable outer identity also makes repeated legacy SDK listTools cache-safe.
    outputSchema: { ...outputSchema, $id: `urn:osf:mcp:output:${schemaIdentity(outputSchema)}` },
  };
}
