// SPDX-License-Identifier: BUSL-1.1
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { operationReferenceKeyword, operationI18nKeyword } from "@openshapeforge/operations";
import type {
  CompilerPlugin,
  CompiledPluginOperation,
  CompiledStaticEntityOperation,
  JsonSchema,
  PluginBaseContext,
  PluginOperationContract,
} from "./plugins.js";
import type { CompiledConnectorContract } from "./authoring/types/connector.js";
import type { CompiledEntityOperation } from "./authoring/types.js";
import type {
  EntityOperationDefinition,
  OperationCatalogDefinition,
} from "./authoring/types.js";
import type { LocalizedText } from "./authoring/types.js";
import type { CompiledEntityInfo } from "./plugins.js";
import type { CoreReferentiedataSnapshot } from "./core-referentiedata-artifacts.js";
import { entityOperationJsonSchemas } from "./entity-operation-json-schema.js";
import type { PlatformSchemaManifest } from "./schema.js";
import { isGeneratedCrudEligible } from "./schema.js";
import { materializeCollectionOperations } from "./authoring/collection-operations.js";

const nativeBindings = new WeakMap<PluginOperationContract, NonNullable<CompiledPluginOperation["implementation"]>>();
const verifiedNativeOperations = new WeakMap<CompiledPluginOperation, string>();
import {
  SEARCHABLE_OPERATION_TOOL_NAMES,
  selectOperationToolProjection,
  type McpOperationToolProjection,
} from "./generate-mcp.js";

export type { CompiledPluginOperation } from "./plugins.js";

/**
 * Platform-owned mutation controls are derived from the canonical Operation
 * policy. Authors describe business input only; every adapter receives this
 * one augmented schema and therefore asks for the same lease/version or
 * confirmation values that the shared executor enforces.
 */
function withOperationControls(
  inputSchema: JsonSchema,
  definition: EntityOperationDefinition,
): JsonSchema {
  const properties = {
    ...((inputSchema.properties ?? {}) as Record<string, unknown>),
  };
  const required = new Set(
    Array.isArray(inputSchema.required) ? inputSchema.required as string[] : [],
  );
  const dependentRequired = {
    ...((inputSchema.dependentRequired ?? {}) as Record<string, string[]>),
  };

  if (definition.concurrency?.version) {
    properties.expectedVersion = {
      type: "string",
      format: "date-time",
      "x-osf-i18n": { title: { en: "Expected version", nl: "Verwachte versie" } },
      description: `Version from the record's ${definition.concurrency.version.field} field.`,
    };
    required.add("expectedVersion");
  }
  if (definition.concurrency?.editLease) {
    properties.leaseToken = {
      type: "string",
      minLength: 1,
      description: "Opaque edit-lease token issued by the server for this Operation and record.",
    };
    required.add("leaseToken");
  }
  if (definition.confirmation.mode === "acknowledgement") {
    properties.confirmed = {
      type: "boolean",
      description: "Set to true after the user explicitly acknowledges this Operation.",
    };
  }
  if (definition.confirmation.mode === "challenge") {
    properties.confirmationToken = {
      type: "string",
      minLength: 1,
      description: "Opaque, single-use confirmation challenge token issued by the server.",
    };
    properties.confirmationAnswer = {
      type: "string",
      minLength: 1,
      description: `Exact current value requested for ${definition.confirmation.challenge.field}.`,
    };
    dependentRequired.confirmationToken = ["confirmationAnswer"];
    dependentRequired.confirmationAnswer = ["confirmationToken"];
  }

  return {
    ...inputSchema,
    properties,
    ...(required.size > 0 ? { required: [...required] } : {}),
    ...(Object.keys(dependentRequired).length > 0 ? { dependentRequired } : {}),
  };
}

