// SPDX-License-Identifier: BUSL-1.1
import { crudToolAvailable } from "./session-projection.js";
import { GENERIC_DESCRIBE_TOOL_NAME } from "@openshapeforge/operations";
import { HttpError } from "../rest/http-error.js";
import { type CatalogTool, catalog } from "./catalog.js";
import { requireArguments } from "./entity-tool-guards.js";
import { describeGenericEntity, resolveCrudTool } from "./generic-tool-projection.js";
import { failed, ok } from "./tool-results.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DirectCallScope } from "./tool-dispatch.js";
import { derivedToolCall } from "./dispatch-derived-tool.js";
import { crudToolCall } from "./dispatch-crud-tool.js";

/**
 * The entity section of tool dispatch. Split out of generated-mcp-server.ts.
 */

/**
 * The entity tools: osf_describe, the dedicated and generic CRUD tools, and
 * — when no static tool owns the name — the derived (row-defined) tools.
 * Always answers: an unknown name is the same NOT_FOUND an unauthorized one gets.
 */
export async function entityToolCall(
  ctx: DirectCallScope,
): Promise<CallToolResult | undefined> {
  const {
    assertInterceptorActive,
    assertParentInvocationActive,
    db,
    egressOwner,
    egressSource,
    extra,
    idempotencyKey,
    internalDerivedDefinition,
    leadCapture,
    locale,
    modulePlatform,
    moduleSession,
    name,
    onDerivedDefinitionChanged,
    operations,
    request,
    selected,
    selectedReference,
    server,
    session,
    signal,
    tables,
  } = ctx;
  if (name === GENERIC_DESCRIBE_TOOL_NAME) {
    try {
      const args = requireArguments(request.params.arguments ?? {});
      return ok({
        data: describeGenericEntity(args.entity, args.operation, session, tables, locale),
        operations: [],
      });
    } catch (error) {
      return failed(error);
    }
  }
  // A generic (`osf_*`) name is carried by one catalog entry per entity, so
  // the `entity` argument is what picks the entry — bounded to the entities
  // this session may invoke the operation on.
  let match: CatalogTool | undefined;
  try {
    match = resolveCrudTool(
      name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      session,
      tables,
    );
  } catch (error) {
    return failed(error);
  }
  const table = match ? tables.get(match.table) : undefined;
  // An unknown tool and one the caller may not invoke get the same answer:
  // the listing already omitted both, so distinguishing them would leak
  // which entities exist.
  if (
    !match ||
    !table ||
    !crudToolAvailable(match, session, tables)
  ) {
    // Not a static tool — a derived (row-defined) tool may own the name.
    // Execution of derived tools is a later slice: the definition names an
    // intent, but the connection/execution machinery that fulfils it does
    // not exist yet, so the honest answer is a clear failure, not a stub
    // success an agent would act on.
    const derivedOutcome = await derivedToolCall(ctx);
    if (derivedOutcome !== undefined) return derivedOutcome;
    return failed(new HttpError(404, "NOT_FOUND", `Unknown tool "${name}".`));
  }
  const entity = catalog.entities.find(
    (item) => item.entity === match.entity,
  );
  return crudToolCall(ctx, match, table, entity);
}
