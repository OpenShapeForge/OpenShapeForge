// SPDX-License-Identifier: BUSL-1.1
/**
 * Generated MCP e2e suite — the MCP counterpart of the REST and GraphQL
 * entity-crud suites. Drives the harness's in-process API app (runtime
 * modules loaded once per process) via inject(), or E2E_API_URL over HTTP
 * when set, speaking JSON-RPC over the Streamable HTTP transport at /api/mcp.
 *
 * Row setup/cleanup reuses the shared GraphQL harness, so all three transports
 * are exercised against the same data and RLS session plumbing.
 *
 * Contract-driven: a dedicated entity owns `<prefix>_<op>` tools, a generic
 * one shares the `osf_<op>` tools and names itself through the `entity`
 * argument (toolNameFor/argsFor); which controls a mutation needs and whether
 * a create is entity- or plugin-backed come from the Operation catalog via
 * e2e/operations.ts.
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import Ajv2020 from "ajv/dist/2020.js";
import catalog from "../../generated/mcp/tools.json" with { type: "json" };
import {
  createRow,
  eligibleTables,
  fieldName,
  foreignKeyTargets,
  nextMarker,
  pluginCreateInput,
  sampleValue,
  tables,
  tablesByName,
  untrackRow,
} from "../../graphql/__tests__/e2e/entity-factory.js";
import {
  challengeAnswerFor,
  isCanonical,
  isEntityBackedCreate,
  leaseRequired,
  operationIdFor,
} from "../../graphql/__tests__/e2e/operations.js";
import {
  apiApp,
  createdRows,
  describe,
  type Identity,
  noRoles,
  readOnly,
  registerSuiteLifecycle,
  remoteUrl,
  seed,
  tenantA,
  tenantB,
  test,
} from "../../graphql/__tests__/e2e/harness.js";
import {
  __entityMutationControlsForTests,
  MCP_MOUNT_PATH,
} from "../generated-mcp-server.js";

registerSuiteLifecycle();

test("MCP forwards every canonical mutation control, including update challenges", () => {
  expect(__entityMutationControlsForTests({
    expectedVersion: "2026-09-11T15:15:00.000Z",
    leaseToken: "lease",
    confirmed: true,
    confirmationToken: "challenge",
    confirmationAnswer: "Current name",
    ignored: "not-a-control",
  })).toEqual({
    expectedVersion: "2026-09-11T15:15:00.000Z",
    leaseToken: "lease",
    confirmed: true,
    confirmationToken: "challenge",
    confirmationAnswer: "Current name",
  });
});

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;

let nextRpcId = 1;

/**
 * One JSON-RPC call over the Streamable HTTP transport. This helper uses the
 * sessionless compatibility path, so each request is self-contained; real
 * elicitation and MCP Apps clients initialize a stateful session. `Accept`
 * must list both content types the transport can answer with, or the request is
 * rejected before dispatch.
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
function toolEnvelope(body: any): any {
  const text = body?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

/** Normalize strict-v2 envelopes and legacy-v1 payloads for shared assertions. */
function toolPayload(body: any): any {
  const envelope = toolEnvelope(body);
  const canonical = envelope && Object.hasOwn(envelope, "data");
  const data = canonical ? envelope.data : envelope;
  if (canonical && Array.isArray(data?.items)) {
    return { ...data, items: data.items.map((item: any) => item.data) };
  }
  return data;
}

function toolError(body: any): string | undefined {
  if (body?.result?.isError !== true) return undefined;
  return body?.result?.content?.[0]?.text;
}

type McpTable = (typeof tables)[number];
type CrudOperation = "list" | "get" | "create" | "update" | "delete";

/** `<prefix>_<op>` for a dedicated entity, the shared `osf_<op>` for a generic one. */
function toolNameFor(table: McpTable, operation: CrudOperation): string {
  const mcp = table.source!.mcp!;
  return mcp.tools === "generic" ? `osf_${operation}` : `${mcp.toolPrefix}_${operation}`;
}

/** A generic tool call names its entity; a dedicated tool must not. */
function argsFor(table: McpTable, args: Record<string, unknown>): Record<string, unknown> {
  return table.source!.mcp!.tools === "generic"
    ? { entity: table.source!.authoringEntityName, ...args }
    : args;
}

/** Whether `identity` holds a role the entity's operation allow-list names. */
function sessionMayInvoke(identity: Identity, entity: string, operation: CrudOperation): boolean {
  const roles = eligibleTables.find((table) => table.source?.authoringEntityName === entity)
    ?.source?.authorization?.roles;
  const allowed = roles?.[operation === "list" || operation === "get" ? "read" : operation] ?? [];
  return allowed.some((role) => identity.roles.includes(role));
}

