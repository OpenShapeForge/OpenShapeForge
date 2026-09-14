// SPDX-License-Identifier: BUSL-1.1
import type { CompiledEntityInfo, CompiledPluginOperation } from "./plugins.js";

export function collectBlueprintOperations(entities: readonly Pick<CompiledEntityInfo, "contract" | "slug">[]): CompiledPluginOperation[] {
  return entities.flatMap(({ contract, slug }) => {
    const blueprint = contract.blueprint;
    if (!blueprint) return [];
    const id = { type: "string", format: "uuid" };
    const version = { type: "integer", minimum: 1 };
    const source = { type: "object", additionalProperties: false, required: ["blueprintId", "label", "version"], properties: { blueprintId: { type: "string" }, label: { type: "string" }, version } };
    const inputs = {
      list: { properties: { search: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } }, required: [] },
      status: { properties: { id }, required: ["id"] },
      reset: { properties: { id, expectedVersion: { type: "string", format: "date-time" }, blueprintVersion: version, confirmed: { const: true } }, required: ["id", "expectedVersion", "blueprintVersion", "confirmed"] },
      publish: { properties: { id, expectedVersion: { type: "string", format: "date-time" } }, required: ["id", "expectedVersion"] },
    };
    const outputs = {
      list: { type: "object", additionalProperties: false, required: ["items", "nextCursor"], properties: { items: { type: "array", items: source }, nextCursor: { type: ["string", "null"] } } },
      status: { type: "object", additionalProperties: false, required: ["source", "updateAvailable"], properties: { source: { anyOf: [{ type: "null" }, { ...source, required: [...source.required, "latestVersion"], properties: { ...source.properties, latestVersion: version } }] }, updateAvailable: { type: "boolean" } } },
      reset: { type: "object", additionalProperties: true },
      publish: { type: "object", additionalProperties: false, required: ["blueprintId", "version"], properties: { blueprintId: { type: "string" }, version } },
    };
    return (['list', 'status', 'reset', 'publish'] as const).map((action): CompiledPluginOperation => {
      const roles = action === "publish" ? ["platform-operator"] : action === "list" ? [...new Set([...(contract.authorization?.roles.create ?? []), ...(contract.authorization?.roles.update ?? [])])] : contract.authorization?.roles.update ?? [];
      const concurrency = action === "reset" || action === "publish" ? { ...contract.entityOperations.update?.concurrency, version: contract.entityOperations.update?.concurrency?.version ?? { mode: "required" as const, field: "updatedAt" } } : undefined;
      const input = inputs[action];
      const inputSchema = { type: "object", additionalProperties: false, ...input,
        ...(concurrency?.editLease ? { properties: { ...input.properties, leaseToken: { type: "string", minLength: 1 } }, required: [...input.required, "leaseToken"] } : {}),
      };
      return {
        ...(concurrency ? { concurrency } : {}),
        plugin: "osf-blueprints", id: blueprint.operations[action], key: blueprint.operations[action], intent: "invoke",
        title: `${action[0]!.toUpperCase()}${action.slice(1)} ${contract.entity.title} blueprint`,
        description: `Use published blueprint content for ${contract.entity.title}.`,
        handler: `${contract.entity.name}.${action}`,
        target: { entityId: contract.entity.id, entityName: contract.entity.name, scope: action === "list" ? "collection" : "record", ...(action === "list" ? {} : { inputField: "id" }) },
        inputSchema, outputSchema: outputs[action], errors: [
          { code: "BAD_USER_INPUT", status: 400, description: "Invalid blueprint input." },
          { code: "FORBIDDEN", status: 403, description: "Blueprint access is not permitted." },
          { code: "NOT_FOUND", status: 404, description: "The record or blueprint is unavailable." },
          { code: "VERSION_CONFLICT", status: 409, description: "The record or blueprint changed." },
        ],
        auth: { mode: "session", roles, ...(contract.authorization?.rowAccess?.recordPermissions && action !== "list" ? { recordPermission: "edit" as const } : {}) }, tenancy: { mode: "required" },
        idempotency: { mode: action === "list" || action === "status" ? "intrinsic" : "none" },
        effects: { data: action === "list" || action === "status" ? "read" : "write", external: "none" },
        confirmation: { mode: action === "reset" ? "acknowledgement" : "none" },
        transports: {
          rest: { method: "POST", path: `/api/blueprints/${slug}/${action}`, response: { kind: "json" } },
          mcp: { enabled: true, name: `blueprint_${slug.replaceAll("-", "_")}_${action}` },
          graphql: { enabled: true, kind: action === "list" || action === "status" ? "query" : "mutation", field: `blueprint${contract.entity.name}${action[0]!.toUpperCase()}${action.slice(1)}` },
          typescript: { enabled: false, reason: "Execute through the canonical Operation interface." },
        },
      };
    });
  });
}
