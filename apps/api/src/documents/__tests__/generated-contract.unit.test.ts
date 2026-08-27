// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import mcpCatalog from "../../generated/mcp/tools.json" with { type: "json" };
import openApi from "../../generated/rest/openapi.json" with { type: "json" };
import workflowNodes from "../../generated/workflow/entity-workflow-nodes.generated.json" with { type: "json" };
import { buildGraphqlSchema } from "../../graphql/schema.js";

const tables = manifest.tables as Array<{
  table: string;
  columns: Array<{ name: string; required: boolean; immutable?: boolean }>;
  source?: { crud?: { operations?: Record<string, boolean> } };
}>;

describe("generated Document contracts", () => {
  test("Document no longer projects version or artifact fields", () => {
    const document = tables.find((table) => table.table === "documents")!;
    expect(document).toBeDefined();
    const columns = document.columns.map((column) => column.name);
    for (const removed of ["file_name", "mime_type", "storage_location", "version_label", "checksum"]) {
      expect(columns).not.toContain(removed);
    }
    expect(document.columns.find((column) => column.name === "current_version_id")?.immutable).toBe(true);

    const schema = buildGraphqlSchema();
    const updateInput = schema.getType("UpdateDocumentInput") as
      | { getFields(): Record<string, unknown> }
      | undefined;
    expect(updateInput?.getFields()).not.toHaveProperty("currentVersionId");
    expect(schema.getMutationType()?.getFields()).not.toHaveProperty("createDocument");

    const documentActions = workflowNodes
      .filter((node) => node.entity === "Document")
      .map((node) => node.action);
    expect(documentActions).not.toContain("create");
  });

  test("DocumentVersion is required-owned and read-only on every generated transport", () => {
    const version = tables.find((table) => table.table === "document_versions")!;
    expect(version.columns.find((column) => column.name === "document_id")?.required).toBe(true);
    expect(version.source?.crud?.operations).toEqual({
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    });

    const restPaths = openApi.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(restPaths["/api/rest/v1/document-versions"] ?? {})).toEqual(["get"]);
    expect(Object.keys(restPaths["/api/rest/v1/document-versions/{id}"] ?? {}).sort()).toEqual([
      "get",
      "parameters",
    ]);

    const tools = (mcpCatalog.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(tools.filter((name) => name.startsWith("document_version_"))).toEqual([
      "document_version_list",
      "document_version_get",
    ]);

    const schema = buildGraphqlSchema();
    expect(schema.getQueryType()?.getFields()).toHaveProperty("documentVersion");
    expect(schema.getQueryType()?.getFields()).toHaveProperty("documentVersions");
    const mutations = schema.getMutationType()?.getFields() ?? {};
    expect(mutations).not.toHaveProperty("createDocumentVersion");
    expect(mutations).not.toHaveProperty("updateDocumentVersion");
    expect(mutations).not.toHaveProperty("deleteDocumentVersion");
  });
});
