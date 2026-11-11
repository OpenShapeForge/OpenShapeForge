// SPDX-License-Identifier: BUSL-1.1
/** The private document upload control, offered when a module stores artifacts. */
import type { McpToolShape } from "./mcp-tool-shape.js";

export const ARTIFACT_UPLOAD_TOOL_NAME = "upload_document_file";

/** The private upload control, offered when a module stores artifacts. */
export function uploadToolDefinition(productName: string): McpToolShape {
  return {
    name: ARTIFACT_UPLOAD_TOOL_NAME,
    title: "Upload document file",
    description:
      `Open a private file picker so the person can upload document bytes directly to ${productName}. A client that cannot show the picker receives a one-time upload link instead, which the person can open or an agent that can read the file can POST the bytes to. Use the returned artifactId in the requested create operation.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  };
}