/** Transport controls a create or update schema advertises next to the authored fields. */
const MUTATION_CONTROLS = new Set([
  "blueprintId",
  "expectedVersion",
  "leaseToken",
  "confirmed",
  "confirmationToken",
  "confirmationAnswer",
]);

function authoredKeys(properties: Record<string, unknown>): string[] {
  return Object.keys(properties).filter((key) => !MUTATION_CONTROLS.has(key));
}

/** The compiled catalog entry for one entity's operation — loud when absent. */
function catalogTool(table: McpTable, operation: CrudOperation) {
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
 * own for a dedicated entity, the entity's `anyOf` branch (minus the `entity`
 * selector) for a generic one. Throws when the listing omits it, so a test
 * that expected the tool sees why instead of a property read on undefined.
 */
function advertisedSchema(
  tools: { name: string; inputSchema: any }[],
  table: McpTable,
  operation: CrudOperation,
): any {
  const name = toolNameFor(table, operation);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`The session was not offered ${name}.`);
  if (table.source!.mcp!.tools !== "generic") return tool.inputSchema;
  const entity = table.source!.authoringEntityName;
  const branch = (tool.inputSchema.anyOf as any[] | undefined)?.find(
    (candidate) => candidate.properties?.entity?.const === entity,
  );
  if (!branch) throw new Error(`${name} advertises no ${entity} branch to this session.`);
  const { entity: _selector, ...properties } = branch.properties;
  return {
    ...branch,
    properties,
    required: (branch.required as string[]).filter((key) => key !== "entity"),
  };
}

