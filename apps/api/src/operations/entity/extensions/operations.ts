// SPDX-License-Identifier: BUSL-1.1
/**
 * The native binding of the compiler-synthesized tenant field Operations
 * (packages/compiler/src/extension-operations.ts). The compiler emits each
 * as a static Operation in `catalog.operations` with
 *
 *   plugin:  "osf-extensions"
 *   handler: "fieldDefinitions.<action>" | "referencedBy"
 *   target:  { entityName: "<E>" (collection) | "<T>" (record, inputField id) }
 *   auth:    { mode: "session", roles }   manage roles for writes, E's/T's read roles for list/referencedBy
 *   tenancy: { mode: "required" }
 *   effects: { data: "read" | "write" | "delete" (delete only), external: "none" }
 *   transports.mcp.enabled: false        decision 16: REST + GraphQL only
 *
 * and operations/runtime.ts binds every Operation of that plugin here, like
 * the other core plugins, never a module handler. The handler repeats the
 * authorization against the registry (an Operation's role list is the
 * compiler's; the registry's manage roles are the contract) and runs inside
 * the live Operation transaction.
 */
import { operationFailure } from "@openshapeforge/operations";
import { withModuleOperationTransaction } from "../../../modules/platform.js";
import type { ModuleOperationHandler } from "../../../modules/contract.js";
import type { OperationContract } from "../../runtime.js";
import { executeFieldDefinitionAction, executeReferencedBy, type FieldDefinitionAction } from "./definitions.js";

export const EXTENSIONS_PLUGIN = "osf-extensions";
export type ExtensionOperationAction = FieldDefinitionAction | "referencedBy";

const FIELD_ACTIONS: readonly FieldDefinitionAction[] = ["list", "create", "update", "deprecate", "restore", "delete", "reorder", "affectedRecords", "rebuildIndex"];
const READS = new Set<ExtensionOperationAction>(["list", "affectedRecords", "referencedBy"]);

/** Validate a compiler-owned binding once at boot; never chosen by input. */
export function nativeExtensionBinding(operation: OperationContract): Readonly<{ entityName: string; action: ExtensionOperationAction }> {
  const handler = operation.handler;
  const action = (handler === "referencedBy" ? "referencedBy"
    : handler.startsWith("fieldDefinitions.") ? handler.slice("fieldDefinitions.".length) : undefined) as ExtensionOperationAction | undefined;
  const entityName = operation.target?.entityName;
  const expectedData = action === "delete" ? "delete" : action && READS.has(action) ? "read" : "write";
  if (operation.plugin !== EXTENSIONS_PLUGIN || !action ||
      !(action === "referencedBy" || FIELD_ACTIONS.includes(action as FieldDefinitionAction)) ||
      !entityName || !/^[A-Z][A-Za-z0-9]*$/.test(entityName) ||
      operation.target?.scope !== (action === "referencedBy" ? "record" : "collection") ||
      operation.auth.mode !== "session" || operation.tenancy.mode !== "required" ||
      operation.effects?.external !== "none" || operation.effects.data !== expectedData) {
    throw new Error(`Canonical tenant field Operation ${operation.key} has an unsupported or incomplete binding.`);
  }
  return Object.freeze({ entityName, action });
}

export function nativeExtensionHandler(operation: OperationContract): ModuleOperationHandler {
  const binding = nativeExtensionBinding(operation);
  return async (input, context) => {
    if (!context.session?.tenantId || !context.platform) {
      throw operationFailure({ code: "UNAUTHENTICATED", message: "Tenant fields require a verified tenant session." });
    }
    const session = context.session;
    const value = await withModuleOperationTransaction(context.platform, session, (trx) =>
      binding.action === "referencedBy"
        ? executeReferencedBy(trx, session, binding.entityName, input)
        : executeFieldDefinitionAction(trx, session, binding.entityName, binding.action, input));
    // MCP clients cache tools/list; the generic tools' input schemas carry
    // this tenant's fields (mcp/extension-schemas.ts), so every change of a
    // definition is a change of the tool list.
    if (!READS.has(binding.action)) context.platform.mcp.notifyToolsChanged({ tenantId: session.tenantId! });
    return { value };
  };
}
