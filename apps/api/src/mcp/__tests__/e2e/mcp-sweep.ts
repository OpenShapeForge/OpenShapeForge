// SPDX-License-Identifier: BUSL-1.1
/**
 * The MCP sweep's transport helpers, shared by the CRUD sweep and the
 * reference-policy sweep: one JSON-RPC call over the Streamable HTTP
 * transport, tool naming and argument shaping from the catalog, the create
 * argument builder, and the canonical output check.
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import Ajv2020 from "ajv/dist/2020.js";
import catalog from "../../../generated/mcp/tools.json" with { type: "json" };
import {
  createRow,
  eligibleTables,
  fieldName,
  foreignKeyTargets,
  isMutableColumn,
  nextMarker,
  pluginCreateInput,
  schemaSample,
  tables,
  tablesByName,
} from "../../../graphql/__tests__/e2e/entity-factory.js";
import {
  isCanonical,
  isEntityBackedCreate,
  leaseRequired,
  operationIdFor,
  versionRequired,
} from "../../../graphql/__tests__/e2e/operations.js";
import {
  apiApp,
  createdRows,
  type Identity,
  remoteUrl,
  tenantA,
} from "../../../graphql/__tests__/e2e/harness.js";
import { MCP_MOUNT_PATH } from "../../generated-mcp-server.js";

export const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;

let nextRpcId = 1;

/**
 * One JSON-RPC call over the Streamable HTTP transport. This helper uses the
 * sessionless compatibility path, so each request is self-contained; real
 * elicitation and MCP Apps clients initialize a stateful session. `Accept`
 * must list both content types the transport can answer with, or the request is
 * rejected before dispatch.
 */
