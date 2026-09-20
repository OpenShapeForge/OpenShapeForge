// SPDX-License-Identifier: BUSL-1.1
/**
 * The shape every MCP tool is advertised in, as the runtime lists it and
 * the compiler measures it. The fixed tools of the platform live beside
 * this, one module each (upload, edit lease, searchable Operations, the
 * derived-tool helpers, the per-entity guide/discovery/test tools): the
 * runtime lists them and the compiler budgets the listing in bytes, and the
 * two must describe the same tool. A shape authored twice drifts; a shape
 * imported twice cannot.
 */

export type McpToolShape = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: {
    title?: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
  _meta?: Record<string, unknown>;
};
