// SPDX-License-Identifier: BUSL-1.1
import Ajv2020 from "ajv/dist/2020.js";
import type {
  CompilerPlugin,
  JsonSchema,
  PluginBaseContext,
  PluginOperationContract,
} from "./plugins.js";
import type { CompiledConnectorContract } from "./authoring/types/connector.js";
import type { PlatformSchemaManifest } from "./schema.js";

export type CompiledPluginOperation = PluginOperationContract & { plugin: string };

const KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const IDENTIFIER = /^[_A-Za-z][_0-9A-Za-z]*$/;
const MCP_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;
const GRAPHQL_FIELD = /^[_A-Za-z][_0-9A-Za-z]*$/;
const SECURITY_SCHEME = /^[A-Za-z0-9._-]+$/;
const REST_PATH = /^\/api\/[a-z][a-z0-9-]*(?:\/(?::[_A-Za-z][_0-9A-Za-z]*|[a-z0-9][a-z0-9._-]*))*$/;
const RESERVED_API_NAMESPACES = new Set([
  "connectors",
  "control",
  "graphql",
  "live",
  "mcp",
  "metrics",
  "oauth",
  "ready",
  "rest",
]);

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be non-empty.`);
}

function assertSchema(ajv: { compile(schema: unknown): unknown }, schema: JsonSchema, label: string): void {
  try {
    ajv.compile(schema);
  } catch (error) {
    throw new Error(`${label} is not valid JSON Schema 2020-12: ${String(error)}`);
  }
}

function validateOperation(plugin: string, operation: PluginOperationContract): void {
  const where = `Plugin "${plugin}" operation "${operation.key}"`;
  if (!operation.transports?.typescript) {
    throw new Error(`${where} must declare an explicit TypeScript projection or disabled reason.`);
  }
  if (!KEY.test(operation.key) || !operation.key.startsWith(`${plugin}.`)) {
    throw new Error(`${where} must use a stable lowercase key prefixed with "${plugin}.".`);
  }
  nonEmpty(operation.title, `${where} title`);
  nonEmpty(operation.description, `${where} description`);
  nonEmpty(operation.handler, `${where} handler`);
  if (!IDENTIFIER.test(operation.handler)) {
    throw new Error(`${where} handler must be a TypeScript identifier.`);
  }
  const restPath = operation.transports.rest.path;
  if (RESERVED_API_NAMESPACES.has(plugin)) {
    throw new Error(`${where} uses reserved API namespace "${plugin}".`);
  }
  if (!REST_PATH.test(restPath) || !restPath.startsWith(`/api/${plugin}/`)) {
    throw new Error(`${where} REST path must be a safe /api/${plugin}/ path.`);
  }
  const ajv = new Ajv2020.default({ strict: true, allErrors: true, formats: { uuid: true, date: true, "date-time": true } });
  assertSchema(ajv, operation.inputSchema, `${where} inputSchema`);
  assertSchema(ajv, operation.outputSchema, `${where} outputSchema`);
  if (operation.inputSchema.type !== "object" ||
      !operation.inputSchema.properties ||
      typeof operation.inputSchema.properties !== "object" ||
      Array.isArray(operation.inputSchema.properties)) {
    throw new Error(`${where} inputSchema must be an object schema with properties.`);
  }
  const inputProperties = operation.inputSchema.properties as Record<string, unknown>;
  const inputRequired = new Set(Array.isArray(operation.inputSchema.required) ? operation.inputSchema.required as string[] : []);
  for (const match of restPath.matchAll(/:([_A-Za-z][_0-9A-Za-z]*)/g)) {
    const parameter = match[1]!;
    if (!(parameter in inputProperties) || !inputRequired.has(parameter)) {
      throw new Error(`${where} REST path parameter "${parameter}" must be a required inputSchema property.`);
    }
  }
  const statuses = new Set<number>();
  for (const error of operation.errors) {
    if (!Number.isInteger(error.status) || error.status < 400 || error.status > 599) {
      throw new Error(`${where} error status must be an integer from 400 through 599.`);
    }
    if (statuses.has(error.status)) {
      throw new Error(`${where} declares duplicate error status ${error.status}.`);
    }
    statuses.add(error.status);
    nonEmpty(error.code, `${where} error code`);
    nonEmpty(error.description, `${where} error description`);
    if (error.schema) assertSchema(ajv, error.schema, `${where} error ${error.code} schema`);
  }
  if (operation.auth.mode === "session" && operation.auth.roles.length === 0) {
    throw new Error(`${where} session auth must declare at least one role.`);
  }
  if (operation.auth.mode === "custom") {
    nonEmpty(operation.auth.scheme, `${where} custom auth scheme`);
    nonEmpty(operation.auth.description, `${where} custom auth description`);
    if (!SECURITY_SCHEME.test(operation.auth.scheme)) {
      throw new Error(`${where} custom auth scheme must be an OpenAPI component key.`);
    }
    nonEmpty(
      "scheme" in operation.auth.securityScheme
        ? operation.auth.securityScheme.scheme
        : operation.auth.securityScheme.name,
      `${where} custom security scheme detail`,
    );
    if (operation.transports.mcp.enabled || operation.transports.graphql.enabled) {
      throw new Error(`${where} custom auth can only project to REST; MCP and GraphQL need disabled reasons.`);
    }
  }
  if (operation.auth.mode === "public" && operation.transports.mcp.enabled) {
    throw new Error(`${where} public operations cannot project to the authenticated MCP endpoint; disable MCP with a reason.`);
  }
  const responseKind = operation.transports.rest.response.kind;
  const successStatus = operation.transports.rest.response.status ?? 200;
  if (!Number.isInteger(successStatus) || successStatus < 200 || successStatus > 399) {
    throw new Error(`${where} REST success status must be an integer from 200 through 399.`);
  }
  if (responseKind !== "json" &&
      (operation.transports.mcp.enabled || operation.transports.graphql.enabled)) {
    throw new Error(`${where} ${responseKind} responses cannot project to MCP or GraphQL; use an artifact-handle JSON operation or disable those projections with reasons.`);
  }
  if (operation.transports.mcp.enabled && !MCP_NAME.test(operation.transports.mcp.name)) {
    throw new Error(`${where} has invalid MCP tool name "${operation.transports.mcp.name}".`);
  }
  if (operation.transports.graphql.enabled && !GRAPHQL_FIELD.test(operation.transports.graphql.field)) {
    throw new Error(`${where} has invalid GraphQL field "${operation.transports.graphql.field}".`);
  }
  if (operation.transports.typescript.enabled && !IDENTIFIER.test(operation.transports.typescript.functionName)) {
    throw new Error(`${where} has invalid TypeScript function name "${operation.transports.typescript.functionName}".`);
  }
  for (const projection of [operation.transports.mcp, operation.transports.graphql, operation.transports.typescript]) {
    if (!projection.enabled) nonEmpty(projection.reason, `${where} disabled projection reason`);
  }
  if (operation.idempotency.mode === "idempotency-key" &&
      !(operation.idempotency.header ?? "").trim()) {
    throw new Error(`${where} idempotency-key mode must name its header.`);
  }
}

function claimSurface(
  seen: Map<string, string>,
  kind: string,
  name: string,
  owner: string,
): void {
  const previous = seen.get(name);
  if (previous && previous !== owner) {
    throw new Error(`${kind} "${name}" is claimed by both ${previous} and ${owner}.`);
  }
  seen.set(name, owner);
}

/** Cross-catalog audits run after entities, connectors, and operations exist. */
export function auditOperationSurfaceCollisions(
  operations: readonly CompiledPluginOperation[],
  manifest: PlatformSchemaManifest,
  connectors: readonly CompiledConnectorContract[],
  maxDedicatedMcpTools: number,
): void {
  const graphql = new Map<string, string>();
  const mcp = new Map<string, string>();
  let dedicatedMcpTools = 0;

  for (const table of manifest.tables) {
    const owner = `entity ${table.schema}.${table.name}`;
    const entityGraphql = table.source?.graphql;
    if (entityGraphql) {
      for (const name of [
        entityGraphql.singleQueryName,
        entityGraphql.listQueryName,
        entityGraphql.createMutationName,
        entityGraphql.updateMutationName,
        entityGraphql.deleteMutationName,
      ]) claimSurface(graphql, "GraphQL root field", name, owner);
    }
    const entityMcp = table.source?.mcp;
    if (entityMcp) {
      for (const [operation, enabled] of Object.entries(entityMcp.operations)) {
        if (!enabled) continue;
        const name = entityMcp.tools === "generic" ? `osf_${operation}` : `${entityMcp.toolPrefix}_${operation}`;
        claimSurface(mcp, "MCP tool", name, entityMcp.tools === "generic" ? "shared entity CRUD" : owner);
        if (entityMcp.tools === "dedicated") dedicatedMcpTools += 1;
      }
    }
  }

  for (const connector of connectors) {
    const owner = `connector ${connector.slug}`;
    if (connector.exposure.graphql) claimSurface(graphql, "GraphQL root field", connector.namespace, owner);
    for (const operation of connector.operations) {
      if (!operation.mcp) continue;
      claimSurface(mcp, "MCP tool", operation.mcp.toolName, `${owner}.${operation.key}`);
      dedicatedMcpTools += 1;
    }
  }

  for (const operation of operations) {
    const owner = `plugin operation ${operation.key}`;
    if (operation.transports.graphql.enabled) {
      claimSurface(graphql, "GraphQL root field", operation.transports.graphql.field, owner);
    }
    if (operation.transports.mcp.enabled) {
      claimSurface(mcp, "MCP tool", operation.transports.mcp.name, owner);
      dedicatedMcpTools += 1;
    }
  }

  if (dedicatedMcpTools > maxDedicatedMcpTools) {
    throw new Error(
      `The combined MCP catalog would advertise ${dedicatedMcpTools} dedicated tools, ` +
      `over the ${maxDedicatedMcpTools} limit.`,
    );
  }
}

export function collectPluginOperations(
  plugins: readonly CompilerPlugin[],
  context: PluginBaseContext,
): CompiledPluginOperation[] {
  const operations: CompiledPluginOperation[] = [];
  const keys = new Set<string>();
  const rest = new Set<string>();
  const mcp = new Set<string>();
  const graphql = new Set<string>();
  const typescript = new Set<string>();
  const customSecurity = new Map<string, string>();
  for (const plugin of plugins) {
    const declared = typeof plugin.operations === "function"
      ? plugin.operations(context)
      : plugin.operations ?? [];
    for (const operation of declared) {
      validateOperation(plugin.name, operation);
      const restKey = `${operation.transports.rest.method} ${operation.transports.rest.path.replace(/:[_A-Za-z][_0-9A-Za-z]*/g, ":param")}`;
      const graphqlKey = operation.transports.graphql.enabled
        ? `${operation.transports.graphql.kind}:${operation.transports.graphql.field}`
        : undefined;
      const typescriptKey = operation.transports.typescript.enabled
        ? operation.transports.typescript.functionName
        : undefined;
      if (keys.has(operation.key)) throw new Error(`Duplicate plugin operation key "${operation.key}".`);
      if (rest.has(restKey)) throw new Error(`Duplicate plugin operation REST route "${restKey}".`);
      if (operation.transports.mcp.enabled && mcp.has(operation.transports.mcp.name)) {
        throw new Error(`Duplicate plugin operation MCP tool "${operation.transports.mcp.name}".`);
      }
      if (graphqlKey && graphql.has(graphqlKey)) {
        throw new Error(`Duplicate plugin operation GraphQL field "${graphqlKey}".`);
      }
      if (typescriptKey && typescript.has(typescriptKey)) {
        throw new Error(`Duplicate plugin operation TypeScript function "${typescriptKey}".`);
      }
      if (operation.auth.mode === "custom") {
        const definition = JSON.stringify({
          description: operation.auth.description,
          ...operation.auth.securityScheme,
        });
        const previous = customSecurity.get(operation.auth.scheme);
        if (previous && previous !== definition) {
          throw new Error(`Plugin operations declare conflicting custom security scheme "${operation.auth.scheme}".`);
        }
        customSecurity.set(operation.auth.scheme, definition);
      }
      keys.add(operation.key);
      rest.add(restKey);
      if (operation.transports.mcp.enabled) mcp.add(operation.transports.mcp.name);
      if (graphqlKey) graphql.add(graphqlKey);
      if (typescriptKey) typescript.add(typescriptKey);
      operations.push({ ...operation, plugin: plugin.name });
    }
  }
  return operations.sort((left, right) => left.key.localeCompare(right.key));
}

export function renderOperationCatalog(operations: readonly CompiledPluginOperation[]): string {
  return `${JSON.stringify({ version: 1, operations }, null, 2)}\n`;
}

export function assertOperationRuntimeModules(
  operations: readonly CompiledPluginOperation[],
  runtimeModuleNames: Iterable<string>,
): void {
  const available = new Set(runtimeModuleNames);
  const missing = [...new Set(
    operations.filter((operation) => !available.has(operation.plugin)).map((operation) => operation.plugin),
  )].sort();
  if (missing.length > 0) {
    throw new Error(
      `Plugin operation contract(s) require a runtime module that is not registered: ${missing.join(", ")}. ` +
      "Add the plugin's runtime.ts (or runtime package export) before declaring operations.",
    );
  }
}

export function operationOpenApiPaths(operations: readonly CompiledPluginOperation[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    const rest = operation.transports.rest;
    const responses: Record<string, unknown> = {
      [String(rest.response.status ?? 200)]: {
        description: `${operation.title} result`,
        content: {
          [rest.response.contentType ?? (rest.response.kind === "json" ? "application/json" : "application/octet-stream")]: {
            schema: rest.response.kind === "json" ? operation.outputSchema : { type: "string", format: "binary" },
          },
        },
      },
    };
    for (const error of operation.errors) {
      responses[String(error.status)] = {
        description: error.description,
        content: { "application/json": { schema: error.schema ?? { $ref: "#/components/schemas/Error" } } },
      };
    }
    const method = rest.method.toLowerCase();
    const openApiPath = rest.path.replace(/:([_A-Za-z][_0-9A-Za-z]*)/g, "{$1}");
    const pathParameters = [...rest.path.matchAll(/:([_A-Za-z][_0-9A-Za-z]*)/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: (operation.inputSchema.properties as Record<string, unknown> | undefined)?.[name!] ?? { type: "string" },
    }));
    const pathNames = new Set(pathParameters.map((parameter) => parameter.name));
    const inputProperties = operation.inputSchema.properties as Record<string, unknown> | undefined;
    const required = new Set(Array.isArray(operation.inputSchema.required) ? operation.inputSchema.required as string[] : []);
    const queryParameters = rest.method === "GET" || rest.method === "DELETE"
      ? Object.entries(inputProperties ?? {})
          .filter(([name]) => !pathNames.has(name))
          .map(([name, schema]) => ({ name, in: "query", required: required.has(name), schema }))
      : [];
    const idempotencyParameters = operation.idempotency.mode === "idempotency-key"
      ? [{
          name: operation.idempotency.header!,
          in: "header",
          required: false,
          description: operation.idempotency.description,
          schema: { type: "string", minLength: 1 },
        }]
      : [];
    const bodyProperties = Object.fromEntries(
      Object.entries(inputProperties ?? {}).filter(([name]) => !pathNames.has(name)),
    );
    const bodyRequired = [...required].filter((name) => !pathNames.has(name));
    const bodySchema = {
      ...operation.inputSchema,
      properties: bodyProperties,
      ...(bodyRequired.length > 0 ? { required: bodyRequired } : { required: undefined }),
    };
    paths[openApiPath] = {
      ...(paths[openApiPath] ?? {}),
      [method]: {
        operationId: operation.key,
        summary: operation.title,
        description: operation.description,
        tags: [operation.plugin],
        security: operation.auth.mode === "public" ? [] : operation.auth.mode === "session" ? [{ bearerAuth: operation.auth.scopes ?? [] }] : [{ [operation.auth.scheme]: [] }],
        "x-osf-operation": {
          key: operation.key,
          handler: operation.handler,
          auth: operation.auth,
          tenancy: operation.tenancy,
          idempotency: operation.idempotency,
          transports: operation.transports,
        },
        ...([...pathParameters, ...queryParameters, ...idempotencyParameters].length > 0
          ? { parameters: [...pathParameters, ...queryParameters, ...idempotencyParameters] }
          : {}),
        ...(rest.method === "GET" || rest.method === "DELETE" ? {} : {
          requestBody: { required: bodyRequired.length > 0, content: { "application/json": { schema: bodySchema } } },
        }),
        responses,
      },
    };
  }
  return paths;
}