async function acquireLease(
  table: McpTable,
  identity: Identity,
  row: Record<string, unknown>,
  intent: "update" | "delete",
): Promise<Record<string, string>> {
  if (!leaseRequired(table, intent)) return {};
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

const outputAjv = new Ajv2020.default({
  strict: false,
  validateFormats: false,
});
const outputValidators = new Map<string, ReturnType<typeof outputAjv.compile>>();

function expectCanonicalToolOutput(table: McpTable, operation: CrudOperation, body: any): void {
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
function withoutPluginOffers(structured: any): any {
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

function resourcePayload(body: any): any {
  const text = body?.result?.contents?.[0]?.text;
  return text ? JSON.parse(text) : undefined;
}

const mcpTables = tables.filter((table) => table.source?.mcp);
const mcpCreateTables = eligibleTables.filter(
  (table) => table.source?.mcp?.operations.create,
);
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

async function createMcpRow(
  table: McpTable,
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<string> {
  if (!isCanonical(table)) return createRow(table, identity, overrides, depth);
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
async function createArgs(
  table: McpTable,
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<Record<string, unknown>> {
  if (!isEntityBackedCreate(table)) return pluginCreateInput(table, identity, overrides, depth);
  return { ...(await buildCreateArgs(table, identity, depth)), ...overrides };
}

/** The property schemas one entity's create advertises, keyed by property name. */
function createSchemaProperties(
  table: McpTable,
): Record<string, { enum?: unknown[]; maxLength?: number }> {
  const tool = catalogTool(table, "create");
  return (
    (tool.inputSchema as { properties?: Record<string, { enum?: unknown[]; maxLength?: number }> })
      .properties ?? {}
  );
}

/**
 * A sample the advertised schema accepts: an allowed enum value, else the
 * column sample cut to the advertised length (a three-letter currency code
 * cannot carry a marker). The server enforces what it advertises.
 */
function schemaSample(
  column: (typeof tables)[number]["columns"][number],
  schema: { enum?: unknown[]; maxLength?: number } | undefined,
  marker: string,
): unknown {
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) return schema.enum[0];
  const sample = sampleValue(column, marker);
  return typeof sample === "string" && schema?.maxLength !== undefined
    ? sample.slice(0, schema.maxLength)
    : sample;
}

/** Sample create arguments: required scalars plus real rows for required FKs.
 * Values respect the tool schema — the server now enforces what it
 * advertises, so an enum field gets an allowed value, not a marker string. */
async function buildCreateArgs(
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
    if (!column.required || column.primaryKey) continue;
    if (["tenant_id", "created_at", "updated_at"].includes(column.name)) continue;
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
async function createForeignKeyTarget(
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

describe("generated MCP server", () => {
  test("rejects an unauthenticated request", async () => {
    const { status } = await rpc(null, "tools/list");
    expect(status).toBe(401);
  });

  test("advertises the compiled tool catalog to an authorized session", async () => {
    const { status, body } = await rpc(tenantA, "tools/list");
    expect(status).toBe(200);
    const tools = body.result.tools as {
      name: string;
      outputSchema?: Record<string, unknown>;
      annotations?: { idempotentHint?: boolean };
    }[];
    const names = tools.map((tool) => tool.name);
    const compiledNames = new Set(catalog.tools.map((tool) => tool.name));
    // The listing is authorized and deduplicated: a tool the session holds no
    // role for is withheld, and generic entities share one name the session
    // sees once. The expectation applies the same two rules to the catalog.
    expect(names.filter((name) => compiledNames.has(name))).toEqual([
      ...new Set(
        catalog.tools
          .filter((tool) => sessionMayInvoke(tenantA, tool.entity, tool.operation as CrudOperation))
          .map((tool) => tool.name),
      ),
    ]);

    const advertisedFor = (
      operation: "list" | "get" | "create" | "update" | "delete",
      entity?: string,
    ) => {
      const compiled = catalog.tools.find(
        (tool) => (!entity || tool.entity === entity) && tool.operation === operation,
      );
      return tools.find((tool) => tool.name === compiled?.name);
    };
    const get = advertisedFor("get", "Relation")!;
    const list = advertisedFor("list", "Relation")!;
    const create = advertisedFor("create", "Relation")!;
    const remove = advertisedFor("delete")!;
    const update = advertisedFor("update")!;
    const canonicalTools = [get, list, create].filter(
      (tool) => tool.outputSchema !== undefined,
    );
    for (const tool of canonicalTools) {
      expect(tool.outputSchema?.type).toBe("object");
      expect(Array.isArray(tool.outputSchema?.oneOf)).toBe(true);
      const definitions = tool.outputSchema?.$defs as Record<string, unknown>;
      expect(definitions.OperationOffer).toBeDefined();
      expect(definitions.OperationError).toBeDefined();
    }
    const legacyNames = new Set(
      catalog.tools
        .filter((tool) => tool.outputSchema === undefined)
        .map((tool) => tool.name),
    );
    expect(
      tools.filter((tool) => legacyNames.has(tool.name))
        .every((tool) => tool.outputSchema === undefined),
    ).toBe(true);
    const getSuccess = (get.outputSchema!.oneOf as Record<string, unknown>[])[0]!;
    const getProperties = getSuccess.properties as Record<string, Record<string, unknown>>;
    expect(getSuccess.required).toEqual(["data", "operations"]);
    expect(getProperties.data?.type).toBe("object");
    expect(getProperties.operations?.type).toBe("array");
    const listSuccess = (list.outputSchema!.oneOf as Record<string, unknown>[])[0]!;
    expect(listSuccess).toMatchObject({
      properties: {
        data: {
          required: ["items", "totalCount", "nextCursor"],
        },
      },
    });
    // A canonical delete answers with the deletion envelope: `data.deleted`
    // is the constant true (a missing row is an error, never `deleted: false`).
    const removeSuccess = (remove.outputSchema!.oneOf as Record<string, unknown>[])[0]!;
    expect(removeSuccess.required).toEqual(["data", "operations"]);
    expect(removeSuccess.properties).toMatchObject({
      data: { required: ["deleted"], properties: { deleted: { type: "boolean", const: true } } },
    });
    expect(update.annotations?.idempotentHint).toBe(false);
  });

  test("binds, authorizes and dispatches a canonical operation tool", async () => {
    const listed = await rpc(workflowOperator, "tools/list");
    expect(listed.status).toBe(200);
    const tools = listed.body.result.tools as { name: string; inputSchema: unknown }[];
    expect(tools).toContainEqual(expect.objectContaining({
      name: "osf_search_operations",
      inputSchema: expect.objectContaining({ type: "object" }),
    }));

    const searched = await callTool(workflowOperator, "osf_search_operations", {
      query: "webhook",
      limit: 20,
    });
    expect(toolEnvelope(searched.body)).toMatchObject({
      operations: [{ operation: { id: "workflow.instance.webhook-start" } }],
    });

    const called = await callTool(workflowOperator, "osf_execute_operation", {
      operationId: "workflow.instance.webhook-start",
      input: { definitionId: randomUUID() },
      idempotencyKey: randomUUID(),
    });
    // The Operation is keyed and declares an external write, so the runtime
    // records a running receipt and marks effects admitted BEFORE it invokes
    // the handler (operations/runtime.ts, execute); the handler's NOT_FOUND
    // for a definition that never existed therefore surfaces fail-closed as
    // OPERATION_OUTCOME_UNKNOWN. That is the dispatch this test proves. (It
    // used to read NOT_FOUND only because the receipt insert failed on an
    // unseeded platform.tenants row — REFERENCE_NOT_FOUND matched the regex.)
    expect(toolError(called.body)).toMatch(/OPERATION_OUTCOME_UNKNOWN/);
  });

  test("carries the authored field schema into the tool input schema", async () => {
    const { body } = await rpc(tenantA, "tools/list");
    const tools = body.result.tools as {
      name: string;
      title?: string;
      description: string;
      inputSchema: any;
    }[];
    const create = tools.find((tool) => tool.name === "relation_create");
    expect(create).toBeDefined();
    expect(create!.title).toBe("Create relation");
    expect(create!.description).toContain("Creates one relation after validating");
    expect(create!.description).toContain("Ask for missing required fields");
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

  test("scopes edit-lease acquire to authorized MCP-projected operations", async () => {
    const { body } = await rpc(tenantA, "tools/list");
    const acquire = (body.result.tools as { name: string; inputSchema: any }[]).find(
      (tool) => tool.name === "osf_acquire_edit_lease",
    );
    expect(acquire).toBeDefined();
    // The enum is the session's lease surface: every lease-protected,
    // MCP-projected mutation its roles reach — derived here from the same
    // contracts, so a converted entity extends it without a test edit. Plugin
    // Operations (blueprint commands) join it too, so the entity set is a
    // lower bound; a read never appears.
    const leaseProtected = mcpTables.flatMap((table) =>
      (["update", "delete"] as const)
        .filter((intent) => leaseRequired(table, intent) && table.source!.mcp!.operations[intent])
        .map((intent) => operationIdFor(table, intent)),
    );
    expect(leaseProtected).toContain("Relation.update");
    const offered = acquire!.inputSchema.properties.operationId.enum as string[];
    expect(offered).toEqual(expect.arrayContaining(leaseProtected));
    expect(offered.filter((id) => id.endsWith(".get") || id.endsWith(".list"))).toEqual([]);

    const hidden = await rpc(noRoles, "tools/list");
    expect(hidden.body.result.tools.map((tool: any) => tool.name)).not.toContain(
      "osf_acquire_edit_lease",
    );
    expect(hidden.body.result.tools.map((tool: any) => tool.name)).toContain(
      "osf_release_edit_lease",
    );

    const guessed = await callTool(tenantA, "osf_acquire_edit_lease", {
      operationId: "PaymentDetail.update",
      targetId: randomUUID(),
    });
    expect(toolError(guessed.body)).toMatch(/NOT_FOUND/);
  });

  test("refuses lease renewal after role revocation but still permits cleanup", async () => {
    const relation = mcpCreateTables.find(
      (table) => table.source?.authoringEntityName === "Relation",
    )!;
    const id = await createMcpRow(relation, tenantA);
    const acquired = await callTool(tenantA, "osf_acquire_edit_lease", {
      operationId: "Relation.update",
      targetId: id,
    });
    expect(toolError(acquired.body)).toBeUndefined();
    const leaseToken = toolPayload(acquired.body).leaseToken as string;
    const revoked = { ...tenantA, roles: [] };

    const renewal = await callTool(revoked, "osf_renew_edit_lease", {
      leaseToken,
    });
    expect(toolError(renewal.body)).toMatch(/NOT_FOUND/);

    const release = await callTool(revoked, "osf_release_edit_lease", {
      leaseToken,
    });
    expect(toolError(release.body)).toBeUndefined();
    expect(toolPayload(release.body)).toEqual({ released: true });
  });

  test("returns invalid expectedVersion as a canonical field validation error", async () => {
    const refused = await callTool(tenantA, "relation_update", {
      id: randomUUID(),
      values: {},
      expectedVersion: "2026-02-30T12:00:00.000Z",
      leaseToken: "not-used-because-version-validation-runs-first",
    });
    expect(toolError(refused.body)).toMatch(/VALIDATION/);
    expect(refused.body.result.structuredContent.error).toMatchObject({
      code: "VALIDATION",
      retryable: false,
      violations: [
        {
          field: "expectedVersion",
          code: "INVALID_DATETIME",
        },
      ],
    });
  });

  test("returns invalid mutation control types as canonical field validation errors", async () => {
    const refused = await callTool(tenantA, "relation_delete", {
      id: randomUUID(),
      expectedVersion: new Date().toISOString(),
      leaseToken: "not-used-because-control-validation-runs-first",
      confirmationToken: false,
    });
    expect(toolError(refused.body)).toMatch(/VALIDATION/);
    expect(refused.body.result.structuredContent.error).toMatchObject({
      code: "VALIDATION",
      retryable: false,
      violations: [
        {
          field: "confirmationToken",
          code: "INVALID_TYPE",
        },
      ],
    });
  });

  test("publishes Relation records and their interface-bound operation offers", async () => {
    const relation = mcpCreateTables.find(
      (table) => table.source?.authoringEntityName === "Relation",
    )!;
    const created = await callTool(
      tenantA,
      "relation_create",
      await buildCreateArgs(relation, tenantA),
    );
    expect(toolError(created.body)).toBeUndefined();
    const envelope = toolEnvelope(created.body);
    const id = envelope.data.id as string;
    createdRows.push({ table: relation, id, identity: tenantA });
    expect(envelope.operations).toHaveLength(3);
    expect(envelope.operations.map((offer: any) => offer.operation.id)).toEqual(
      expect.arrayContaining(["Relation.get", "Relation.update", "Relation.delete"]),
    );

    const listed = await rpc(tenantA, "resources/list");
    expect(listed.body.result.resources).toContainEqual(
      expect.objectContaining({ uri: "app://relations" }),
    );
    const templates = (await rpc(tenantA, "resources/templates/list")).body.result
      .resourceTemplates as { uriTemplate: string }[];
    expect(templates).toContainEqual(
      expect.objectContaining({ uriTemplate: "app://relations/{id}" }),
    );

    const record = resourcePayload(
      (await rpc(tenantA, "resources/read", { uri: `app://relations/${id}` })).body,
    );
    expect(record.data.id).toBe(id);
    expect(record.operations).toHaveLength(3);
    expect(record.operations.map((offer: any) => offer.operation.id)).toEqual(
      expect.arrayContaining(["Relation.get", "Relation.update", "Relation.delete"]),
    );
  });

  test("exposes the authorized YAML-derived entity catalog as MCP resources", async () => {
    const { status, body } = await rpc(tenantA, "resources/list");
    expect(status).toBe(200);
    const resources = body.result.resources as { uri: string; title: string }[];
    expect(resources.map((resource) => resource.uri)).toContain("osf://schema/entities");
    // The listing is authorized: an entity whose read roles the session does
    // not hold (a read-only projection outside the write vocabulary) is not
    // advertised, so the expectation is the catalog filtered by the same rule.
    const readable = catalog.entities.filter((entity) => {
      const roles = eligibleTables.find(
        (table) => table.source?.authoringEntityName === entity.entity,
      )?.source?.authorization?.roles?.read;
      return roles?.some((role) => tenantA.roles.includes(role)) === true;
    });
    expect(readable.length).toBeGreaterThan(0);
    expect(
      resources
        .map((resource) => resource.uri)
        .filter((uri) => uri.startsWith("osf://schema/entities/")),
    ).toEqual(readable.map((entity) => `osf://schema/entities/${entity.slug}`));

    const index = resourcePayload(
      (await rpc(tenantA, "resources/read", { uri: "osf://schema/entities" })).body,
    );
    expect(index.entities.map((entity: any) => entity.entity)).toEqual(
      readable.map((entity) => entity.entity),
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
    const uris = listed.body.result.resources.map((resource: any) => resource.uri);
    expect(uris).toContain("osf://schema/entities");
    expect(uris.filter((uri: string) => uri.startsWith("osf://schema/entities/"))).toEqual([]);
    const denied = await rpc(noRoles, "resources/read", {
      uri: `osf://schema/entities/${catalog.entities[0]!.slug}`,
    });
    expect(denied.body.error.code).toBe(-32602);
  });

  test("answers optional MCP catalogs without protocol errors", async () => {
    expect((await rpc(tenantA, "prompts/list")).body.result.prompts).toEqual([]);
    const templates = (await rpc(tenantA, "resources/templates/list")).body.result
      .resourceTemplates as { uriTemplate: string }[];
    expect(templates).toContainEqual(
      expect.objectContaining({ uriTemplate: "osf://onboarding/step/{step}" }),
    );
  });

  test("annotates read-only and destructive tools", async () => {
    const { body } = await rpc(tenantA, "tools/list");
    const tools = body.result.tools as { name: string; annotations: any }[];
    const listName = catalog.tools.find((tool) => tool.operation === "list")!.name;
    const deleteName = catalog.tools.find((tool) => tool.operation === "delete")!.name;
    expect(tools.find((t) => t.name === listName)!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === deleteName)!.annotations.destructiveHint).toBe(
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

  test("advertises no generated entity tools to a session with no roles", async () => {
    const { body } = await rpc(noRoles, "tools/list");
    const names = (body.result.tools as { name: string }[]).map((tool) => tool.name);
    const compiledNames = new Set(catalog.tools.map((tool) => tool.name));
    expect(names.filter((name) => compiledNames.has(name))).toEqual([]);
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
    const call = (
      identity: Identity,
      operation: CrudOperation,
      args: Record<string, unknown> = {},
    ) => callTool(identity, toolNameFor(table, operation), argsFor(table, args));
    const canonical = catalogTool(table, "create").outputSchema !== undefined;

    test(`${prefix}: create, get, list, update, delete round-trip`, async () => {
      const args = await createArgs(table, tenantA);
      const created = await call(tenantA, "create", args);
      const createdEnvelope = toolEnvelope(created.body);
      let row = toolPayload(created.body);
      expect(toolError(created.body)).toBeUndefined();
      if (canonical) {
        expectCanonicalToolOutput(table, "create", created.body);
        expect(createdEnvelope.operations.every((offer: any) => offer.available)).toBe(true);
      } else {
        expect(createdEnvelope).not.toHaveProperty("data");
        expect(createdEnvelope).not.toHaveProperty("operations");
      }
      expect(row.id).toBeTruthy();
      createdRows.push({ table, id: row.id, identity: tenantA });

      const fetchedCall = await call(tenantA, "get", { id: row.id });
      if (canonical) expectCanonicalToolOutput(table, "get", fetchedCall.body);
      const fetched = toolPayload(fetchedCall.body);
      expect(fetched.id).toBe(row.id);
      row = fetched;

      const listedCall = await call(tenantA, "list", { first: 5 });
      if (canonical) expectCanonicalToolOutput(table, "list", listedCall.body);
      const listed = toolPayload(listedCall.body);
      expect(Array.isArray(listed.items)).toBe(true);
      expect(listed.totalCount).toBeGreaterThan(0);

      const textColumn = table.columns.find(
        (column) =>
          column.type === "text" &&
          !column.primaryKey &&
          !["tenant_id", "created_at", "updated_at"].includes(column.name),
      );
      if (textColumn) {
        const controls = await acquireLease(table, tenantA, row, "update");
        const updatedCall = await call(tenantA, "update", {
          id: row.id,
          values: { [fieldName(textColumn)]: `updated-${seed}` },
          ...controls,
        });
        if (canonical) expectCanonicalToolOutput(table, "update", updatedCall.body);
        expect(toolError(updatedCall.body)).toBeUndefined();
        const updated = toolPayload(updatedCall.body);
        expect(updated[fieldName(textColumn)]).toBe(`updated-${seed}`);
        row = updated;
      }

      const lease = await acquireLease(table, tenantA, row, "delete");
      let deleteControls: Record<string, string> = { ...lease };
      const first = await call(tenantA, "delete", { id: row.id, ...deleteControls });
      let deleted = first;
      if (toolError(first.body)?.includes("CONFIRMATION_REQUIRED")) {
        // A challenge-protected delete answers first with the challenge; the
        // answer is the record's current value of the authored field.
        const error = first.body.result.structuredContent.error;
        expect(error.retryAt).toBeUndefined();
        expect(error.data.confirmation.expiresAt).toBeString();
        deleteControls = {
          ...lease,
          confirmationToken: error.data.confirmation.challengeToken,
          confirmationAnswer: challengeAnswerFor(table, "delete", row),
        };
        deleted = await call(tenantA, "delete", { id: row.id, ...deleteControls });
      }

      if (!isEntityBackedCreate(table)) {
        // A plugin-backed create makes companion records the entity delete is
        // authored to refuse while they exist (a document and its first
        // version); removing them is the plugin's own contract.
        expect(toolError(deleted.body)).toMatch(/REFERENCE_IN_USE/);
        return;
      }
      if (canonical) expectCanonicalToolOutput(table, "delete", deleted.body);
      expect(toolError(deleted.body)).toBeUndefined();
      expect(toolPayload(deleted.body)).toEqual({ deleted: true });
      untrackRow(row.id);

      const missing = await call(tenantA, "get", { id: row.id });
      if (canonical) expectCanonicalToolOutput(table, "get", missing.body);
      expect(toolError(missing.body)).toMatch(/NOT_FOUND/);
      const missingError = missing.body.result.structuredContent.error;
      if (canonical) {
        expect(missingError).toMatchObject({
          code: "NOT_FOUND",
          message: "Resource not found.",
          retryable: false,
        });
      } else {
        expect(missingError).toEqual({
          code: "NOT_FOUND",
          message: "Resource not found.",
        });
      }
    });

    test(`${prefix}: does not leak rows across tenants`, async () => {
      const createdId = await createMcpRow(table, tenantA);
      const other = await call(tenantB, "get", { id: createdId });
      expect(toolError(other.body)).toMatch(/NOT_FOUND/);
    });

    if (isEntityBackedCreate(table)) {
      test(`${prefix}: rejects a create argument the tool schema does not declare`, async () => {
        // The schema says additionalProperties:false; the server must agree.
        const { body } = await call(tenantA, "create", { definitelyNotAField: "x" });
        expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
        expect(toolError(body)).toMatch(/definitelyNotAField/);
      });

      test(`${prefix}: rejects a server-managed field on create`, async () => {
        // Silently dropping `id` would let a model believe it chose the id.
        const { body } = await call(tenantA, "create", {
          id: "00000000-0000-0000-0000-000000000001",
        });
        expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
        expect(toolError(body)).toMatch(/\bid\b/);
      });
    }

    test(`${prefix}: rejects an undeclared field inside update values`, async () => {
      const createdId = await createMcpRow(table, tenantA);
      const { body } = await call(tenantA, "update", {
        id: createdId,
        values: { definitelyNotAField: "x" },
      });
      expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
    });

    test(`${prefix}: rejects an unknown filter field`, async () => {
      const { body } = await call(tenantA, "list", {
        filter: { definitelyNotAField: "x" },
      });
      expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
    });

    /**
     * Relationship keys: every `belongsTo` foreign key the manifest emits a
     * reference for is a `<key>Id` the compiler now advertises on create,
     * update.values and list.filter — the same key REST and GraphQL accept.
     * The manifest is the oracle for which keys exist; the tool schema must
     * agree with it, and the server must honour what the schema advertises.
     * Required keys are already satisfied by buildCreateArgs; this exercises
     * the optional ones a model would otherwise have no way to set. A
     * plugin-backed create advertises its own contract, so only the update
     * and filter halves apply to it.
     */
    const relationshipKeys = table.columns.filter((column) => {
      if (column.primaryKey || column.required) return false;
      const target = foreignKeyTargets(table).get(column.name);
      return target !== undefined && tablesByName.has(target);
    });

    for (const column of relationshipKeys) {
      const key = fieldName(column);
      const targetTable = tablesByName.get(foreignKeyTargets(table).get(column.name)!)!;
      const onCreate = isEntityBackedCreate(table);

      test(`${prefix}: advertises ${key} as a uuid on ${onCreate ? "create, " : ""}update and filter`, async () => {
        const { body } = await rpc(tenantA, "tools/list");
        const tools = body.result.tools as { name: string; inputSchema: any }[];
        const update = advertisedSchema(tools, table, "update");
        const list = advertisedSchema(tools, table, "list");
        if (onCreate) {
          const create = advertisedSchema(tools, table, "create");
          expect(create.properties[key]).toMatchObject({ type: "string", format: "uuid" });
        }
        expect(list.properties.filter.properties[key]).toMatchObject({
          type: "string",
          format: "uuid",
        });
        if (column.immutable) {
          expect(update.properties.values.properties).not.toHaveProperty(key);
        } else {
          expect(update.properties.values.properties[key]).toMatchObject({
            type: "string",
            format: "uuid",
          });
        }
      });

      test(`${prefix}: accepts ${key} on create and filters the list by it`, async () => {
        const targetId = await createMcpRow(targetTable, tenantA);
        const created = await call(tenantA, "create", await createArgs(table, tenantA, { [key]: targetId }));
        expect(toolError(created.body)).toBeUndefined();
        const row = toolPayload(created.body);
        createdRows.push({ table, id: row.id, identity: tenantA });
        expect(row[key]).toBe(targetId);

        const listed = toolPayload(
          (await call(tenantA, "list", { filter: { [key]: targetId } })).body,
        );
        expect(listed.items.map((item: any) => item.id)).toContain(row.id);
        for (const item of listed.items) expect(item[key]).toBe(targetId);

        if (!column.immutable) {
          const otherId = await createMcpRow(targetTable, tenantA);
          const controls = await acquireLease(table, tenantA, row, "update");
          const updated = toolPayload(
            (
              await call(tenantA, "update", {
                id: row.id,
                values: { [key]: otherId },
                ...controls,
              })
            ).body,
          );
          expect(updated[key]).toBe(otherId);
        }
      });

      test(`${prefix}: refuses ${key} that names no ${targetTable.name} row`, async () => {
        // The foreign key constraint is what refuses this, so the answer is the
        // redacted driver-error shape rather than a validation code — the same
        // answer REST gives for the same body. The row must not exist after.
        const bogus = randomUUID();
        const { body } = await call(tenantA, "create", await createArgs(table, tenantA, { [key]: bogus }));
        expect(toolError(body)).toBeDefined();
        const listed = toolPayload(
          (await call(tenantA, "list", { filter: { [key]: bogus } })).body,
        );
        expect(listed.items).toEqual([]);
      });

      test(`${prefix}: a filter on ${key} never shows another tenant's rows`, async () => {
        // The filter is not an oracle across tenants: the value is another
        // tenant's real key, and row security answers with nothing, exactly as
        // a list without the filter would.
        const foreignTargetId = await createMcpRow(targetTable, tenantB);
        const created = await call(
          tenantB,
          "create",
          await createArgs(table, tenantB, { [key]: foreignTargetId }),
        );
        expect(toolError(created.body)).toBeUndefined();
        const foreignRow = toolPayload(created.body);
        createdRows.push({ table, id: foreignRow.id, identity: tenantB });

        const listed = toolPayload(
          (await call(tenantA, "list", { filter: { [key]: foreignTargetId } })).body,
        );
        expect(listed.items).toEqual([]);
      });
    }

    /**
     * Authored `immutable` over MCP (#177). The advertised schema and the
     * server's answer come from the same authored fact, so a model that reads
     * the catalog and a model that guesses both learn the same rule. A table
     * with no immutable column asserts the unaffected case: create and update
     * advertise the same properties. A plugin-backed create advertises its
     * own contract, so only the update half is comparable for it.
     */
    const immutableFields = table.columns.filter((column) => column.immutable).map(fieldName);
    const immutable = table.columns.find((column) => column.immutable);
    const offeredOnCreate = isEntityBackedCreate(table);

    test(`${prefix}: the update schema ${immutable ? "withholds" : "matches create on"} immutable fields`, async () => {
      const { body } = await rpc(tenantA, "tools/list");
      const tools = body.result.tools as { name: string; inputSchema: any }[];
      const update = advertisedSchema(tools, table, "update");
      // Authored fields only: a create may also offer a blueprint control,
      // an update its version and lease controls.
      const updatable = authoredKeys(update.properties.values.properties);

      if (!immutable) {
        if (offeredOnCreate) {
          const create = advertisedSchema(tools, table, "create");
          expect(updatable).toEqual(authoredKeys(create.properties));
        }
        return;
      }
      for (const field of immutableFields) expect(updatable).not.toContain(field);
      if (offeredOnCreate) {
        const creatable = authoredKeys(advertisedSchema(tools, table, "create").properties);
        for (const field of immutableFields) expect(creatable).toContain(field);
        expect(updatable).toEqual(creatable.filter((key) => !immutableFields.includes(key)));
      }
    });

    if (immutable) {
      const field = fieldName(immutable);
      const fkTarget = foreignKeyTargets(table).get(immutable.name);

      test(`${prefix}: ${offeredOnCreate ? `accepts ${field} on create and ` : ""}refuses ${field} on update`, async () => {
        const valueFor = async () =>
          fkTarget ? createForeignKeyTarget(fkTarget, tenantA) : sampleValue(immutable, nextMarker());
        const created = await call(
          tenantA,
          "create",
          await createArgs(table, tenantA, offeredOnCreate ? { [field]: await valueFor() } : {}),
        );
        expect(toolError(created.body)).toBeUndefined();
        const row = toolPayload(created.body);
        createdRows.push({ table, id: row.id, identity: tenantA });
        const value = row[field];
        if (offeredOnCreate) expect(value).toBeTruthy();

        const { body } = await call(tenantA, "update", {
          id: row.id,
          values: { [field]: await valueFor() },
        });
        expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
        expect(toolError(body)).toMatch(new RegExp(field));

        const after = toolPayload((await call(tenantA, "get", { id: row.id })).body);
        expect(after[field]).toBe(value);
      });
    }
  }
});
