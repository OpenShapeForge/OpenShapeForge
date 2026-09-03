// SPDX-License-Identifier: BUSL-1.1
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type {
  CompilerPlugin,
  JsonSchema,
  PluginBaseContext,
  PluginOperationContract,
} from "./plugins.js";
import type { CompiledConnectorContract } from "./authoring/types/connector.js";
import type { PlatformSchemaManifest } from "./schema.js";
import { isGeneratedCrudEligible } from "./schema.js";

export type CompiledPluginOperation = PluginOperationContract & { plugin: string };

const KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const IDENTIFIER = /^[_A-Za-z][_0-9A-Za-z]*$/;
const MCP_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;
const GRAPHQL_FIELD = /^[_A-Za-z][_0-9A-Za-z]*$/;
const SECURITY_SCHEME = /^[A-Za-z0-9._-]+$/;
const REST_PATH = /^\/api\/[a-z][a-z0-9-]*(?:\/(?::[_A-Za-z][_0-9A-Za-z]*|[a-z0-9][a-z0-9._-]*))*$/;
const RESERVED_API_NAMESPACES = new Set([
  "api-keys",
  "connectors",
  "control",
  "documents",
  "entity-configuration",
  "entity-oauth",
  "graphql",
  "health",
  "live",
  "mcp",
  "metrics",
  "oauth",
  "ready",
  "rest",
]);

const DEFAULT_OPERATION_ERROR_SCHEMA = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

type RestMethod = PluginOperationContract["transports"]["rest"]["method"];
type RestRoute = { method: RestMethod; path: string; owner: string };

/**
 * Built-in /api routes that can coexist with collision-free nested aliases.
 * Conditional routes are included because a contract must remain safe when
 * the corresponding runtime feature is enabled.
 */
const CORE_API_ROUTES: readonly RestRoute[] = [
  { method: "GET", path: "/api/health", owner: "core health" },
  { method: "GET", path: "/api/metrics", owner: "core metrics" },
  { method: "GET", path: "/api/ready", owner: "core readiness" },
  { method: "GET", path: "/api/graphql", owner: "core GraphQL" },
  { method: "POST", path: "/api/graphql", owner: "core GraphQL" },
  { method: "GET", path: "/api/graphql/persisted", owner: "core persisted GraphQL" },
  { method: "POST", path: "/api/graphql/persisted", owner: "core persisted GraphQL" },
  { method: "GET", path: "/api/rest/openapi.json", owner: "core REST OpenAPI" },
  { method: "GET", path: "/api/rest/docs", owner: "core REST documentation" },
  { method: "GET", path: "/api/rest/docs/swagger-ui.css", owner: "core REST documentation" },
  { method: "GET", path: "/api/rest/docs/swagger-ui-bundle.js", owner: "core REST documentation" },
  { method: "GET", path: "/api/rest/docs/swagger-ui-standalone-preset.js", owner: "core REST documentation" },
  { method: "GET", path: "/api/rest/docs/swagger-initializer.js", owner: "core REST documentation" },
  { method: "GET", path: "/api/rest/docs/oauth2-redirect.html", owner: "core REST OAuth callback" },
  { method: "GET", path: "/api/rest/docs/oauth2-redirect.js", owner: "core REST OAuth callback" },
  { method: "POST", path: "/api/documents", owner: "core document commands" },
  { method: "POST", path: "/api/documents/:documentId/versions", owner: "core document commands" },
  { method: "GET", path: "/api/rest/v1/connectors", owner: "core connector catalog" },
  { method: "GET", path: "/api/rest/v1/connectors/:slug", owner: "core connector catalog" },
  { method: "PUT", path: "/api/rest/v1/connectors/:slug/installations/:instanceKey", owner: "core connector configuration" },
  { method: "POST", path: "/api/rest/v1/connectors/:slug/installations/:instanceKey/verify", owner: "core connector verification" },
  { method: "GET", path: "/api/rest/v1/connectors/:basePath/invoke/:operationPath", owner: "core connector invocation" },
  { method: "POST", path: "/api/rest/v1/connectors/:basePath/invoke/:operationPath", owner: "core connector invocation" },
  { method: "POST", path: "/api/rest/v1/connectors/:slug/installations/:instanceKey/enable", owner: "core connector configuration" },
  { method: "POST", path: "/api/rest/v1/connectors/:slug/installations/:instanceKey/disable", owner: "core connector configuration" },
  { method: "POST", path: "/api/rest/v1/connectors/:slug/installations/:instanceKey/authorize", owner: "core connector OAuth" },
  { method: "GET", path: "/api/rest/v1/connectors/oauth/callback", owner: "core connector OAuth" },
  { method: "GET", path: "/api/entity-oauth/callback", owner: "core entity OAuth" },
  { method: "GET", path: "/api/entity-configuration/pending", owner: "core entity configuration" },
  { method: "POST", path: "/api/entity-configuration/pending/:id", owner: "core entity configuration" },
  { method: "GET", path: "/api/entity-configuration/:token", owner: "core entity configuration" },
  { method: "POST", path: "/api/entity-configuration/:token", owner: "core entity configuration" },
  { method: "GET", path: "/api/mcp", owner: "core MCP" },
  { method: "POST", path: "/api/mcp", owner: "core MCP" },
  { method: "DELETE", path: "/api/mcp", owner: "core MCP" },
  { method: "GET", path: "/api/api-keys", owner: "core API-key provisioning" },
  { method: "POST", path: "/api/api-keys", owner: "core API-key provisioning" },
  { method: "POST", path: "/api/api-keys/:integrationId/keys", owner: "core API-key provisioning" },
  { method: "DELETE", path: "/api/api-keys/keys/:keyId", owner: "core API-key provisioning" },
  { method: "DELETE", path: "/api/api-keys/:integrationId", owner: "core API-key provisioning" },
  { method: "GET", path: "/api/control/v1/tenants", owner: "core control plane" },
  { method: "POST", path: "/api/control/v1/tenants", owner: "core control plane" },
  { method: "GET", path: "/api/control/v1/tenants/:tenantSlug", owner: "core control plane" },
  { method: "PATCH", path: "/api/control/v1/tenants/:tenantSlug", owner: "core control plane" },
  { method: "GET", path: "/api/control/v1/tenants/:tenantSlug/organizations", owner: "core control plane" },
  { method: "POST", path: "/api/control/v1/tenants/:tenantSlug/organizations", owner: "core control plane" },
  { method: "PATCH", path: "/api/control/v1/tenants/:tenantSlug/organizations/:orgUnitId", owner: "core control plane" },
  { method: "GET", path: "/api/control/v1/reconciliation", owner: "core control plane" },
  { method: "POST", path: "/api/control/v1/reconciliation/reapply", owner: "core control plane" },
];