const KEY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const AUTHORED_KEY = /^[a-zA-Z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/;
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
 * Built-in /api routes reserved from generated and plugin operations.
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
  { method: "POST", path: "/api/artifacts", owner: "core artifact transport" },
  { method: "GET", path: "/api/artifacts/:artifactId/contents", owner: "core artifact transport" },
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

function validateOperation(plugin: string, operation: PluginOperationContract, authored = false): void {
  const where = `Plugin "${plugin}" operation "${operation.key}"`;
  if (!operation.transports?.typescript) {
    throw new Error(`${where} must declare an explicit TypeScript projection or disabled reason.`);
  }
  if (!(authored ? AUTHORED_KEY : KEY).test(operation.key) || (!authored && !operation.key.startsWith(`${plugin}.`))) {
    throw new Error(authored ? `${where} must use a stable alphanumeric identifier separated by dots or hyphens.`
      : `${where} must use a stable lowercase key prefixed with "${plugin}.".`);
  }
  nonEmpty(operation.title, `${where} title`);
  nonEmpty(operation.description, `${where} description`);
  nonEmpty(operation.handler, `${where} handler`);
  if (!IDENTIFIER.test(operation.handler)) {
    throw new Error(`${where} handler must be a TypeScript identifier.`);
  }
  const restPath = operation.transports.rest.path;
  const apiNamespace = authored ? operation.key.split(".")[0]! : plugin;
  const routeNamespace = restPath.split("/")[2] ?? "";
  const reservedNamespace = (authored ? [routeNamespace] : [apiNamespace, plugin, routeNamespace])
    .find(value => RESERVED_API_NAMESPACES.has(value.toLowerCase()));
  if (reservedNamespace) {
    throw new Error(`${where} uses reserved API namespace "${reservedNamespace}".`);
  }
  const pluginRoot = `/api/${apiNamespace}`;
  const allowedRoots = authored ? [pluginRoot, `/api/${plugin}`] : [pluginRoot];
  // Authored projections own explicit safe paths; identity and implementation
  // ownership do not rename existing endpoints. Global route collision audits
  // remain authoritative, while imperative plugins keep their prefix boundary.
  if (!REST_PATH.test(restPath) ||
      (!authored && !allowedRoots.some(root => restPath === root || restPath.startsWith(`${root}/`)))) {
    throw new Error(
      `${where} REST path must be the safe plugin root "${pluginRoot}" or a nested ${pluginRoot}/ path.`,
    );
  }
  const ajv = operationSchemaValidator();
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
  if (
    operation.auth.mode === "session" &&
    operation.auth.recordPermission !== undefined &&
    (operation.target?.scope !== "record" || !operation.target.inputField)
  ) {
    throw new Error(
      `${where} recordPermission requires a record target with inputField.`,
    );
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

function operationSchemaValidator() {
  const ajv = new Ajv2020.default({ strict: true, allErrors: true });
  (addFormats as unknown as (instance: typeof ajv) => unknown)(ajv);
  ajv.addKeyword({
    keyword: "x-osf-sourceField",
    schemaType: "string",
    valid: true,
  });
  ajv.addKeyword({
    keyword: "x-osf-control",
    schemaType: "string",
    valid: true,
  });
  ajv.addKeyword(operationReferenceKeyword);
  ajv.addKeyword(operationI18nKeyword);
  return ajv;
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
): McpOperationToolProjection {
  const graphql = new Map<string, string>();
  const mcp = new Map<string, string>();
  // Core owns its internal precedence choices (for example a fixed route next
  // to a parameter fallback). Generated and plugin routes may overlap neither
  // those route languages nor each other.
  const rest: RestRoute[] = [...CORE_API_ROUTES];
  let dedicatedMcpTools = 0;
  let operationMcpTools = 0;

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
      for (const [intent, name] of [
        ["get", entityGraphql.singleQueryName],
        ["list", entityGraphql.listQueryName],
        ["create", entityGraphql.createMutationName],
        ["update", entityGraphql.updateMutationName],
        ["delete", entityGraphql.deleteMutationName],
      ] as const) {
        if (entityGraphql.operations?.[intent] !== false) claimSurface(graphql, "GraphQL root field", name, owner);
      }
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
    claimRest({
      method: operation.transports.rest.method,
      path: operation.transports.rest.path,
      owner,
    });
    if (operation.transports.graphql.enabled) {
      claimSurface(graphql, "GraphQL root field", operation.transports.graphql.field, owner);
    }
    if (operation.transports.mcp.enabled) {
      claimSurface(mcp, "MCP tool", operation.transports.mcp.name, owner);
      operationMcpTools += 1;
    }
  }

  const projection = selectOperationToolProjection(
    dedicatedMcpTools,
    operationMcpTools,
    maxDedicatedMcpTools,
  );
  if (projection === "searchable") {
    claimSurface(
      mcp,
      "MCP tool",
      SEARCHABLE_OPERATION_TOOL_NAMES.search,
      "shared searchable Operation catalog",
    );
    claimSurface(
      mcp,
      "MCP tool",
      SEARCHABLE_OPERATION_TOOL_NAMES.execute,
      "shared searchable Operation executor",
    );
  }
  return projection;
}

export function collectPluginOperations(
  plugins: readonly CompilerPlugin[],
  context: PluginBaseContext,
): CompiledPluginOperation[] {
  return collectOperationContracts(plugins, context, false);
}

/** Authored canonical identity is separate from the bound implementation owner. */
function collectOperationContracts(
  plugins: readonly CompilerPlugin[],
  context: PluginBaseContext,
  authored: boolean,
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
      if (Object.hasOwn(operation, "implementation")) throw new Error(`Plugin ${plugin.name} cannot supply compiler-native implementation metadata.`);
      validateOperation(plugin.name, operation, authored);
      const restKey = normalizedRestRoute(
        operation.transports.rest.method,
        operation.transports.rest.path,
      );
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
      const compiled: CompiledPluginOperation = {
        ...operation,
        plugin: plugin.name,
        id: operation.key,
        intent: "invoke",
      };
      const native = authored ? nativeBindings.get(operation) : undefined;
      if (native) {
        compiled.implementation = { ...native };
        verifiedNativeOperations.set(compiled, JSON.stringify(native));
      }
      operations.push(compiled);
    }
  }
  return operations.sort((left, right) => left.key.localeCompare(right.key));
}

