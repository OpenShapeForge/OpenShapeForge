// SPDX-License-Identifier: BUSL-1.1
/**
 * Generated MCP e2e suite — the MCP counterpart of the REST and GraphQL
 * entity-crud suites. Drives the full Fastify app (createApiApp) via inject(),
 * or E2E_API_URL over HTTP when set, speaking JSON-RPC over the Streamable HTTP
 * transport at /api/mcp.
 *
 * Row setup/cleanup reuses the shared GraphQL harness, so all three transports
 * are exercised against the same data and RLS session plumbing.
 */
import { afterAll, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { createApiApp } from "../../roles/api.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import { MCP_MOUNT_PATH } from "../generated-mcp-server.js";
import catalog from "../../generated/mcp/tools.json" with { type: "json" };
import {
  createdRows,
  describe,
  noRoles,
  readOnly,
  registerSuiteLifecycle,
  remoteUrl,
  seed,
  tenantA,
  tenantB,
  test,
  type Identity,
} from "../../graphql/__tests__/e2e/harness.js";
import {
  fieldName,
  foreignKeyTargets,
  createRow,
  sampleValue,
  tables,
  tablesByName,
  untrackRow,
} from "../../graphql/__tests__/e2e/entity-factory.js";

registerSuiteLifecycle();

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;

let app: ReturnType<typeof createApiApp> | null = null;
const runtimeModules = await loadRuntimeModules();
expect(runtimeModules.failures).toEqual([]);
function getApp() {
  app ??= createApiApp(
    process.env.DATABASE_URL
      ? { cors: false, databaseUrl: process.env.DATABASE_URL, modules: runtimeModules }
      : { cors: false, modules: runtimeModules },
  );
  return app;
}

afterAll(async () => {
  await app?.close();
  app = null;
});

let nextRpcId = 1;

/**
 * One JSON-RPC call over the Streamable HTTP transport. The server runs
 * stateless, so no initialize handshake is needed between calls — each request
 * is self-contained. `Accept` must list both content types the transport can
 * answer with, or it rejects the request before dispatch.
 */
async function rpc(
  identity: Identity | null,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  if (identity) {
    applyTrustedContextHeaders(headers, identity, { secret: SECRET });
  }
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: nextRpcId++,
    method,
    ...(params === undefined ? {} : { params }),
  });

  if (remoteUrl) {
    const response = await fetch(`${remoteUrl}${MCP_MOUNT_PATH}`, {
      method: "POST",
      headers,
      body: payload,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  const response = await getApp().inject({
    method: "POST",
    url: MCP_MOUNT_PATH,
    headers: Object.fromEntries(headers.entries()),
    payload,
  });
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  };
}

/** Unwrap a tools/call result, parsing the JSON payload the tool returned. */
function toolPayload(body: any): any {
  const text = body?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

function toolError(body: any): string | undefined {
  if (body?.result?.isError !== true) return undefined;
  return body?.result?.content?.[0]?.text;
}

function resourcePayload(body: any): any {
  const text = body?.result?.contents?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

const mcpTables = tables.filter((table) => table.source?.mcp);
const workflowOperator: Identity = {
  tenantId: tenantA.tenantId,
  userId: randomUUID(),
  roles: ["workflow-admin"],
};

async function callTool(
  identity: Identity | null,
  name: string,
  args: Record<string, unknown> = {},
) {
  return rpc(identity, "tools/call", { name, arguments: args });
}

/** Sample create arguments: required scalars plus real rows for required FKs. */
async function buildCreateArgs(
  table: (typeof mcpTables)[number],
  identity: Identity,
): Promise<Record<string, unknown>> {
  const fkTargets = foreignKeyTargets(table);
  const args: Record<string, unknown> = {};
  for (const column of table.columns) {
    if (!column.required || column.primaryKey) continue;
    if (["tenant_id", "created_at", "updated_at"].includes(column.name)) continue;
    const target = fkTargets.get(column.name);
    if (target) {
      args[fieldName(column)] = await createRow(tablesByName.get(target)!, identity);
      continue;
    }
    args[fieldName(column)] = sampleValue(column, seed);
  }
  return args;
}

describe("generated MCP server", () => {
  test("rejects an unauthenticated request", async () => {
    const { status } = await rpc(null, "tools/list");
    expect(status).toBe(401);
  });

  test("advertises the compiled tool catalog to an authorized session", async () => {
    const { status, body } = await rpc(tenantA, "tools/list");
    expect(status).toBe(200);
    const names = (body.result.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(catalog.tools.map((tool) => tool.name));
  });

  test("binds, authorizes and dispatches a canonical operation tool", async () => {
    const listed = await rpc(workflowOperator, "tools/list");
    expect(listed.status).toBe(200);
    const tools = listed.body.result.tools as { name: string; inputSchema: unknown }[];
    expect(tools).toContainEqual(expect.objectContaining({
      name: "workflow_start_webhook",
      inputSchema: expect.objectContaining({ type: "object" }),
    }));

    const called = await callTool(workflowOperator, "workflow_start_webhook", {
      definitionId: randomUUID(),
    });
    expect(toolError(called.body)).toMatch(/NOT_FOUND/);
  });

  test("carries the authored field schema into the tool input schema", async () => {
    const { body } = await rpc(tenantA, "tools/list");
    const tools = body.result.tools as { name: string; inputSchema: any }[];
    const create = tools.find((tool) => tool.name === "relation_create");
    expect(create).toBeDefined();
    const displayName = create!.inputSchema.properties.displayName;
    // Authored validation reaches the model as JSON Schema, not as a 400.
    expect(displayName.maxLength).toBe(200);
    expect(create!.inputSchema.required).toContain("displayName");
    // Referentiedata expanded into a closed vocabulary at compile time.
    expect(create!.inputSchema.properties.relationType.enum).toEqual([
      "person",
      "organization",
      "group",
    ]);
  });

  test("exposes the authorized YAML-derived entity catalog as MCP resources", async () => {
    const { status, body } = await rpc(tenantA, "resources/list");
    expect(status).toBe(200);
    const resources = body.result.resources as { uri: string; title: string }[];
    expect(resources[0]?.uri).toBe("osf://schema/entities");
    expect(resources.slice(1).map((resource) => resource.uri)).toEqual(
      catalog.entities.map((entity) => `osf://schema/entities/${entity.slug}`),
    );

    const index = resourcePayload(
      (await rpc(tenantA, "resources/read", { uri: "osf://schema/entities" })).body,
    );
    expect(index.entities.map((entity: any) => entity.entity)).toEqual(
      catalog.entities.map((entity) => entity.entity),
    );
  });

  test("reads field, operation and only authorized relationship semantics", async () => {
    const source = catalog.entities.find((entity) => entity.entity === "Relation");
    expect(source).toBeDefined();
    const { status, body } = await rpc(tenantA, "resources/read", {
      uri: `osf://schema/entities/${source!.slug}`,
    });
    expect(status).toBe(200);
    const resource = resourcePayload(body);
    expect(resource.description).toBe(source!.description);
    expect(resource.fields).toHaveLength(source!.fields.length);
    expect(resource).not.toHaveProperty("jsonSchema");
    expect(resource.operations.length).toBeGreaterThan(0);
    expect(resource.relationships).toEqual(
      source!.relationships
        .filter((relationship) =>
          catalog.entities.some((entity) => entity.entity === relationship.target),
        )
        .map((relationship) => {
          const target = catalog.entities.find(
            (entity) => entity.entity === relationship.target,
          )!;
          return {
            ...relationship,
            resourceUri: `osf://schema/entities/${target.slug}`,
          };
        }),
    );
    expect(resource.relationships.map((relationship: any) => relationship.target)).not.toContain(
      "Account",
    );
  });

  test("uses operation tool schemas as the authoritative write contract", async () => {
    const paymentDetail = catalog.entities.find(
      (entity) => entity.entity === "PaymentDetail",
    );
    expect(paymentDetail).toBeDefined();

    const resource = resourcePayload(
      (
        await rpc(tenantA, "resources/read", {
          uri: `osf://schema/entities/${paymentDetail!.slug}`,
        })
      ).body,
    );
    const { body } = await rpc(tenantA, "tools/list");
    const create = (body.result.tools as { name: string; inputSchema: any }[]).find(
      (tool) => tool.name === "payment_detail_create",
    );

    expect(resource).not.toHaveProperty("jsonSchema");
    expect(
      resource.fields
        .filter((field: any) => field.readOnly)
        .map((field: any) => field.key),
    ).toEqual(expect.arrayContaining(["id", "createdAt", "updatedAt"]));
    for (const field of ["id", "createdAt", "updatedAt"]) {
      expect(Object.keys(create!.inputSchema.properties)).not.toContain(field);
    }
    expect(create!.inputSchema.required).toEqual(["type"]);
  });

  test("does not enumerate or read entity resources for a session without roles", async () => {
    const listed = await rpc(noRoles, "resources/list");
    expect(listed.body.result.resources.map((resource: any) => resource.uri)).toEqual([
      "osf://schema/entities",
    ]);
    const denied = await rpc(noRoles, "resources/read", {
      uri: `osf://schema/entities/${catalog.entities[0]!.slug}`,
    });
    expect(denied.body.error.code).toBe(-32602);
  });

  test("answers empty optional MCP catalogs without protocol errors", async () => {
    expect((await rpc(tenantA, "prompts/list")).body.result.prompts).toEqual([]);
    expect(
      (await rpc(tenantA, "resources/templates/list")).body.result.resourceTemplates,
    ).toEqual([]);
  });

  test("annotates read-only and destructive tools", async () => {
    const { body } = await rpc(tenantA, "tools/list");
    const tools = body.result.tools as { name: string; annotations: any }[];
    expect(tools.find((t) => t.name === "relation_list")!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "relation_delete")!.annotations.destructiveHint).toBe(
      true,
    );
  });

  test("hides write tools from a read-only session", async () => {
    const { body } = await rpc(readOnly, "tools/list");
    const names = (body.result.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain("relation_list");
    expect(names).toContain("relation_get");
    expect(names).not.toContain("relation_create");
    expect(names).not.toContain("relation_update");
    expect(names).not.toContain("relation_delete");
  });

  test("advertises nothing to a session with no roles", async () => {
    const { body } = await rpc(noRoles, "tools/list");
    expect(body.result.tools).toEqual([]);
  });

  test("refuses a tool the session may not invoke", async () => {
    const { body } = await callTool(readOnly, "relation_create", { displayName: "nope" });
    expect(toolError(body)).toMatch(/NOT_FOUND/);
  });

  test("reports unknown tools without confirming which entities exist", async () => {
    const { body } = await callTool(tenantA, "no_such_tool", {});
    expect(toolError(body)).toMatch(/Unknown tool/);
  });

  for (const table of mcpTables) {
    const prefix = table.source!.mcp!.toolPrefix;

    test(`${prefix}: create, get, list, update, delete round-trip`, async () => {
      const args = await buildCreateArgs(table, tenantA);
      const created = await callTool(tenantA, `${prefix}_create`, args);
      const row = toolPayload(created.body);
      expect(toolError(created.body)).toBeUndefined();
      expect(row.id).toBeTruthy();
      createdRows.push({ table, id: row.id, identity: tenantA });

      const fetched = toolPayload(
        (await callTool(tenantA, `${prefix}_get`, { id: row.id })).body,
      );
      expect(fetched.id).toBe(row.id);

      const listed = toolPayload(
        (await callTool(tenantA, `${prefix}_list`, { first: 5 })).body,
      );
      expect(Array.isArray(listed.items)).toBe(true);
      expect(listed.totalCount).toBeGreaterThan(0);

      const textColumn = table.columns.find(
        (column) =>
          column.type === "text" &&
          !column.primaryKey &&
          !["tenant_id", "created_at", "updated_at"].includes(column.name),
      );
      if (textColumn) {
        const updated = toolPayload(
          (
            await callTool(tenantA, `${prefix}_update`, {
              id: row.id,
              values: { [fieldName(textColumn)]: `updated-${seed}` },
            })
          ).body,
        );
        expect(updated[fieldName(textColumn)]).toBe(`updated-${seed}`);
      }

      const deleted = await callTool(tenantA, `${prefix}_delete`, { id: row.id });
      expect(toolPayload(deleted.body)).toEqual({ deleted: true });
      untrackRow(row.id);

      const missing = await callTool(tenantA, `${prefix}_get`, { id: row.id });
      expect(toolError(missing.body)).toMatch(/NOT_FOUND/);
    });

    test(`${prefix}: does not leak rows across tenants`, async () => {
      const createdId = await createRow(table, tenantA);
      const other = await callTool(tenantB, `${prefix}_get`, { id: createdId });
      expect(toolError(other.body)).toMatch(/NOT_FOUND/);
    });

    test(`${prefix}: rejects a create argument the tool schema does not declare`, async () => {
      // The schema says additionalProperties:false; the server must agree.
      const { body } = await callTool(tenantA, `${prefix}_create`, {
        definitelyNotAField: "x",
      });
      expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
      expect(toolError(body)).toMatch(/definitelyNotAField/);
    });

    test(`${prefix}: rejects a server-managed field on create`, async () => {
      // Silently dropping `id` would let a model believe it chose the id.
      const { body } = await callTool(tenantA, `${prefix}_create`, {
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
      expect(toolError(body)).toMatch(/\bid\b/);
    });

    test(`${prefix}: rejects an undeclared field inside update values`, async () => {
      const createdId = await createRow(table, tenantA);
      const { body } = await callTool(tenantA, `${prefix}_update`, {
        id: createdId,
        values: { definitelyNotAField: "x" },
      });
      expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
    });

    test(`${prefix}: rejects an unknown filter field`, async () => {
      const { body } = await callTool(tenantA, `${prefix}_list`, {
        filter: { definitelyNotAField: "x" },
      });
      expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
    });

    /**
     * Authored `immutable` over MCP (#177). The advertised schema and the
     * server's answer come from the same authored fact, so a model that reads
     * the catalog and a model that guesses both learn the same rule. A table
     * with no immutable column asserts the unaffected case: create and update
     * advertise the same properties.
     */
    const immutable = table.columns.find((column) => column.immutable);

    test(`${prefix}: the update schema ${immutable ? "withholds" : "matches create on"} immutable fields`, async () => {
      const { body } = await rpc(tenantA, "tools/list");
      const tools = body.result.tools as { name: string; inputSchema: any }[];
      const create = tools.find((tool) => tool.name === `${prefix}_create`)!;
      const update = tools.find((tool) => tool.name === `${prefix}_update`)!;
      const creatable = Object.keys(create.inputSchema.properties);
      const updatable = Object.keys(update.inputSchema.properties.values.properties);

      if (!immutable) {
        expect(updatable).toEqual(creatable);
        return;
      }
      const field = fieldName(immutable);
      expect(creatable).toContain(field);
      expect(updatable).not.toContain(field);
      expect(updatable).toEqual(creatable.filter((key) => key !== field));
    });

    if (immutable) {
      const field = fieldName(immutable);
      const fkTarget = foreignKeyTargets(table).get(immutable.name);

      test(`${prefix}: accepts ${field} on create and refuses it on update`, async () => {
        const value = fkTarget
          ? await createRow(tablesByName.get(fkTarget)!, tenantA)
          : sampleValue(immutable, seed);
        const args = await buildCreateArgs(table, tenantA);
        const created = await callTool(tenantA, `${prefix}_create`, {
          ...args,
          [field]: value,
        });
        expect(toolError(created.body)).toBeUndefined();
        const row = toolPayload(created.body);
        createdRows.push({ table, id: row.id, identity: tenantA });
        expect(row[field]).toBe(value);

        const { body } = await callTool(tenantA, `${prefix}_update`, {
          id: row.id,
          values: { [field]: value },
        });
        expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
        expect(toolError(body)).toMatch(new RegExp(field));

        const after = toolPayload(
          (await callTool(tenantA, `${prefix}_get`, { id: row.id })).body,
        );
        expect(after[field]).toBe(value);
      });
    }
  }
});
