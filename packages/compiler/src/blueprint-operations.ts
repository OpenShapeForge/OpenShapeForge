// SPDX-License-Identifier: BUSL-1.1
import type { CompiledEntityInfo, CompiledPluginOperation } from "./plugins.js";

export function collectBlueprintOperations(entities: readonly Pick<CompiledEntityInfo, "contract" | "slug">[]): CompiledPluginOperation[] {
  return entities.flatMap(({ contract, slug }) => {
    const blueprint = contract.blueprint;
    if (!blueprint) return [];
    // Every schema property carries both interface languages: hosts that require
    // complete UI translations reject generated operations without them.
    const titled = (schema: Record<string, unknown>, en: string, nl: string) => ({ ...schema, "x-osf-i18n": { title: { en, nl } } });
    const id = titled({ type: "string", format: "uuid" }, "Record", "Record");
    const version = titled({ type: "integer", minimum: 1 }, "Blueprint version", "Blueprintversie");
    const blueprintId = titled({ type: "string" }, "Blueprint", "Blueprint");
    const expectedVersion = titled({ type: "string", format: "date-time" }, "Expected record version", "Verwachte recordversie");
    const source = { type: "object", additionalProperties: false, required: ["blueprintId", "label", "version"], properties: { blueprintId, label: titled({ type: "string" }, "Label", "Label"), version } };
    const inputs = {
      list: { properties: { search: titled({ type: "string", maxLength: 200 }, "Search", "Zoeken"), limit: titled({ type: "integer", minimum: 1, maximum: 100 }, "Limit", "Limiet"), cursor: titled({ type: "string" }, "Cursor", "Cursor") }, required: [] },
      status: { properties: { id }, required: ["id"] },
      reset: { properties: { id, expectedVersion, blueprintVersion: version, confirmed: { const: true } }, required: ["id", "expectedVersion", "blueprintVersion", "confirmed"] },
      publish: { properties: { id, expectedVersion }, required: ["id", "expectedVersion"] },
    };
    const outputs = {
      list: { type: "object", additionalProperties: false, required: ["items", "nextCursor"], properties: { items: titled({ type: "array", items: source }, "Blueprints", "Blueprints"), nextCursor: titled({ type: ["string", "null"] }, "Next page", "Volgende pagina") } },
      status: { type: "object", additionalProperties: false, required: ["source", "updateAvailable"], properties: { source: titled({ anyOf: [{ type: "null" }, { ...source, required: [...source.required, "latestVersion"], properties: { ...source.properties, latestVersion: titled(version, "Latest blueprint version", "Nieuwste blueprintversie") } }] }, "Blueprint source", "Blueprintbron"), updateAvailable: titled({ type: "boolean" }, "Update available", "Update beschikbaar") } },
      reset: { type: "object", additionalProperties: true },
      publish: { type: "object", additionalProperties: false, required: ["blueprintId", "version"], properties: { blueprintId, version } },
    };
    return (['list', 'status', 'reset', 'publish'] as const).map((action): CompiledPluginOperation => {
      const roles = action === "publish" ? ["platform-operator"] : action === "list" ? [...new Set([...(contract.authorization?.roles.create ?? []), ...(contract.authorization?.roles.update ?? [])])] : contract.authorization?.roles.update ?? [];
      const concurrency = action === "reset" || action === "publish" ? { ...contract.entityOperations.update?.concurrency, version: contract.entityOperations.update?.concurrency?.version ?? { mode: "required" as const, field: "updatedAt" } } : undefined;
      const input = inputs[action];
      const inputSchema = { type: "object", additionalProperties: false, ...input,
        ...(concurrency?.editLease ? { properties: { ...input.properties, leaseToken: titled({ type: "string", minLength: 1 }, "Edit lease", "Bewerkingslease") }, required: [...input.required, "leaseToken"] } : {}),
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