function authoredText(
  value: string | LocalizedText,
): string {
  if (typeof value === "string") return value;
  return value.en ?? value.nl ?? value.fr ?? "";
}

function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function snake(value: string): string {
  return kebab(value).replace(/-/g, "_");
}

function lowerCamel(value: string): string {
  const parts = kebab(value).split("-").filter(Boolean);
  return parts.map((part, index) =>
    index === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`
  ).join("");
}

/**
 * Lower strict-v2 YAML plugin Operations to the established canonical static
 * registry. YAML owns every contract field; the runtime module supplies only
 * the named handler implementation.
 */
export function collectAuthoredEntityPluginOperations(
  entities: readonly Pick<CompiledEntityInfo, "contract">[],
  context: PluginBaseContext,
  referentiedata: CoreReferentiedataSnapshot = {},
): CompiledPluginOperation[] {
  materializeCollectionOperations(entities, referentiedata);
  const byPlugin = new Map<string, PluginOperationContract[]>();
  for (const { contract } of entities) {
    for (const authored of contract.pluginOperations ?? []) {
      const definition = authored.definition;
      if (definition.implementation.type !== "plugin" && definition.implementation.type !== "collection") continue;
      const implementation = definition.implementation;
      const pluginName = implementation.type === "collection" ? "core" : implementation.plugin;
      const restProjection = authored.interfaces.rest;
      if (restProjection === undefined || restProjection === false) {
        throw new Error(
          `Entity plugin Operation "${authored.id}" currently requires an ` +
            "interfaces.rest projection so its existing static runtime handler has an address.",
        );
      }
      const mcpProjection = authored.interfaces.mcp;
      const graphqlProjection = authored.interfaces.graphql;
      const restMethod = restProjection.method ??
        (definition.effects.data === "read" ? "GET" : "POST");
      const targetSegment = definition.target?.scope === "record"
        ? `/:${definition.target.inputField}`
        : "";
      const inputSchema = withOperationControls(definition.input!.schema, definition);
      const outputSchema = definition.output!.schema;
      const idempotency = definition.reliability.idempotency;
      const operation: PluginOperationContract = {
        key: authored.id,
        title: authoredText(definition.name),
        description: authoredText(definition.description),
        handler: implementation.type === "collection" ? "collectionMutation" : implementation.handler,
        target: {
          entityId: authored.entityId,
          entityName: authored.entityName,
          scope: definition.target!.scope,
          ...(definition.target!.scope === "record"
            ? { inputField: definition.target!.inputField }
            : {}),
        },
        inputSchema,
        outputSchema,
        errors: definition.errors! as PluginOperationContract["errors"],
        auth: definition.auth!,
        tenancy: definition.tenancy!,
        idempotency: idempotency.mode === "natural"
          ? { mode: "intrinsic" }
          : idempotency.mode === "keyed"
            ? {
                mode: "idempotency-key",
                header: idempotency.header ?? "Idempotency-Key",
                inputField: idempotency.inputField!,
              }
            : { mode: "none" },
        effects: definition.effects,
        ...(definition.concurrency ? { concurrency: definition.concurrency } : {}),
        confirmation: definition.confirmation,
        transports: {
          rest: {
            method: restMethod,
            path: restProjection.path ??
              `/api/${pluginName}/${kebab(authored.entityName)}` +
                `${targetSegment}/${kebab(authored.key)}`,
            response: restProjection.response ?? { kind: "json" },
          },
          mcp: mcpProjection === undefined || mcpProjection === false
            ? {
                enabled: false,
                reason: "This entity interface does not project the Operation to MCP.",
              }
            : {
                enabled: true,
                name: mcpProjection.name ?? `${snake(authored.entityName)}_${snake(authored.key)}`,
              },
          graphql: graphqlProjection === undefined || graphqlProjection === false
            ? {
                enabled: false,
                reason: "This entity interface does not project the Operation to GraphQL.",
              }
            : {
                enabled: true,
                kind: graphqlProjection.kind ??
                  (definition.effects.data === "read" ? "query" : "mutation"),
                field: graphqlProjection.field ??
                  `${lowerCamel(authored.entityName)}${
                    authored.key[0]!.toUpperCase()
                  }${authored.key.slice(1)}`,
              },
          typescript: {
            enabled: true,
            functionName: `${lowerCamel(authored.entityName)}${
              authored.key[0]!.toUpperCase()
            }${authored.key.slice(1)}`,
          },
        },
      };
      if (implementation.type === "collection") nativeBindings.set(operation, {
        type: "collection", entityName: authored.entityName, field: implementation.field, action: implementation.action,
      });
      const current = byPlugin.get(pluginName) ?? [];
      current.push(operation);
      byPlugin.set(pluginName, current);
    }
  }
  const synthetic = [...byPlugin.entries()].map(([name, operations]) => ({
    name,
    operations,
  } satisfies CompilerPlugin));
  return [...collectOperationContracts(synthetic, context, true), ...(entities.some(({ contract }) => contract.model.fields.some((field) => field.options?.type === "dynamic" && field.options.source === "entityTypes.list")) ? collectEntityTypeListOperation(context, entities) : [])];
}

/** Built-in model discovery follows canonical Operation authentication and transport. */
function collectEntityTypeListOperation(context: PluginBaseContext, entities: readonly Pick<CompiledEntityInfo, "contract">[]): CompiledPluginOperation[] {
  const title = (en: string, nl: string) => ({ "x-osf-i18n": { title: { en, nl } } });
  const readRoles = [...new Set(entities.flatMap(({ contract }) => contract.authorization.roles.read))].sort();
  const operation: PluginOperationContract = {
    key: "entityTypes.list", title: "List entity types", description: "Search entity types readable by the current user.",
    handler: "listEntityTypes", auth: { mode: "session", roles: readRoles }, tenancy: { mode: "required" },
    idempotency: { mode: "none" }, effects: { data: "read", external: "none" },
    inputSchema: { type: "object", additionalProperties: false, properties: {
      locale: { ...title("Language", "Taal"), type: "string", enum: ["en", "nl"] }, search: { ...title("Search", "Zoeken"), type: "string", maxLength: 500 }, first: { ...title("Page size", "Paginagrootte"), type: "integer", minimum: 1, maximum: 100 }, after: { ...title("Cursor", "Cursor"), type: "string" },
    } },
    outputSchema: { type: "object", required: ["items", "pageInfo"], properties: {
      items: { ...title("Entity types", "Entiteitstypen"), type: "array", items: { type: "object", required: ["value", "label"], properties: { value: { ...title("Value", "Waarde"), type: "string" }, label: { ...title("Label", "Label"), type: "string" } } } },
      pageInfo: { ...title("Pagination", "Paginering"), type: "object", required: ["hasNextPage", "endCursor"], properties: { hasNextPage: { ...title("More results", "Meer resultaten"), type: "boolean" }, endCursor: { ...title("Next cursor", "Volgende cursor"), type: ["string", "null"] } } },
    } },
    errors: [],
    transports: {
      rest: { method: "GET", path: "/api/core/entity-types", response: { kind: "json" } },
      mcp: { enabled: true, name: "entity_types_list" },
      graphql: { enabled: true, kind: "query", field: "entityTypesList" },
      typescript: { enabled: true, functionName: "entityTypesList" },
    },
  };
  nativeBindings.set(operation, { type: "entity-type-list", labels: Object.fromEntries(entities.map(({ contract }) => [contract.entity.name, { en: contract.entity.labels?.en ?? contract.entity.title, nl: contract.entity.labels?.nl ?? contract.entity.title }])) });
  return collectOperationContracts([{ name: "core", operations: [operation] }], context, true);
}

/** Lower module/global YAML Operations through the same static registry. */
export function collectAuthoredModulePluginOperations(
  catalogs: readonly OperationCatalogDefinition[],
  context: PluginBaseContext,
): CompiledPluginOperation[] {
  const synthetic: CompilerPlugin[] = catalogs.map((catalog) => ({
    name: catalog.plugin,
    operations: Object.entries(catalog.operations).map(([key, definition]) => {
      if (definition.implementation.type !== "plugin") {
        throw new Error(`Module Operation "${key}" must use implementation.type plugin.`);
      }
      const restContract = catalog.interfaces.rest;
      const rest = restContract ? restContract.operations?.[key] ?? {} : undefined;
      if (rest === undefined || rest === false) {
        throw new Error(
          `Module Operation "${definition.id ?? key}" currently requires an ` +
            "interfaces.rest projection so its existing static runtime handler has an address.",
        );
      }
      const mcpContract = catalog.interfaces.mcp;
      const mcp = mcpContract ? mcpContract.operations?.[key] ?? {} : undefined;
      const graphqlContract = catalog.interfaces.graphql;
      const graphql = graphqlContract
        ? graphqlContract.operations?.[key] ?? {}
        : undefined;
      const idempotency = definition.reliability.idempotency;
      const canonicalId = definition.id ?? `${catalog.plugin}.${key}`;
      return {
        key: canonicalId,
        title: authoredText(definition.name),
        description: authoredText(definition.description),
        handler: definition.implementation.handler,
        inputSchema: withOperationControls(definition.input!.schema, definition),
        outputSchema: definition.output!.schema,
        errors: definition.errors! as PluginOperationContract["errors"],
        auth: definition.auth!,
        tenancy: definition.tenancy!,
        idempotency: idempotency.mode === "natural"
          ? { mode: "intrinsic" as const }
          : idempotency.mode === "keyed"
            ? {
                mode: "idempotency-key" as const,
                header: idempotency.header ?? "Idempotency-Key",
                inputField: idempotency.inputField!,
              }
            : { mode: "none" as const },
        effects: definition.effects,
        confirmation: definition.confirmation,
        transports: {
          rest: {
            method: rest.method ?? (definition.effects.data === "read" ? "GET" : "POST"),
            path: rest.path ?? `/api/${catalog.plugin}/${kebab(key)}`,
            response: rest.response ?? { kind: "json" as const },
          },
          mcp: mcp === undefined || mcp === false
            ? { enabled: false as const, reason: "The module interface does not project this Operation to MCP." }
            : { enabled: true as const, name: mcp.name ?? snake(canonicalId) },
          graphql: graphql === undefined || graphql === false
            ? { enabled: false as const, reason: "The module interface does not project this Operation to GraphQL." }
            : {
                enabled: true as const,
                kind: graphql.kind ?? (definition.effects.data === "read" ? "query" : "mutation"),
                field: graphql.field ?? lowerCamel(canonicalId),
              },
          typescript: { enabled: true as const, functionName: lowerCamel(canonicalId) },
        },
      } satisfies PluginOperationContract;
    }),
  }));
  return collectOperationContracts(synthetic, context, true);
}

export function collectEntityOperations(
  entities: readonly Pick<CompiledEntityInfo, "contract">[],
): CompiledEntityOperation[] {
  const operations = entities
    .flatMap((entity) => Object.values(entity.contract.entityOperations))
    .filter((operation): operation is CompiledEntityOperation => operation !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.id)) {
      throw new Error(`Duplicate entity operation id "${operation.id}".`);
    }
    ids.add(operation.id);
  }
  return operations;
}

/** Build the one deterministic namespace consumed by compiler plugins. */
export function buildStaticOperationCatalog(
  pluginOperations: readonly CompiledPluginOperation[],
  entityOperations: readonly CompiledEntityOperation[],
  entities: readonly Pick<CompiledEntityInfo, "contract">[],
  referentiedata: CoreReferentiedataSnapshot,
): import("./plugins.js").StaticOperationCatalog {
  const contracts = entities.map(({ contract }) => contract);
  const byEntityId = new Map(contracts.map((contract) => [contract.entity.id, contract]));
  const declaredIds = [...pluginOperations, ...entityOperations]
    .map((operation) => operation.id)
    .sort((left, right) => left.localeCompare(right));
  for (let index = 1; index < declaredIds.length; index += 1) {
    if (declaredIds[index - 1] === declaredIds[index]) {
      throw new Error(
        `Duplicate canonical Operation id "${declaredIds[index]}". ` +
          "Keep its metadata in exactly one entity or plugin/module declaration.",
      );
    }
  }
  const concreteEntityOperations = entityOperations.map((operation) => {
    const contract = byEntityId.get(operation.entityId);
    if (!contract) {
      throw new Error(
        `Canonical entity Operation "${operation.id}" references missing entity ` +
          `"${operation.entityId}" while building its concrete schemas.`,
      );
    }
    const concrete = {
      ...operation,
      ...entityOperationJsonSchemas(contract, operation, contracts, referentiedata),
    };
    if (operation.implementation.type === "plugin") {
      const ajv = operationSchemaValidator();
      assertSchema(ajv, concrete.inputSchema, `Entity Operation "${operation.id}" inputSchema`);
      assertSchema(ajv, concrete.outputSchema, `Entity Operation "${operation.id}" outputSchema`);
    }
    return concrete;
  });
  const operations = [...pluginOperations, ...concreteEntityOperations]
    .sort((left, right) => left.id.localeCompare(right.id));
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  for (const target of concreteEntityOperations) {
    for (const prerequisite of target.prerequisites ?? []) {
      const source = byId.get(prerequisite.operation);
      if (!source) {
        throw new Error(
          `Canonical entity Operation "${target.id}" references missing prerequisite ` +
            `Operation "${prerequisite.operation}".`,
        );
      }
      if (source.intent !== "invoke") {
        throw new Error(
          `Canonical entity Operation "${target.id}" prerequisite ` +
            `"${prerequisite.operation}" must be an authored invoke Operation.`,
        );
      }
      const requiredInput = Array.isArray(source.inputSchema.required)
        ? source.inputSchema.required
        : [];
      if (
        source.auth.mode !== "session" ||
        source.tenancy.mode !== "required" ||
        source.effects?.data !== "read" ||
        source.effects.external !== "none" ||
        requiredInput.length > 0
      ) {
        throw new Error(
          `Canonical entity Operation "${target.id}" prerequisite ` +
            `"${prerequisite.operation}" must use session auth, required tenancy, ` +
            "read/no-external effects and no required input so every interface can show it safely.",
        );
      }
    }
  }
  return { version: 1, operations };
}

export function renderOperationCatalog(
  catalog: import("./plugins.js").StaticOperationCatalog,
): string {
  const operations = catalog.operations.filter(
    (operation): operation is CompiledPluginOperation => operation.intent === "invoke",
  );
  const entityOperations = catalog.operations.filter(
    (operation): operation is CompiledStaticEntityOperation => operation.intent !== "invoke",
  );
  return `${JSON.stringify({ version: 1, operations, entityOperations }, null, 2)}\n`;
}

export function assertOperationRuntimeModules(
  operations: readonly CompiledPluginOperation[],
  runtimeModuleNames: Iterable<string>,
): void {
  const available = new Set(runtimeModuleNames);
  for (const operation of operations) {
    if (operation.implementation && (operation.plugin !== "core" || !["collectionMutation", "listEntityTypes"].includes(operation.handler) ||
      verifiedNativeOperations.get(operation) !== JSON.stringify(operation.implementation))) {
      throw new Error(`Operation ${operation.id} has unverified native implementation metadata.`);
    }
  }
  const missing = [...new Set(
    operations.filter((operation) => !operation.implementation && !available.has(operation.plugin)).map((operation) => operation.plugin),
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
    const openApiPath = rest.path.replace(/:([_A-Za-z][_0-9A-Za-z]*)/g, "{$1}");
    const pathParameters = restPathParameters(rest.path).map((name) => ({
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
        operationId: operation.key,
        summary: operation.title,
        description: operation.description,
        tags: [operation.plugin],
        security: operation.auth.mode === "public"
          ? []
          : operation.auth.mode === "session"
            ? sessionSecuritySchemes.map((scheme) => ({
                [scheme]: scheme === "oauth2Auth" ? sessionScopes : [],
              }))
            : [{ [operation.auth.scheme]: [] }],
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
