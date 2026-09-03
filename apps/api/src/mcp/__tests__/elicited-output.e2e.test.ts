// SPDX-License-Identifier: BUSL-1.1
/**
 * One stored elicited-value shape through direct CRUD, GraphQL, REST and MCP.
 * The fixture arms compiled manifest metadata in-process because the shipped
 * base authoring layer deliberately contains no provider/configuration model.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout } from "bun:test";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { sql } from "kysely";
import rawCatalog from "../../generated/mcp/tools.json" with { type: "json" };
import { createApiApp } from "../../roles/api.js";
import { withDbSession } from "../../db/session.js";
import { loadRuntimeModules } from "../../modules/registry.js";
import {
  createGeneratedEntityAfterElicitation,
  createGeneratedEntity,
  getGeneratedCrudTables,
  getGeneratedEntity,
  listGeneratedEntities,
  mergeGeneratedEntityObjectForTable,
  updateGeneratedEntity,
} from "../../graphql/generated-crud.js";
import {
  createdRows,
  expectData,
  getRuntime,
  gql,
  readOnly,
  registerSuiteLifecycle,
  remoteUrl,
  seed,
  tenantA,
  test,
  type Identity,
} from "../../graphql/__tests__/e2e/harness.js";
import {
  decryptSecret,
  keyringFromEnv,
  SECRET_SET_SENTINEL,
  type StoredSecret,
} from "../../connectors/secrets.js";
import { storeElicitedValues } from "../elicitation.js";
import { MCP_MOUNT_PATH } from "../generated-mcp-server.js";
import { REST_MOUNT_PATH } from "../../rest/generated-rest-routes.js";

registerSuiteLifecycle();
setDefaultTimeout(20_000);

const table = getGeneratedCrudTables().find(
  (candidate) => candidate.source?.authoringEntityName === "Preference",
)!;
const graphql = table.source!.graphql!;
const target = table.columns.find(
  (column) => column.sourceField === "valueJson",
)!;
const restBase = `${REST_MOUNT_PATH}/elicited-output-test`;
const keyring = keyringFromEnv(
  `test:${Buffer.alloc(32, 23).toString("base64")}`,
)!;
const definitions = [
  { key: "endpoint", valueType: "string" },
  {
    key: "apiToken",
    valueType: "string",
    classification: { sensitivity: "confidential" },
  },
];
const expectedConfiguration = {
  endpoint: "https://example.test",
  apiToken: SECRET_SET_SENTINEL,
};

type MutableCatalog = {
  tools: Array<Record<string, unknown>>;
};
const catalog = rawCatalog as unknown as MutableCatalog;
const toolNames = ["list", "get", "create", "update"].map(
  (operation) => `elicited_output_test_${operation}`,
);

function tool(
  operation: "list" | "get" | "create" | "update",
  inputSchema: Record<string, unknown>,
) {
  return {
    name: `elicited_output_test_${operation}`,
    operation,
    entity: "Preference",
    table: table.name,
    description: `Test ${operation} projection.`,
    inputSchema,
    annotations: {
      readOnlyHint: operation === "list" || operation === "get",
      destructiveHint: false,
      idempotentHint: operation !== "create",
    },
  };
}

const objectSchema = {
  type: "object",
  properties: {
    ownerScope: { type: "string" },
    namespace: { type: "string" },
    key: { type: "string" },
    description: { type: "string" },
  },
  required: ["ownerScope", "namespace", "key"],
  additionalProperties: false,
};
const injectedTools = [
  tool("list", {
    type: "object",
    properties: {
      filter: {
        type: "object",
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      first: { type: "integer" },
      after: { type: "string" },
      sortField: { type: "string", enum: ["id", "key"] },
      sortDirection: { type: "string", enum: ["asc", "desc"] },
    },
    additionalProperties: false,
  }),
  tool("get", {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  }),
  tool("create", objectSchema),
  tool("update", {
    type: "object",
    properties: {
      id: { type: "string" },
      values: { ...objectSchema, required: [] },
    },
    required: ["id", "values"],
    additionalProperties: false,
  }),
];

const previousMcp = table.source!.mcp;
const previousRest = table.source!.rest;
const runtimeModules = await loadRuntimeModules();
expect(runtimeModules.failures).toEqual([]);
let app: ReturnType<typeof createApiApp> | null = null;

beforeAll(() => {
  table.source!.mcp = {
    toolPrefix: "elicited_output_test",
    tools: "dedicated",
    operations: {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: false,
    },
    elicitOnCreate: {
      sourceField: "key",
      sourceEntity: "Preference",
      definitionsField: "valueJson",
      into: "valueJson",
    },
  };
  table.source!.rest = {
    basePath: "elicited-output-test",
    operations: {
      list: true,
      get: true,
      create: true,
      update: true,
      delete: false,
    },
  };
  catalog.tools.push(...injectedTools);
});

afterAll(async () => {
  await app?.close();
  app = null;
  catalog.tools.splice(
    0,
    catalog.tools.length,
    ...catalog.tools.filter((entry) => !toolNames.includes(String(entry.name))),
  );
  if (previousMcp) table.source!.mcp = previousMcp;
  else delete table.source!.mcp;
  if (previousRest) table.source!.rest = previousRest;
  else delete table.source!.rest;
});

function getApp() {
  app ??= createApiApp(
    process.env.DATABASE_URL
      ? {
          cors: false,
          databaseUrl: process.env.DATABASE_URL,
          modules: runtimeModules,
        }
      : { cors: false, modules: runtimeModules },
  );
  return app;
}

function authHeaders(identity: Identity) {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, identity, {
    secret: process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null,
  });
  return Object.fromEntries(headers.entries());
}

async function rest(
  identity: Identity,
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload?: Record<string, unknown>,
) {
  const response = await getApp().inject({
    method,
    url: path,
    headers: authHeaders(identity),
    ...(payload ? { payload: JSON.stringify(payload) } : {}),
  });
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

let rpcId = 1;
async function callTool(
  identity: Identity,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await getApp().inject({
    method: "POST",
    url: MCP_MOUNT_PATH,
    headers: {
      ...authHeaders(identity),
      accept: "application/json, text/event-stream",
    },
    payload: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = JSON.parse(response.body);
  const text = body.result?.content?.[0]?.text;
  let payload: any;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return {
    status: response.statusCode,
    isError: body.result?.isError === true,
    payload,
  };
}

function storedConfiguration() {
  return storeElicitedValues(
    table.name,
    definitions,
    { endpoint: "https://example.test", apiToken: "test-secret" },
    keyring,
  );
}

function values(marker: string, includeConfiguration = true) {
  return {
    ownerScope: "tenant",
    namespace: `elicited-output-${seed}`,
    key: marker,
    description: "visible sibling",
    ...(includeConfiguration ? { valueJson: storedConfiguration() } : {}),
  };
}

function track(id: string) {
  createdRows.push({ table, id, identity: tenantA });
}

function expectSafe(row: Record<string, unknown>, field = "valueJson") {
  expect(row.description).toBe("visible sibling");
  expect(row[field]).toEqual(expectedConfiguration);
  expect(JSON.stringify(row)).not.toContain("ciphertext");
  expect(JSON.stringify(row)).not.toContain("test-secret");
}

async function storedValue(id: string) {
  return withDbSession(getRuntime().db, tenantA, async (trx) => {
    const result = await sql<{ value_json: unknown }>`
      select ${sql.id("value_json")} as value_json
      from ${sql.id(table.schema, table.table)}
      where ${sql.id(table.primaryKey!)}::text = ${id}
    `.execute(trx);
    return result.rows[0]?.value_json;
  });
}

async function rowsWithKey(key: string) {
  return listGeneratedEntities(getRuntime().db, tenantA, {
    table: table.name,
    filter: { key },
  });
}

async function publicReadValues(id: string): Promise<unknown[]> {
  const directGet = await getGeneratedEntity(getRuntime().db, tenantA, {
    table: table.name,
    id,
  });
  const directList = await listGeneratedEntities(getRuntime().db, tenantA, {
    table: table.name,
    filter: { id },
  });
  const gqlGet = await expectData(
    tenantA,
    `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { valueJson } }`,
    { id },
  );
  const gqlList = await expectData(
    tenantA,
    `query($filter: PreferenceFilter) {
      ${graphql.listQueryName}(filter: $filter) { edges { node { valueJson } } }
    }`,
    { filter: { id } },
  );
  const restGet = await rest(tenantA, "GET", `${restBase}/${id}`);
  const restList = await rest(tenantA, "GET", `${restBase}?id=${id}`);
  const mcpGet = await callTool(tenantA, "elicited_output_test_get", { id });
  const mcpList = await callTool(tenantA, "elicited_output_test_list", {
    filter: { id },
  });
  return [
    directGet!.value_json,
    directList.rows[0]!.value_json,
    gqlGet[graphql.singleQueryName].valueJson,
    gqlList[graphql.listQueryName].edges[0].node.valueJson,
    restGet.body.valueJson,
    restList.body.items[0].valueJson,
    mcpGet.payload.valueJson,
    mcpList.payload.items[0].valueJson,
  ];
}

test.skipIf(remoteUrl)(
  "trusted elicitation stores encrypted values and every read returns the same marker output",
  async () => {
    const direct = await createGeneratedEntityAfterElicitation(
      getRuntime().db,
      tenantA,
      {
        table: table.name,
        values: values(`direct-${seed}`),
        into: "valueJson",
      },
    );
    const directId = String(direct.id);
    track(directId);
    expectSafe(direct, "value_json");

    const directGet = await getGeneratedEntity(getRuntime().db, tenantA, {
      table: table.name,
      id: directId,
    });
    const directList = await listGeneratedEntities(getRuntime().db, tenantA, {
      table: table.name,
      filter: { id: directId },
    });
    const gqlGet = await expectData(
      tenantA,
      `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id description valueJson } }`,
      { id: directId },
    );
    const gqlList = await expectData(
      tenantA,
      `query($filter: PreferenceFilter) {
        ${graphql.listQueryName}(filter: $filter) { edges { node { id description valueJson } } }
      }`,
      { filter: { id: directId } },
    );
    const restGet = await rest(tenantA, "GET", `${restBase}/${directId}`);
    const restList = await rest(tenantA, "GET", `${restBase}?id=${directId}`);
    const mcpGet = await callTool(tenantA, "elicited_output_test_get", {
      id: directId,
    });
    const mcpList = await callTool(tenantA, "elicited_output_test_list", {
      filter: { id: directId },
    });

    const safeValues = [
      directGet!.value_json,
      directList.rows[0]!.value_json,
      gqlGet[graphql.singleQueryName].valueJson,
      gqlList[graphql.listQueryName].edges[0].node.valueJson,
      restGet.body.valueJson,
      restList.body.items[0].valueJson,
      mcpGet.payload.valueJson,
      mcpList.payload.items[0].valueJson,
    ];
    expect(new Set(safeValues.map((value) => JSON.stringify(value))).size).toBe(
      1,
    );
    expect(safeValues[0]).toEqual(expectedConfiguration);

    const directUpdated = await updateGeneratedEntity(
      getRuntime().db,
      tenantA,
      {
        table: table.name,
        id: directId,
        values: { description: "visible sibling" },
      },
    );
    const gqlUpdated = await expectData(
      tenantA,
      `mutation($input: UpdatePreferenceInput!) {
        ${graphql.updateMutationName}(input: $input) { id valueJson }
      }`,
      { input: { id: directId, description: "visible sibling" } },
    );
    const restUpdated = await rest(
      tenantA,
      "PATCH",
      `${restBase}/${directId}`,
      {
        description: "visible sibling",
      },
    );
    const mcpUpdated = await callTool(tenantA, "elicited_output_test_update", {
      id: directId,
      values: { description: "visible sibling" },
    });
    expect([
      directUpdated!.value_json,
      gqlUpdated[graphql.updateMutationName].valueJson,
      restUpdated.body.valueJson,
      mcpUpdated.payload.valueJson,
    ]).toEqual(Array(4).fill(expectedConfiguration));

    const stored = (await storedValue(directId)) as Record<string, unknown>;
    expect(stored.endpoint).toBe("https://example.test");
    expect(stored.apiToken).not.toBe(SECRET_SET_SENTINEL);
    expect(
      decryptSecret(
        keyring,
        table.name,
        "apiToken",
        stored.apiToken as StoredSecret,
      ),
    ).toBe("test-secret");

    const absent = await createGeneratedEntity(getRuntime().db, tenantA, {
      table: table.name,
      values: values(`absent-${seed}`, false),
    });
    const absentId = String(absent.id);
    track(absentId);
    expect(absent.value_json).toBeNull();
    expect(
      (await rest(tenantA, "GET", `${restBase}/${absentId}`)).body.valueJson,
    ).toBeNull();

    target.classification = "confidential";
    try {
      expect(
        (await getGeneratedEntity(getRuntime().db, readOnly, {
          table: table.name,
          id: directId,
        }))!.value_json,
      ).toBeNull();
      expect(
        (await getGeneratedEntity(getRuntime().db, tenantA, {
          table: table.name,
          id: directId,
        }))!.value_json,
      ).toEqual(expectedConfiguration);
    } finally {
      delete target.classification;
    }
  },
);

test.skipIf(remoteUrl)(
  "direct CRUD, GraphQL, REST and MCP cannot inject or replace elicited values",
  async () => {
    const protectedRow = await createGeneratedEntityAfterElicitation(
      getRuntime().db,
      tenantA,
      {
        table: table.name,
        values: values(`protected-${seed}`),
        into: "valueJson",
      },
    );
    const protectedId = String(protectedRow.id);
    track(protectedId);
    const originalStorage = await storedValue(protectedId);
    const maliciousValues = [
      { apiToken: "plaintext-secret" },
      { apiToken: { ciphertext: "malformed" } },
      storedConfiguration(),
    ];

    for (const [index, valueJson] of maliciousValues.entries()) {
      const marker = `rejected-${index}-${seed}`;
      await expect(
        createGeneratedEntity(getRuntime().db, tenantA, {
          table: table.name,
          values: { ...values(marker, false), valueJson },
        }),
      ).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT", status: 400 },
      });
      await expect(
        updateGeneratedEntity(getRuntime().db, tenantA, {
          table: table.name,
          id: protectedId,
          values: { valueJson },
        }),
      ).rejects.toMatchObject({
        extensions: { code: "BAD_USER_INPUT", status: 400 },
      });

      const graphqlCreate = await gql(
        tenantA,
        `mutation($input: CreatePreferenceInput!) {
          ${graphql.createMutationName}(input: $input) { id }
        }`,
        { input: { ...values(`graphql-${marker}`, false), valueJson } },
      );
      expect(graphqlCreate.errors?.[0]?.extensions?.code).toBe(
        "BAD_USER_INPUT",
      );
      const graphqlUpdate = await gql(
        tenantA,
        `mutation($input: UpdatePreferenceInput!) {
          ${graphql.updateMutationName}(input: $input) { id }
        }`,
        { input: { id: protectedId, valueJson } },
      );
      expect(graphqlUpdate.errors?.[0]?.extensions?.code).toBe(
        "BAD_USER_INPUT",
      );

      const restCreate = await rest(tenantA, "POST", restBase, {
        ...values(`rest-${marker}`, false),
        valueJson,
      });
      expect(restCreate.status).toBe(400);
      const restUpdate = await rest(
        tenantA,
        "PATCH",
        `${restBase}/${protectedId}`,
        { valueJson },
      );
      expect(restUpdate.status).toBe(400);

      const mcpCreate = await callTool(
        tenantA,
        "elicited_output_test_create",
        { ...values(`mcp-${marker}`, false), valueJson },
      );
      expect(mcpCreate.isError).toBe(true);
      const mcpUpdate = await callTool(
        tenantA,
        "elicited_output_test_update",
        { id: protectedId, values: { valueJson } },
      );
      expect(mcpUpdate.isError).toBe(true);

      expect((await rowsWithKey(marker)).rows).toHaveLength(0);
      expect((await rowsWithKey(`graphql-${marker}`)).rows).toHaveLength(0);
      expect((await rowsWithKey(`rest-${marker}`)).rows).toHaveLength(0);
      expect((await rowsWithKey(`mcp-${marker}`)).rows).toHaveLength(0);
      expect(await storedValue(protectedId)).toEqual(originalStorage);

      const serializedFailures = JSON.stringify({
        graphqlCreate,
        graphqlUpdate,
        restCreate,
        restUpdate,
        mcpCreate,
        mcpUpdate,
      });
      expect(serializedFailures).not.toContain("plaintext-secret");
      expect(serializedFailures).not.toContain("malformed");
      expect(serializedFailures).not.toContain("ciphertext");
    }
  },
);

test.skipIf(remoteUrl)(
  "recursive stored envelopes never cross create, get or list outputs",
  async () => {
    const ordinaryObject = {
      algorithm: "round-robin",
      retry: { attempts: 3 },
    };
    const completeEnvelope = storedConfiguration().apiToken;
    const fixtures: Array<{
      name: string;
      stored: unknown;
      expected: unknown;
    }> = [
      {
        name: "root-complete",
        stored: completeEnvelope,
        expected: SECRET_SET_SENTINEL,
      },
      {
        name: "root-missing-key",
        stored: {
          ciphertext: "root-malformed-must-not-cross",
          algorithm: "aes-256-gcm",
        },
        expected: SECRET_SET_SENTINEL,
      },
      {
        name: "nested-malformed",
        stored: {
          endpoint: "https://example.test",
          routing: ordinaryObject,
          authentication: {
            visible: true,
            missingKey: {
              ciphertext: "nested-malformed-must-not-cross",
            },
            missingCiphertext: {
              keyId: "nested-malformed-must-not-cross",
              algorithm: "aes-256-gcm",
            },
          },
        },
        expected: {
          endpoint: "https://example.test",
          routing: ordinaryObject,
          authentication: {
            visible: true,
            missingKey: SECRET_SET_SENTINEL,
            missingCiphertext: SECRET_SET_SENTINEL,
          },
        },
      },
      {
        name: "array-complete-and-malformed",
        stored: [
          { label: "visible" },
          completeEnvelope,
          { child: { ciphertext: "array-malformed-must-not-cross" } },
          {
            child: {
              keyId: "array-malformed-must-not-cross",
              algorithm: "aes-256-gcm",
            },
          },
        ],
        expected: [
          { label: "visible" },
          SECRET_SET_SENTINEL,
          { child: SECRET_SET_SENTINEL },
          { child: SECRET_SET_SENTINEL },
        ],
      },
    ];

    for (const fixture of fixtures) {
      const created = await createGeneratedEntityAfterElicitation(
        getRuntime().db,
        tenantA,
        {
          table: table.name,
          values: {
            ...values(`${fixture.name}-${seed}`, false),
            valueJson: fixture.stored,
          },
          into: "valueJson",
        },
      );
      const id = String(created.id);
      track(id);

      const outputs = [created.value_json, ...(await publicReadValues(id))];
      expect(outputs).toEqual(Array(outputs.length).fill(fixture.expected));
      const serialized = JSON.stringify(outputs);
      expect(serialized).not.toContain("must-not-cross");
      expect(serialized).not.toContain("ciphertext");
      expect(serialized).not.toContain("keyId");
      expect(await storedValue(id)).toEqual(fixture.stored);
    }
  },
);

test.skipIf(remoteUrl)(
  "trusted JSONB merge replaces supplied tokens and preserves omitted siblings",
  async () => {
    const tokenDefinitions = [
      {
        key: "accessToken",
        valueType: "string",
        classification: { sensitivity: "confidential" },
      },
      {
        key: "refreshToken",
        valueType: "string",
        classification: { sensitivity: "confidential" },
      },
    ];
    const initial = storeElicitedValues(
      table.name,
      tokenDefinitions,
      { accessToken: "access-old", refreshToken: "refresh-old" },
      keyring,
    );
    const replacement = storeElicitedValues(
      table.name,
      tokenDefinitions,
      { accessToken: "access-new" },
      keyring,
    );
    const created = await createGeneratedEntityAfterElicitation(
      getRuntime().db,
      tenantA,
      {
        table: table.name,
        values: {
          ...values(`merge-${seed}`, false),
          valueJson: { ...initial, endpoint: "https://example.test" },
        },
        into: "valueJson",
      },
    );
    const id = String(created.id);
    track(id);

    const merged = await mergeGeneratedEntityObjectForTable(
      getRuntime().db,
      tenantA,
      table,
      id,
      "valueJson",
      {
        accessToken: replacement.accessToken,
        accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      },
    );
    expect(merged?.value_json).toEqual({
      accessToken: SECRET_SET_SENTINEL,
      refreshToken: SECRET_SET_SENTINEL,
      endpoint: "https://example.test",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    });

    const persisted = await storedValue(id);
    expect(Array.isArray(persisted)).toBe(false);
    expect(typeof persisted).toBe("object");
    const object = persisted as Record<string, unknown>;
    expect(object.endpoint).toBe("https://example.test");
    expect(object.refreshToken).toEqual(initial.refreshToken);
    expect(object.accessToken).toEqual(replacement.accessToken);
    expect(
      decryptSecret(
        keyring,
        table.name,
        "accessToken",
        object.accessToken as StoredSecret,
      ),
    ).toBe("access-new");
    expect(
      decryptSecret(
        keyring,
        table.name,
        "refreshToken",
        object.refreshToken as StoredSecret,
      ),
    ).toBe("refresh-old");
  },
);
