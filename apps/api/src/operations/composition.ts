// SPDX-License-Identifier: BUSL-1.1
import { nativeColorPaletteHandler } from "./color-palette.js";
import { nativeCollectionOptionsHandler } from "./collection-options.js";
import { nativeApplicationSearchHandler } from "./application-search.js";
import { blueprintOperationHandler } from "./entity/blueprints.js";
import {
  TRANSITIONS_PLUGIN,
  transitionAvailabilityHandler,
  transitionOperationHandler,
} from "./entity/transitions.js";
import { CONTROL_PLUGIN, controlOperationHandler } from "../control/operations.js";
import { AUDIT_PLUGIN, auditOperationHandler } from "../platform/history-operations.js";
import { JOBS_PLUGIN, jobsOperationHandler } from "../jobs/operations.js";
import type { ModuleRuntimeContext, RuntimeModule } from "../modules/contract.js";
import type { RuntimeOperationExecutionResult } from "@openshapeforge/plugin-runtime";
import { type OperationEnvelope } from "@openshapeforge/operations";
import { type ModuleStaticOperationRegistration } from "../modules/platform.js";
import { nativeEntityTypeListHandler } from "./entity-type-list.js";
import { API_KEYS_PLUGIN, apiKeyOperationHandler } from "./api-key-operations.js";
import { RECORD_ACTIONS_PLUGIN, recordActionsOperationHandler } from "./record-action-assignments/operations.js";
import { GRANTS_PLUGIN, grantsOperationHandler } from "./grants-operations.js";
import { SOURCE_SYNC_PLUGIN, sourceSyncOperationHandler } from "./source-sync-operations.js";
import { EDIT_LEASES_PLUGIN, editLeaseOperationHandler } from "./edit-lease-operations.js";
import { BILLING_PLUGIN, billingOperationHandler } from "./billing/module.js";
import { nativeOwnedDeleteHandler } from "./owned-delete-runtime.js";
import { nativeCollectionHandler } from "./collection-runtime.js";
import { nativeConstrainedReferenceCreateHandler } from "./constrained-reference-create.js";
import { EXTENSIONS_PLUGIN, nativeExtensionHandler } from "./entity/extensions/operations.js";
import {
  entityPluginOperationContracts,
  invokeOperation,
  listOperationContracts,
  requireOperationAuthorization,
  runtimeDefinition,
  runtimeOperationError,
  type BoundOperation,
  type OperationContract,
} from "./runtime.js";

/** Bind compiler-contributed static Operations into the same runtime registry. */
export function runtimeStaticOperationRegistrations(
  modules: readonly RuntimeModule[],
  runtime: ModuleRuntimeContext,
  operations: readonly OperationContract[] = listOperationContracts(),
): readonly ModuleStaticOperationRegistration[] {
  const bound = bindOperationHandlers(modules, operations);
  return [...bound.values()].map((entry) => {
    const definition = runtimeDefinition(entry);
    return {
      definition,
      available: (session) => {
        try {
          requireOperationAuthorization(entry.operation, session);
          return true;
        } catch {
          return false;
        }
      },
      execute: async (session, request, options): Promise<RuntimeOperationExecutionResult> => {
        options?.signal?.throwIfAborted();
        const input = { ...(request.input ?? {}) };
        // Workflow workers already send their persisted command key on every
        // attempt. Use it as the optional source-page effect key so existing
        // import graphs can recover the same receipt without a graph edit.
        if (entry.operation.key === "source-sync.apply-page" &&
            request.idempotencyKey !== undefined && input.effectKey === undefined) {
          input.effectKey = request.idempotencyKey;
        }
        if (entry.operation.idempotency.mode === "idempotency-key") {
          const field = entry.operation.idempotency.inputField!;
          const key = request.idempotencyKey ?? (typeof input[field] === "string" ? input[field] as string : undefined);
          if (!key?.trim()) {
            return {
              error: {
                code: "IDEMPOTENCY_KEY_REQUIRED",
                message: "This Operation requires an idempotency key.",
                retryable: false,
              },
            };
          }
          if (field in input && input[field] !== key) {
            return {
              error: {
                code: "BAD_USER_INPUT",
                message: "The Operation input conflicts with its idempotency key.",
                retryable: false,
              },
            };
          }
          input[field] = key;
        }
        try {
          const result = await invokeOperation(entry, input, {
            ...runtime,
            transport: "operation",
            session,
            ...(options?.signal ? { signal: options.signal } : {}),
          });
          options?.signal?.throwIfAborted();
          return result.resultKind === "operation-envelope"
            ? result.value as OperationEnvelope<unknown>
            : { data: result.value, operations: [] };
        } catch (error) {
          return { error: runtimeOperationError(error) };
        }
      },
    };
  });
}

const bindingCache = new WeakMap<readonly RuntimeModule[], Map<string, BoundOperation>>();

