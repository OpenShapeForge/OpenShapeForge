// SPDX-License-Identifier: BUSL-1.1
/**
 * End-to-end proof that the connector surfaces behave over real HTTP.
 *
 * The unit suites cover each module; this one covers the WIRING — that the
 * compiled example contract actually reaches the MCP tool list, the REST
 * catalog and the GraphQL schema of a booted API, with the same authorization
 * answer on each.
 *
 * Subject: the example connector contract in the base authoring layer. It has
 * no implementation package, which is the point — the contract compiles and is
 * advertised while the runtime honestly reports it cannot be run.
 *
 * Needs the compose Postgres up.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { createApiApp } from "../../roles/api.js";
import { MCP_MOUNT_PATH } from "../../mcp/generated-mcp-server.js";
import { listConnectorContracts } from "../catalog.js";
import { CONNECTOR_ADMIN_ROLE, CONNECTOR_READER_ROLE } from "../authorization.js";

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;
const SLUG = "example-object-store";
const LIST_TOOL = "example_object_store_list_objects";
const PUT_TOOL = "example_object_store_put_object";

// Real UUIDs: the session layer enforces the RFC variant nibble, so a
// hand-written 1111-…-1111 is rejected before any query runs.
const TENANT = randomUUID();
const USER = randomUUID();

type Identity = { tenantId: string; userId: string; roles: string[]; groups: string[] };

function identity(roles: string[]): Identity {
  return { tenantId: TENANT, userId: USER, roles, groups: [] };
}

let app: ReturnType<typeof createApiApp> | null = null;
function getApp() {
  app ??= createApiApp(
    process.env.DATABASE_URL ? { databaseUrl: process.env.DATABASE_URL } : {},
  );
  return app;
}

afterAll(async () => {
  await app?.close();
  app = null;
});

function headersFor(who: Identity | null, extra: Record<string, string> = {}) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  if (who) applyTrustedContextHeaders(headers, who, { secret: SECRET });
  return Object.fromEntries(headers.entries());
}

let nextRpcId = 1;
async function rpc(who: Identity | null, method: string, params?: Record<string, unknown>) {
  const response = await getApp().inject({
    method: "POST",
    url: MCP_MOUNT_PATH,
    headers: headersFor(who, {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    }),
    payload: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, ...(params ? { params } : {}) }),
  });
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  };
}

async function rest(who: Identity | null, method: string, url: string, body?: unknown) {
  return getApp().inject({
    method: method as "GET",
    url,
    headers: headersFor(who, { "content-type": "application/json" }),
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function graphql(who: Identity | null, query: string) {
  const response = await getApp().inject({
    method: "POST",
    url: "/api/graphql",
    headers: headersFor(who, { "content-type": "application/json" }),
    payload: JSON.stringify({ query }),
  });
  return JSON.parse(response.body);
}

function toolNames(body: { result?: { tools?: { name: string }[] } }): string[] {
  return (body.result?.tools ?? []).map((tool) => tool.name);
}

describe("the example contract compiles into the catalog", () => {
  test("it is present with both operations projected to every surface", () => {
    const contract = listConnectorContracts().find((entry) => entry.slug === SLUG);
    expect(contract).toBeDefined();
    expect(contract?.exposure.rest?.basePath).toBe(SLUG);
    expect(contract?.exposure.mcp?.toolPrefix).toBe("example_object_store");
    expect(contract?.operations.map((operation) => operation.key)).toEqual([
      "listObjects",
      "putObject",
    ]);
    // No implementation package ships with it, which is the contract-first
    // property: compiled and advertised, not runnable.
    expect(contract?.implementation.package).toBe(
      "@openshapeforge/connector-example-object-store",
    );
  });

  test("the retry-eligible mutation carries its idempotency declaration", () => {
    const contract = listConnectorContracts().find((entry) => entry.slug === SLUG);
    const put = contract?.operations.find((operation) => operation.key === "putObject");
    expect(put?.reliability.retry.eligible).toBe(true);
    expect(put?.reliability.idempotency).toEqual({
      strategy: "key",
      keyInput: "requestId",
      header: "Idempotency-Key",
    });
    // The overall budget defaults to what three attempts can consume.
    expect(put?.reliability.timeouts).toEqual({ attemptMs: 30_000, totalMs: 90_000 });
  });
});

describe("MCP tools/list is resolved per session", () => {
  test("a read-only session sees the query tool and no mutation tool", async () => {
    const { body } = await rpc(identity(["Connectors.All.Read"]), "tools/list");
    const names = toolNames(body);
    expect(names).toContain(LIST_TOOL);
    expect(names).not.toContain(PUT_TOOL);
  });

  test("a writer sees both", async () => {
    const { body } = await rpc(
      identity(["Connectors.All.Read", "Connectors.All.ReadWrite"]),
      "tools/list",
    );
    const names = toolNames(body);
    expect(names).toContain(LIST_TOOL);
    expect(names).toContain(PUT_TOOL);
  });

  test("a session with no connector roles sees neither", async () => {
    const { body } = await rpc(identity(["Relaties.All.Read"]), "tools/list");
    const names = toolNames(body);
    expect(names).not.toContain(LIST_TOOL);
    expect(names).not.toContain(PUT_TOOL);
  });

  test("the mutation tool is not hinted as safe to repeat without idempotency", async () => {
    const { body } = await rpc(
      identity(["Connectors.All.Read", "Connectors.All.ReadWrite"]),
      "tools/list",
    );
    const put = (body.result?.tools ?? []).find(
      (tool: { name: string }) => tool.name === PUT_TOOL,
    );
    // This contract DOES declare idempotency, so the hint is earned.
    expect(put?.annotations?.idempotentHint).toBe(true);
    expect(put?.annotations?.readOnlyHint).toBe(false);
  });

  test("connector tools carry their own input schema, not a CRUD one", async () => {
    const { body } = await rpc(identity(["Connectors.All.Read"]), "tools/list");
    const list = (body.result?.tools ?? []).find(
      (tool: { name: string }) => tool.name === LIST_TOOL,
    );
    expect(Object.keys(list?.inputSchema?.properties ?? {}).sort()).toEqual([
      "limit",
      "prefix",
    ]);
    expect(list?.inputSchema?.additionalProperties).toBe(false);
  });
});

describe("MCP tools/call cannot be used to enumerate connectors", () => {
  // An unauthorized tool and an unknown one must be indistinguishable.
  test("an unauthorized tool and an unknown tool answer identically", async () => {
    const who = identity(["Connectors.All.Read"]);
    const unauthorized = await rpc(who, "tools/call", { name: PUT_TOOL, arguments: {} });
    const unknown = await rpc(who, "tools/call", { name: "no_such_tool", arguments: {} });

    const text = (result: { body: any }) =>
      JSON.stringify(result.body.result ?? result.body.error ?? {});
    expect(text(unauthorized)).toContain("NOT_FOUND");
    expect(text(unknown)).toContain("NOT_FOUND");
    // Neither answer names the connector.
    expect(text(unauthorized)).not.toContain(SLUG);
  });

  test("an authorized tool reports that it is not executable, not NOT_FOUND", async () => {
    const { body } = await rpc(identity(["Connectors.All.Read"]), "tools/call", {
      name: LIST_TOOL,
      arguments: {},
    });
    // Authorized and known, but no implementation package is loaded — the
    // honest answer, distinct from "no such tool".
    expect(JSON.stringify(body)).toContain("CONNECTOR_NOT_EXECUTABLE");
  });
});

describe("the REST catalog", () => {
  test("requires a connector role", async () => {
    const anonymous = await rest(null, "GET", "/api/rest/v1/connectors");
    expect(anonymous.statusCode).toBe(401);

    const wrongRole = await rest(identity(["Relaties.All.Read"]), "GET", "/api/rest/v1/connectors");
    expect(wrongRole.statusCode).toBe(403);
  });

  test("lists the connector as NOT_LICENSED when no license is configured", async () => {
    const response = await rest(
      identity([CONNECTOR_READER_ROLE]),
      "GET",
      "/api/rest/v1/connectors",
    );
    expect(response.statusCode).toBe(200);
    const connector = JSON.parse(response.body).connectors.find(
      (entry: { slug: string }) => entry.slug === SLUG,
    );
    // Fail closed: with no verified deployment license, an entitlement-gated
    // connector is locked rather than open.
    expect(connector.status).toBe("NOT_LICENSED");
    expect(connector.license.spdx).toBe("LicenseRef-BatterAI-Commercial");
    // The configuration form contract is visible even while locked.
    expect(connector.configFields.map((field: { key: string }) => field.key)).toEqual([
      "endpoint",
      "region",
      "accessKeyId",
      "secretAccessKey",
    ]);
  });

  test("a reader cannot configure; an admin is refused for the right reason", async () => {
    const reader = await rest(
      identity([CONNECTOR_READER_ROLE]),
      "PUT",
      `/api/rest/v1/connectors/${SLUG}/installations/default`,
      { configuration: { endpoint: "https://eu.objectstore.example" } },
    );
    expect(reader.statusCode).toBe(403);

    const admin = await rest(
      identity([CONNECTOR_ADMIN_ROLE]),
      "PUT",
      `/api/rest/v1/connectors/${SLUG}/installations/default`,
      { configuration: { endpoint: "https://eu.objectstore.example" } },
    );
    // Authorized, but the connector is not licensed for this tenant — the gate
    // is binding at configuration time, not only at invocation.
    expect(admin.statusCode).toBe(403);
    expect(JSON.parse(admin.body).error.code).toBe("CONNECTOR_NOT_LICENSED");
  });
});

describe("the GraphQL catalog", () => {
  test("exposes the same connector with the same status", async () => {
    const body = await graphql(
      identity([CONNECTOR_READER_ROLE]),
      `{ connector(slug: "${SLUG}") { slug status license { spdx } instances } }`,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data.connector).toMatchObject({
      slug: SLUG,
      status: "NOT_LICENSED",
      instances: "multiple",
    });
  });

  test("denies a session without a connector role", async () => {
    const body = await graphql(
      identity(["Relaties.All.Read"]),
      `{ connectors { slug } }`,
    );
    expect(body.data?.connectors).toBeFalsy();
    expect(body.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
  });
});