export async function rpc(
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

  const response = await (await apiApp()).inject({
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

/** Parse the JSON value returned by a generated tool. */
export function toolEnvelope(body: any): any {
  const text = body?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

/** Normalize strict-v2 envelopes and legacy-v1 payloads for shared assertions. */
export function toolPayload(body: any): any {
  const envelope = toolEnvelope(body);
  const canonical = envelope && Object.hasOwn(envelope, "data");
  const data = canonical ? envelope.data : envelope;
  if (canonical && Array.isArray(data?.items)) {
    return { ...data, items: data.items.map((item: any) => item.data) };
  }
  return data;
}

export function toolError(body: any): string | undefined {
  if (body?.result?.isError !== true) return undefined;
  return body?.result?.content?.[0]?.text;
}

export type McpTable = (typeof tables)[number];
export type CrudOperation = "list" | "get" | "create" | "update" | "delete";

/** `<prefix>_<op>` for a dedicated entity, the shared `osf_<op>` for a generic one. */
export function toolNameFor(table: McpTable, operation: CrudOperation): string {
  const mcp = table.source!.mcp!;
  return mcp.tools === "generic" ? `osf_${operation}` : `${mcp.toolPrefix}_${operation}`;
}

/** A generic tool call names its entity; a dedicated tool must not. */
export function argsFor(table: McpTable, args: Record<string, unknown>): Record<string, unknown> {
  return table.source!.mcp!.tools === "generic"
    ? { entity: table.source!.authoringEntityName, ...args }
    : args;
}

/** Whether `identity` holds a role the entity's operation allow-list names. */
export function sessionMayInvoke(identity: Identity, entity: string, operation: CrudOperation): boolean {
  const roles = eligibleTables.find((table) => table.source?.authoringEntityName === entity)
    ?.source?.authorization?.roles;
  const allowed = roles?.[operation === "list" || operation === "get" ? "read" : operation] ?? [];
  return allowed.some((role) => identity.roles.includes(role));
}

/** Transport controls a create or update schema advertises next to the authored fields. */
export const MUTATION_CONTROLS = new Set([
  "blueprintId",
  "expectedVersion",
  "leaseToken",
  "confirmed",
  "confirmationToken",
  "confirmationAnswer",
]);

export function authoredKeys(properties: Record<string, unknown>): string[] {
  return Object.keys(properties).filter((key) => !MUTATION_CONTROLS.has(key));
}

/** The compiled catalog entry for one entity's operation — loud when absent. */
export function catalogTool(table: McpTable, operation: CrudOperation) {
  const name = toolNameFor(table, operation);
  const entry = catalog.tools.find(
    (tool) => tool.name === name && tool.entity === table.source!.authoringEntityName,
  );
  if (!entry) {
    throw new Error(`${table.source!.authoringEntityName} has no compiled ${name} tool.`);
  }
  return entry;
}

/**
 * The input schema a session is shown for one entity's operation: the tool's
 * own for a dedicated entity, the answer of `osf_describe` for a generic one
 * (the listing only carries the compact projection: the `entity` enum and
 * the shared properties). Throws when the listing omits it, so a test that
 * expected the tool sees why instead of a property read on undefined.
 */
export async function advertisedSchema(
  identity: Identity,
  tools: { name: string; inputSchema: any }[],
  table: McpTable,
  operation: CrudOperation,
): Promise<any> {
  const name = toolNameFor(table, operation);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`The session was not offered ${name}.`);
  if (table.source!.mcp!.tools !== "generic") return tool.inputSchema;
  const entity = table.source!.authoringEntityName;
  expect(tool.inputSchema.properties.entity.enum).toContain(entity);
  const described = await callTool(identity, "osf_describe", { entity, operation });
  expect(toolError(described.body)).toBeUndefined();
  const schema = toolPayload(described.body)?.operations?.[operation]?.inputSchema;
  if (!schema) throw new Error(`osf_describe advertises no ${entity} ${operation} schema to this session.`);
  return schema;
}

export async function acquireLease(
  table: McpTable,
  identity: Identity,
  row: Record<string, unknown>,
  intent: "update" | "delete",
): Promise<Record<string, string>> {
  if (!leaseRequired(table, intent)) {
    if (!versionRequired(table, intent)) return {};
    expect(row.updatedAt).toBeString();
    return { expectedVersion: String(row.updatedAt) };
  }
  const acquired = await callTool(identity, "osf_acquire_edit_lease", {
    operationId: operationIdFor(table, intent),
    targetId: row.id,
  });
  expect(toolError(acquired.body)).toBeUndefined();
  const lease = toolPayload(acquired.body);
  expect(Date.parse(lease.targetVersion)).toBe(Date.parse(String(row.updatedAt)));
  return {
    expectedVersion: lease.targetVersion,
    leaseToken: lease.leaseToken,
  };
}

export const outputAjv = new Ajv2020.default({
  strict: false,
  validateFormats: false,
});
export const outputValidators = new Map<string, ReturnType<typeof outputAjv.compile>>();

export function expectCanonicalToolOutput(table: McpTable, operation: CrudOperation, body: any): void {
  const tool = catalogTool(table, operation);
  const key = `${tool.entity}.${tool.name}`;
  if (!tool.outputSchema) throw new Error(`${key} has no output schema`);
  let validate = outputValidators.get(key);
  if (!validate) {
    validate = outputAjv.compile(tool.outputSchema);
    outputValidators.set(key, validate);
  }
  const structured = body?.result?.structuredContent;
  if (!validate(withoutPluginOffers(structured))) {
    throw new Error(
      `${key} returned structuredContent outside its outputSchema: ` +
        JSON.stringify(validate.errors),
    );
  }
}

/**
 * Known contract gap, validated around rather than hidden: the runtime also
 * offers the plugin Operations bound to an entity (a blueprint entity's
 * blueprint commands) as `{ operation: { intent: "invoke" }, binding }`
 * (operations/entity/runtime.ts, entityPluginOfferBinding), while the
 * compiled OperationOffer schema (packages/compiler/src/generate-mcp.ts)
 * models only the five entity intents and no `binding`. Those offers are
 * removed before validation; every entity-intent offer and the rest of the
 * envelope are still held to the advertised schema.
 */
export function withoutPluginOffers(structured: any): any {
  if (!structured || typeof structured !== "object") return structured;
  const entityOffers = (offers: unknown) =>
    Array.isArray(offers)
      ? offers.filter((offer) => offer?.operation?.intent !== "invoke")
      : offers;
  return {
    ...structured,
    ...("operations" in structured ? { operations: entityOffers(structured.operations) } : {}),
    ...(structured.data && Array.isArray(structured.data.items)
      ? {
          data: {
            ...structured.data,
            items: structured.data.items.map((item: any) =>
              item && typeof item === "object" && "operations" in item
                ? { ...item, operations: entityOffers(item.operations) }
                : item,
            ),
          },
        }
      : {}),
  };
}

export function resourcePayload(body: any): any {
  const text = body?.result?.contents?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

export const mcpTables = tables.filter((table) => table.source?.mcp);
export const mcpCreateTables = eligibleTables.filter(
  (table) => table.source?.mcp?.operations.create,
);
export const notebookWriter: Identity = {
  tenantId: tenantA.tenantId,
  userId: randomUUID(),
  roles: ["Organization.All.ReadWrite"],
};

export async function callTool(
  identity: Identity | null,
  name: string,
  args: Record<string, unknown> = {},
) {
  return rpc(identity, "tools/call", { name, arguments: args });
}

export async function createMcpRow(
  table: McpTable,
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<string> {
  // A relationship exposed by an MCP entity may target a readable entity
  // that intentionally has no MCP mutation projection of its own. Seed that
  // dependency through the shared database fixture instead of inventing a
  // tool the catalog does not advertise.
  if (!table.source?.mcp || !isCanonical(table)) {
    return createRow(table, identity, overrides, depth);
  }
  const created = await callTool(
    identity,
    toolNameFor(table, "create"),
    argsFor(table, await createArgs(table, identity, overrides, depth)),
  );
  expect(toolError(created.body)).toBeUndefined();
  const row = toolPayload(created.body);
  expect(row?.id).toBeTruthy();
  createdRows.push({ table, id: row.id, identity });
  return row.id;
}

/** Create arguments for the table's create: columns, or the plugin's own contract. */
export async function createArgs(
  table: McpTable,
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<Record<string, unknown>> {
  if (!isEntityBackedCreate(table)) return pluginCreateInput(table, identity, overrides, depth);
  return { ...(await buildCreateArgs(table, identity, depth)), ...overrides };
}

/** The property schemas one entity's create advertises, keyed by property name. */
export function createSchemaProperties(
  table: McpTable,
): Record<string, { enum?: unknown[]; maxLength?: number; pattern?: string }> {
  const tool = catalogTool(table, "create");
  return (
    (tool.inputSchema as { properties?: Record<string, { enum?: unknown[]; maxLength?: number; pattern?: string }> })
      .properties ?? {}
  );
}

/** Sample create arguments: required scalars plus real rows for required FKs.
 * Values respect the tool schema — the server now enforces what it
 * advertises, so an enum field gets an allowed value, not a marker string. */
export async function buildCreateArgs(
  table: McpTable,
  identity: Identity,
  depth = 0,
): Promise<Record<string, unknown>> {
  if (depth > 5) throw new Error(`MCP FK dependency chain too deep while creating ${table.name}`);
  const fkTargets = foreignKeyTargets(table);
  const properties = createSchemaProperties(table);
  const marker = nextMarker();
  const args: Record<string, unknown> = {};
  for (const column of table.columns) {
    if (!column.required || !isMutableColumn(column)) continue;
    const target = fkTargets.get(column.name);
    if (target) {
      args[fieldName(column)] = await createForeignKeyTarget(target, identity, depth + 1);
      continue;
    }
    args[fieldName(column)] = schemaSample(column, properties[fieldName(column)], marker);
  }
  return args;
}

/**
 * A row for a foreign-key target: through MCP when the target's create is
 * MCP-projected (so the dependency is exercised on this transport too),
 * otherwise through the factory.
 */
export async function createForeignKeyTarget(
  target: string,
  identity: Identity,
  depth = 1,
): Promise<string> {
  const fullCrudTarget = tablesByName.get(target);
  if (fullCrudTarget?.source?.graphql && !isCanonical(fullCrudTarget)) {
    return createRow(fullCrudTarget, identity);
  }

  const mcpTarget = mcpCreateTables.find(
    (candidate) => candidate.name === target && candidate.source?.mcp?.operations.create,
  );
  if (!mcpTarget) throw new Error(`MCP FK target ${target} has no create operation`);
  const dependency = await callTool(
    identity,
    toolNameFor(mcpTarget, "create"),
    argsFor(mcpTarget, await createArgs(mcpTarget, identity, {}, depth)),
  );
  expect(toolError(dependency.body)).toBeUndefined();
  const row = toolPayload(dependency.body);
  expect(row?.id).toBeTruthy();
  createdRows.push({ table: mcpTarget, id: row.id, identity });
  return row.id;
}