function restPathParameters(path: string): string[] {
  return [...path.matchAll(/:([_A-Za-z][_0-9A-Za-z]*)/g)].map((match) => match[1]!);
}

function normalizedRestRoute(method: RestMethod, path: string): string {
  return `${method} ${path.replace(/:[_A-Za-z][_0-9A-Za-z]*/g, ":param")}`;
}

function restRoutesOverlap(left: RestRoute, right: RestRoute): boolean {
  if (left.method !== right.method) return false;
  const leftSegments = left.path.split("/").slice(1);
  const rightSegments = right.path.split("/").slice(1);
  const segmentOverlaps = (leftSegment: string, rightSegment: string): boolean =>
    leftSegment === rightSegment ||
    leftSegment.startsWith(":") ||
    rightSegment.startsWith(":") ||
    leftSegment === "*" ||
    rightSegment === "*";
  for (let index = 0; index < Math.max(leftSegments.length, rightSegments.length); index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];
    if (leftSegment === "*" || rightSegment === "*") return true;
    if (leftSegment === undefined || rightSegment === undefined) return false;
    if (!segmentOverlaps(leftSegment, rightSegment)) return false;
  }
  return true;
}

function nonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must be non-empty.`);
}

function isJsonContentType(value: string): boolean {
  if (value !== value.trim()) return false;
  const mediaType = value.toLowerCase();
  return mediaType === "application/json" ||
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}

function assertSchema(ajv: { compile(schema: unknown): unknown }, schema: JsonSchema, label: string): void {
  try {
    ajv.compile(schema);
  } catch (error) {
    throw new Error(`${label} is not valid JSON Schema 2020-12: ${String(error)}`);
  }
}

function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || !isJsonValue(value[index], seen)) {
        valid = false;
        break;
      }
    }
  } else {
    valid = Object.values(value).every((entry) => isJsonValue(entry, seen));
  }
  seen.delete(value);
  return valid;
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
  const pluginRoot = `/api/${plugin}`;
  if (!REST_PATH.test(restPath) ||
      (restPath !== pluginRoot && !restPath.startsWith(`${pluginRoot}/`))) {
    throw new Error(
      `${where} REST path must be the safe plugin root "${pluginRoot}" or a nested ${pluginRoot}/ path.`,
    );
  }
  const canonicalParameters = restPathParameters(restPath);
  const aliases = operation.transports.rest.aliases;
  if (aliases !== undefined && !Array.isArray(aliases)) {
    throw new Error(`${where} REST aliases must be an array of paths.`);
  }
  for (const [index, alias] of (aliases ?? []).entries()) {
    if (typeof alias !== "string" || !REST_PATH.test(alias)) {
      throw new Error(`${where} REST alias[${index}] must be a safe absolute /api/... path.`);
    }
    const namespace = alias.split("/")[2]!;
    if (RESERVED_API_NAMESPACES.has(namespace) && alias === `/api/${namespace}`) {
      throw new Error(`${where} REST alias[${index}] cannot claim reserved API namespace root "${alias}".`);
    }
    const aliasParameters = restPathParameters(alias);
    if (aliasParameters.length !== canonicalParameters.length ||
        aliasParameters.some((parameter, parameterIndex) => parameter !== canonicalParameters[parameterIndex])) {
      throw new Error(
        `${where} REST alias[${index}] path parameters must match the canonical path exactly ` +
        `(${canonicalParameters.join(", ") || "none"}).`,
      );
    }
  }
  const ajv = new Ajv2020.default({ strict: true, allErrors: true });
  (addFormats as unknown as (instance: typeof ajv) => unknown)(ajv);
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
  const errorKeys = new Set<string>();
  for (const error of operation.errors) {
    if (!Number.isInteger(error.status) || error.status < 400 || error.status > 599) {
      throw new Error(`${where} error status must be an integer from 400 through 599.`);
    }
    nonEmpty(error.code, `${where} error code`);
    const errorKey = JSON.stringify([error.status, error.code]);
    if (errorKeys.has(errorKey)) {
      throw new Error(`${where} declares duplicate error status ${error.status} and code "${error.code}".`);
    }
    errorKeys.add(errorKey);
    nonEmpty(error.description, `${where} error description`);
    if (error.schema) assertSchema(ajv, error.schema, `${where} error ${error.code} schema`);
    if (error.rest) {
      if (error.rest.contentType !== undefined) {
        nonEmpty(error.rest.contentType, `${where} error ${error.code} REST content type`);
        if (!isJsonContentType(error.rest.contentType)) {
          throw new Error(`${where} error ${error.code} REST content type must be a JSON media type.`);
        }
      }
      if (Object.hasOwn(error.rest, "body")) {
        if (!isJsonValue(error.rest.body)) {
          throw new Error(`${where} error ${error.code} fixed REST body must be a JSON value.`);
        }
        const validateErrorBody = ajv.compile(error.schema ?? DEFAULT_OPERATION_ERROR_SCHEMA);
        if (!validateErrorBody(error.rest.body)) {
          throw new Error(`${where} error ${error.code} fixed REST body does not match its schema.`);
        }
        if (!error.schema) {
          const bodyCode = (error.rest.body as { error?: { code?: unknown } }).error?.code;
          if (bodyCode !== error.code) {
            throw new Error(
              `${where} error ${error.code} uses the default error schema, so its fixed REST body must carry the same error.code.`,
            );
          }
        }
      }
    }
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
      (!(operation.idempotency.header ?? "").trim() || !(operation.idempotency.inputField ?? "").trim())) {
    throw new Error(`${where} idempotency-key mode must name its header and canonical input field.`);
  }
  if (operation.idempotency.mode === "idempotency-key") {
    const field = operation.idempotency.inputField!;
    if (!(field in inputProperties) || !inputRequired.has(field)) {
      throw new Error(`${where} idempotency input field "${field}" must be a required inputSchema property.`);
    }
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
  // Core owns its internal precedence choices (for example a fixed route next
  // to a parameter fallback). Generated and plugin routes may overlap neither
  // those route languages nor each other.
  const rest: RestRoute[] = [...CORE_API_ROUTES];
  let dedicatedMcpTools = 0;

  const claimRest = (route: RestRoute): void => {
    const previous = rest.find((claimed) => restRoutesOverlap(claimed, route));
    if (previous) {
      const collision = previous.path === route.path
        ? "REST route"
        : normalizedRestRoute(previous.method, previous.path) === normalizedRestRoute(route.method, route.path)
          ? "normalized REST route shape"
          : "overlapping REST route";
      throw new Error(
        `${collision} "${route.method} ${route.path}" is claimed by both ${previous.owner} and ${route.owner}.`,
      );
    }
    rest.push(route);
  };

  for (const table of manifest.tables) {
    const owner = `entity ${table.schema}.${table.name}`;
    const entityRest = isGeneratedCrudEligible(table) ? table.source?.rest : undefined;
    if (entityRest) {
      const collectionPath = `/api/rest/v1/${entityRest.basePath}`;
      const itemPath = `${collectionPath}/:id`;
      if (entityRest.operations.list) claimRest({ method: "GET", path: collectionPath, owner });
      if (entityRest.operations.create) claimRest({ method: "POST", path: collectionPath, owner });
      if (entityRest.operations.get) claimRest({ method: "GET", path: itemPath, owner });
      if (entityRest.operations.update) claimRest({ method: "PATCH", path: itemPath, owner });
      if (entityRest.operations.delete) claimRest({ method: "DELETE", path: itemPath, owner });
    }
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
    for (const path of [
      operation.transports.rest.path,
      ...(operation.transports.rest.aliases ?? []),
    ]) {
      claimRest({ method: operation.transports.rest.method, path, owner });
    }
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
      const restPaths = [
        operation.transports.rest.path,
        ...(operation.transports.rest.aliases ?? []),
      ].sort();
      const graphqlKey = operation.transports.graphql.enabled
        ? `${operation.transports.graphql.kind}:${operation.transports.graphql.field}`
        : undefined;
      const typescriptKey = operation.transports.typescript.enabled
        ? operation.transports.typescript.functionName
        : undefined;
      if (keys.has(operation.key)) throw new Error(`Duplicate plugin operation key "${operation.key}".`);
      for (const path of restPaths) {
        const restKey = normalizedRestRoute(operation.transports.rest.method, path);
        if (rest.has(restKey)) throw new Error(`Duplicate plugin operation REST route "${restKey}".`);
        rest.add(restKey);
      }
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
      if (operation.transports.mcp.enabled) mcp.add(operation.transports.mcp.name);
      if (graphqlKey) graphql.add(graphqlKey);
      if (typescriptKey) typescript.add(typescriptKey);
      operations.push({
        ...operation,
        plugin: plugin.name,
        transports: {
          ...operation.transports,
          rest: {
            ...operation.transports.rest,
            ...(operation.transports.rest.aliases
              ? { aliases: [...operation.transports.rest.aliases].sort() }
              : {}),
          },
        },
      });
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

type OperationError = PluginOperationContract["errors"][number];

function operationErrorContentType(error: OperationError): string {
  return error.rest?.contentType ?? "application/json";
}

function singleOperationErrorMedia(error: OperationError): Record<string, unknown> {
  return {
    schema: error.schema ?? { $ref: "#/components/schemas/Error" },
    ...(error.rest && Object.hasOwn(error.rest, "body")
      ? { example: error.rest.body }
      : {}),
  };
}

function sharedOperationErrorSchema(error: OperationError): Record<string, unknown> {
  return {
    title: error.code,
    description: error.description,
    allOf: [
      error.schema ?? { $ref: "#/components/schemas/Error" },
      ...(!error.schema
        ? [{
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code"],
                properties: { code: { const: error.code } },
              },
            },
          }]
        : []),
    ],
  };
}

function sharedOperationErrorMedia(errors: readonly OperationError[]): Record<string, unknown> {
  if (errors.length === 1) return singleOperationErrorMedia(errors[0]!);
  const schemas = errors.map(sharedOperationErrorSchema);
  const fixed = errors.filter((error) => error.rest && Object.hasOwn(error.rest, "body"));
  return {
    schema: errors.every((error) => !error.schema)
      ? { oneOf: schemas }
      : { anyOf: schemas },
    ...(fixed.length > 0
      ? {
          examples: Object.fromEntries(fixed.map((error) => [
            error.code,
            { summary: error.description, value: error.rest!.body },
          ])),
        }
      : {}),
  };
}

function operationErrorResponse(errors: readonly OperationError[]): Record<string, unknown> {
  if (errors.length === 1) {
    const error = errors[0]!;
    return {
      description: error.description,
      content: {
        [operationErrorContentType(error)]: singleOperationErrorMedia(error),
      },
    };
  }
  const sorted = [...errors].sort((left, right) =>
    left.code < right.code ? -1 : left.code > right.code ? 1 : 0
  );
  const byContentType = new Map<string, OperationError[]>();
  for (const error of sorted) {
    const contentType = operationErrorContentType(error);
    const mediaErrors = byContentType.get(contentType) ?? [];
    mediaErrors.push(error);
    byContentType.set(contentType, mediaErrors);
  }
  return {
    description: sorted.map((error) => `${error.code}: ${error.description}`).join("\n\n"),
    content: Object.fromEntries(
      [...byContentType.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([contentType, mediaErrors]) => [
          contentType,
          sharedOperationErrorMedia(mediaErrors),
        ]),
    ),
  };
}

export function operationOpenApiPaths(
  operations: readonly CompiledPluginOperation[],
  sessionSecuritySchemes: readonly string[] = ["bearerAuth"],
): Record<string, unknown> {
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
    const errorsByStatus = new Map<number, OperationError[]>();
    for (const error of operation.errors) {
      const statusErrors = errorsByStatus.get(error.status) ?? [];
      statusErrors.push(error);
      errorsByStatus.set(error.status, statusErrors);
    }
    for (const [status, errors] of errorsByStatus) {
      responses[String(status)] = operationErrorResponse(errors);
    }
    const inputProperties = operation.inputSchema.properties as Record<string, unknown> | undefined;
    const required = new Set(Array.isArray(operation.inputSchema.required) ? operation.inputSchema.required as string[] : []);
    const idempotencyInputField = operation.idempotency.mode === "idempotency-key"
      ? operation.idempotency.inputField
      : undefined;
    const idempotencyParameters = operation.idempotency.mode === "idempotency-key"
      ? [{
          name: operation.idempotency.header!,
          in: "header",
          required: true,
          description: operation.idempotency.description,
          schema: { type: "string", minLength: 1 },
        }]
      : [];
    const method = rest.method.toLowerCase();
    const canonicalOpenApiPath = rest.path.replace(/:([_A-Za-z][_0-9A-Za-z]*)/g, "{$1}");
    const routePaths = [rest.path, ...(rest.aliases ?? [])];
    for (const [routeIndex, routePath] of routePaths.entries()) {
      const isAlias = routeIndex > 0;
      const openApiPath = routePath.replace(/:([_A-Za-z][_0-9A-Za-z]*)/g, "{$1}");
      const pathParameters = restPathParameters(routePath).map((name) => ({
        name,
        in: "path",
        required: true,
        schema: inputProperties?.[name] ?? { type: "string" },
      }));
      const pathNames = new Set(pathParameters.map((parameter) => parameter.name));
      const queryParameters = rest.method === "GET" || rest.method === "DELETE"
        ? Object.entries(inputProperties ?? {})
            .filter(([name]) => !pathNames.has(name) && name !== idempotencyInputField)
            .map(([name, schema]) => ({ name, in: "query", required: required.has(name), schema }))
        : [];
      const bodyProperties = Object.fromEntries(
        Object.entries(inputProperties ?? {}).filter(([name]) =>
          !pathNames.has(name) && name !== idempotencyInputField
        ),
      );
      const bodyRequired = [...required].filter((name) =>
        !pathNames.has(name) && name !== idempotencyInputField
      );
      const { required: _canonicalRequired, ...inputSchemaWithoutRequired } = operation.inputSchema;
      const bodySchema = {
        ...inputSchemaWithoutRequired,
        properties: bodyProperties,
        ...(bodyRequired.length > 0 ? { required: bodyRequired } : {}),
      };
      if (method in (paths[openApiPath] ?? {})) {
        throw new Error(`Duplicate plugin operation OpenAPI route "${rest.method} ${openApiPath}".`);
      }
      const sessionScopes = operation.auth.mode === "session"
        ? operation.auth.scopes ?? []
        : [];
      paths[openApiPath] = {
        ...(paths[openApiPath] ?? {}),
        [method]: {
          operationId: isAlias ? `${operation.key}.rest-alias.${routeIndex}` : operation.key,
          summary: operation.title,
          description: isAlias
            ? `${operation.description}\n\nDeprecated compatibility route. Use ${canonicalOpenApiPath}.`
            : operation.description,
          tags: [operation.plugin],
          security: operation.auth.mode === "public"
            ? []
            : operation.auth.mode === "session"
              ? sessionSecuritySchemes.map((scheme) => ({
                  [scheme]: scheme === "oauth2Auth" ? sessionScopes : [],
                }))
              : [{ [operation.auth.scheme]: [] }],
          ...(isAlias ? {
            deprecated: true,
            "x-osf-rest-alias": {
              canonicalOperationId: operation.key,
              canonicalPath: canonicalOpenApiPath,
            },
          } : {}),
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
  }
  return paths;
}