/**
 * Whether any module in this process claims a canonical operation.
 *
 * A build with no such module — a core-only deployment, or a test that
 * resolves no modules — advertises no operation tools rather than failing
 * every request over a handler nothing was ever going to provide. The moment
 * one operation module is present, every operation has to bind, and
 * `bindOperationHandlers` throws for the ones that cannot. REST boot
 * (roles/api.ts) and the MCP server (mcp/generated-mcp-server.ts) read this
 * one rule, so the two transports cannot disagree about whether operations
 * exist.
 */
export function operationModulesConfigured(
  modules: readonly Pick<RuntimeModule, "name">[],
  operations: readonly OperationContract[] = listOperationContracts(),
): boolean {
  const plugins = new Set(operations.map((operation) => operation.plugin));
  return modules.some((module) => plugins.has(module.name));
}

export type BindOperationOptions = {
  /**
   * Whether plugin operations must bind. "required" is what a host that
   * configured an operation module wants — including one whose module failed
   * to load, so the failure stops boot instead of silently deleting the API.
   * "absent" is a process without any operation module: the core operations
   * bind, the plugin ones are absent rather than broken. Defaults to what the
   * given modules say ({@link operationModulesConfigured}).
   */
  pluginOperations?: "required" | "absent";
};

export function bindOperationHandlers(
  modules: readonly RuntimeModule[],
  operations: readonly OperationContract[] = listOperationContracts(),
  options: BindOperationOptions = {},
): Map<string, BoundOperation> {
  const pluginOperations = options.pluginOperations ??
    (operationModulesConfigured(modules, operations) ? "required" : "absent");
  const usesGeneratedCatalog = operations === listOperationContracts();
  const cached = usesGeneratedCatalog && pluginOperations === "required" ? bindingCache.get(modules) : undefined;
  if (cached) return cached;
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  const bound = new Map<string, BoundOperation>();
  const knownOperations = usesGeneratedCatalog
    ? [...listOperationContracts(), ...entityPluginOperationContracts()]
    : operations;
  for (const operation of operations) {
    if (bound.has(operation.key)) {
      throw new Error(
        `Canonical operation id "${operation.key}" is duplicated at runtime.`,
      );
    }
    if (operation.plugin === "osf-blueprints") {
      if (modulesByName.has("osf-blueprints")) throw new Error("The core blueprint runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: blueprintOperationHandler(operation.handler) });
      continue;
    }
    // Status transitions declared on entity fields are core too: one generic
    // handler plus the offer policy that hides a rule whose `from` does not
    // hold, so what a caller is offered is what the write will accept.
    if (operation.plugin === TRANSITIONS_PLUGIN) {
      if (modulesByName.has(TRANSITIONS_PLUGIN)) throw new Error("The core transition runtime cannot be replaced by a plugin.");
      bound.set(operation.key, {
        operation,
        handler: transitionOperationHandler(operation),
        availability: transitionAvailabilityHandler(operation),
      });
      continue;
    }
    // The platform's own administration is core too: its handlers ship with
    // the runtime (control/operations.ts) and bind in every process, so a
    // core-only deployment administers itself without an operation module.
    if (operation.plugin === CONTROL_PLUGIN) {
      if (modulesByName.has(CONTROL_PLUGIN)) throw new Error("The core control runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: controlOperationHandler(operation) });
      continue;
    }
    // The durable job queue is core as well: its handlers (jobs/operations.ts)
    // bind in every process, so a deployment administers its outbox without
    // an operation module.
    if (operation.plugin === AUDIT_PLUGIN) {
      if (modulesByName.has(AUDIT_PLUGIN)) throw new Error("The core audit runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: auditOperationHandler(operation) });
      continue;
    }
    if (operation.plugin === JOBS_PLUGIN) {
      if (modulesByName.has(JOBS_PLUGIN)) throw new Error("The core jobs runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: jobsOperationHandler(operation) });
      continue;
    }
    if (operation.plugin === GRANTS_PLUGIN) {
      if (modulesByName.has(GRANTS_PLUGIN)) throw new Error("The core capability grant runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: grantsOperationHandler(operation) });
      continue;
    }
    // The integration/API-key catalog is core as well: its handlers
    // (operations/api-key-operations.ts) call the one provisioning service and
    // therefore the one privilege ceiling, so they bind wherever the
    // authentication path they provision for binds.
    if (operation.plugin === API_KEYS_PLUGIN) {
      if (modulesByName.has(API_KEYS_PLUGIN)) throw new Error("The core API key catalog runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: apiKeyOperationHandler(operation) });
      continue;
    }
    // The named record-action axis is core as well, BOTH halves of it: the
    // one Operation that may write the axis
    // (operations/record-action-operations.ts) and the manager's view of what
    // it wrote (operations/record-action-assignments). Emphatically not
    // replaceable — a plugin standing in for the writer would be a second
    // writer of the axis, which is the one thing the single-writer design
    // exists to prevent — and bound once, so one plugin name cannot acquire
    // two differently-guarded bindings.
    if (operation.plugin === RECORD_ACTIONS_PLUGIN) {
      if (modulesByName.has(RECORD_ACTIONS_PLUGIN)) throw new Error("The core record action runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: recordActionsOperationHandler(operation) });
      continue;
    }
    // Importing records from an external source system by their base source
    // fields is core: it writes through the entities' own CRUD, so it binds
    // wherever those entities do (operations/source-sync-operations.ts).
    if (operation.plugin === SOURCE_SYNC_PLUGIN) {
      if (modulesByName.has(SOURCE_SYNC_PLUGIN)) throw new Error("The core source-sync runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: sourceSyncOperationHandler(operation) });
      continue;
    }
    // The central edit-lease service is core too: it is the same service the
    // generated entity Operations and every interface adapter already use
    // (operations/edit-lease-operations.ts), so it binds wherever they do.
    if (operation.plugin === EDIT_LEASES_PLUGIN) {
      if (modulesByName.has(EDIT_LEASES_PLUGIN)) throw new Error("The core edit-lease runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: editLeaseOperationHandler(operation) });
      continue;
    }
    // Tenant field definitions and referencedBy are core as well
    // (operations/entity/extensions): the compiler emits them for every
    // extensible entity and reference target, with no module behind them.
    if (operation.plugin === EXTENSIONS_PLUGIN) {
      if (modulesByName.has(EXTENSIONS_PLUGIN)) throw new Error("The core tenant field runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: nativeExtensionHandler(operation) });
      continue;
    }
    // Billing is core as well: the milestone run and the milestone create
    // (operations/billing) bind in every process, entity-authored plugin
    // Operations included, so the ERP entities carry their own behaviour.
    if (operation.plugin === BILLING_PLUGIN) {
      if (modulesByName.has(BILLING_PLUGIN)) throw new Error("The core billing runtime cannot be replaced by a plugin.");
      bound.set(operation.key, { operation, handler: billingOperationHandler(operation) });
      continue;
    }
    if (operation.implementation?.type === "collection-options") {
      bound.set(operation.key, { operation, handler: nativeCollectionOptionsHandler(operation, modules) });
      continue;
    }
    if (operation.implementation?.type === "application-search") {
      bound.set(operation.key, { operation, handler: nativeApplicationSearchHandler(operation) });
      continue;
    }
    if (operation.implementation?.type === "color-palette") {
      bound.set(operation.key, { operation, handler: nativeColorPaletteHandler(operation) });
      continue;
    }
    if (operation.implementation?.type === "entity-type-list") {
      bound.set(operation.key, { operation, handler: nativeEntityTypeListHandler(operation) });
      continue;
    }
    if (operation.implementation?.type === "ownedDelete") {
      bound.set(operation.key, { operation, handler: nativeOwnedDeleteHandler(operation) });
      continue;
    }
    if (operation.implementation?.type === "collection") {
      bound.set(operation.key, { operation, handler: nativeCollectionHandler(operation) });
      continue;
    }
    if (operation.implementation?.type === "constrained-reference-create") {
      bound.set(operation.key, { operation, handler: nativeConstrainedReferenceCreateHandler(operation) });
      continue;
    }

    if (pluginOperations === "absent") continue;
    const module = modulesByName.get(operation.plugin);
    if (!module) {
      throw new Error(`Canonical operation "${operation.key}" has no loaded runtime module "${operation.plugin}".`);
    }
    const handler = module?.operationHandlers?.[operation.handler];
    if (!handler) {
      throw new Error(`Canonical operation "${operation.key}" has no runtime handler "${operation.handler}" in module "${operation.plugin}".`);
    }
    const availability = module.operationAvailabilityHandlers?.[operation.handler];
    if (availability && (operation.auth.mode !== "session" || operation.tenancy.mode !== "required" ||
      operation.target?.scope !== "record" || !operation.target.inputField)) {
      throw new Error(`Operation "${operation.key}" availability requires an authenticated tenant record target.`);
    }
    bound.set(operation.key, { operation, handler, maintenanceOwner: module, ...(availability ? { availability } : {}) });
  }
  for (const module of modules) {
    const moduleOperations = knownOperations.filter((operation) => !operation.implementation && operation.plugin === module.name);
    // Explicit test/embedded catalogs validate only modules represented by that
    // catalog; production's generated catalog still validates every module.
    if (!usesGeneratedCatalog && moduleOperations.length === 0) continue;
    const declared = new Set(moduleOperations.map((operation) => operation.handler));
    const extras = Object.keys(module.operationHandlers ?? {}).filter((handler) => !declared.has(handler));
    if (extras.length > 0) {
      throw new Error(`Runtime module "${module.name}" has operation handlers absent from its compiler contract: ${extras.sort().join(", ")}.`);
    }
    const extraAvailability = Object.keys(module.operationAvailabilityHandlers ?? {}).filter(key => !declared.has(key));
    if (extraAvailability.length > 0) throw new Error(`Runtime module "${module.name}" has availability handlers absent from its compiler contract.`);
  }
  if (usesGeneratedCatalog && pluginOperations === "required") bindingCache.set(modules, bound);
  return bound;
}
