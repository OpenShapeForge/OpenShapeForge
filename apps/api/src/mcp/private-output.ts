// SPDX-License-Identifier: BUSL-1.1
/** Private output uses the existing owner-bound, atomic handoff store. No result is stored. */
import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/server";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { PRIVATE_OUTPUT_TOOL_NAME, hasSensitiveOutput, assertSensitiveOutputSchema, splitSensitiveOutput } from "@openshapeforge/operations";
import { operationContractFingerprint } from "../operations/contract-fingerprint.js";
import { HttpError } from "../rest/http-error.js";
import { createHandoff, readLatestHandoffForSession, consumeHandoffForSession } from "./handoff-store.js";
import { ENTITY_CONFIGURATION_APP_URI, elicitedKeyring, supportsMcpApp } from "./handoff-config.js";
import { searchableSessionOperations } from "./searchable-session-operations.js";
import { ok, failed, type ToolResult } from "./tool-results.js";
import type { DirectCallScope } from "./tool-dispatch.js";

export const PRIVATE_OUTPUT_TOOL = PRIVATE_OUTPUT_TOOL_NAME;
export const privateOutputTool: Tool = {
  name: PRIVATE_OUTPUT_TOOL, title: "Complete private Operation",
  description: "Complete the owner-bound Operation from its private app. Never send its confidential output to the conversation.",
  inputSchema: { type: "object", required: ["handoffId"], properties: { handoffId: { type: "string", format: "uuid" } }, additionalProperties: false },
  _meta: { ui: { resourceUri: ENTITY_CONFIGURATION_APP_URI, visibility: ["app"] } },
};
export function needsPrivateOutput(definition: RuntimeOperationDefinition): boolean {
  return hasSensitiveOutput(definition.output.schema as Record<string, unknown>);
}

type Pending = { tenantId: string; userId: string; operationId: string; input: Record<string, unknown>; fingerprint: string };

export async function startPrivateOutput(ctx: DirectCallScope, definition: RuntimeOperationDefinition, input: Record<string, unknown>): Promise<ToolResult> {
  if (!supportsMcpApp(ctx.server)) throw new HttpError(409, "INTERACTION_REQUIRED", "This Operation needs an MCP client supporting private apps. Nothing was created.");
  if (!ctx.session.tenantId || !ctx.session.userId || !ctx.modulePlatform) throw new HttpError(403, "FORBIDDEN", "A signed-in tenant user is required.");
  assertSensitiveOutputSchema(definition.output.schema as Record<string, unknown>);
  if (definition.reliability.idempotency.mode !== "none" || definition.nativeMcpTool || definition.interaction?.secureInput || definition.interaction?.confirmation?.mode === "challenge") {
    throw new HttpError(409, "INTERACTION_REQUIRED", "This private output requires a direct, non-replayable Operation without private input.");
  }
  const keyring = elicitedKeyring();
  if (!keyring) throw new HttpError(503, "NOT_CONFIGURED", "OPENSHAPEFORGE_ELICITED_SECRET_KEYS is required for private Operations.");
  const id = randomUUID();
  await createHandoff({ db: ctx.db, session: ctx.session, keyring, id, kind: "operation_output",
    tenantId: ctx.session.tenantId, userId: ctx.session.userId,
    payload: { tenantId: ctx.session.tenantId, userId: ctx.session.userId, operationId: definition.id, input, fingerprint: operationContractFingerprint(definition) },
    expiresAtMs: Date.now() + 10 * 60_000 });
  return { ...ok({ data: { pending: true, operationId: definition.id }, operations: [] }),
    _meta: { privateOperation: { handoffId: id, operationId: definition.id, title: definition.name, input, inputSchema: definition.input.schema, completeTool: PRIVATE_OUTPUT_TOOL } } };
}

export async function completePrivateOutput(ctx: DirectCallScope): Promise<ToolResult> {
  let executionStarted = false;
  try {
    const args = ctx.request.params.arguments;
    if (Object.keys(args).some(k => k !== "handoffId") || typeof args.handoffId !== "string") throw new HttpError(400, "BAD_USER_INPUT", "Provide the private handoff id.");
    const keyring = elicitedKeyring();
    if (!keyring || !ctx.modulePlatform || !ctx.session.tenantId || !ctx.session.userId) throw new HttpError(403, "FORBIDDEN", "Private Operation unavailable.");
    // Session selection happens before lookup: another actor cannot inspect or consume the handoff.
    const held = await readLatestHandoffForSession<Pending>({ db: ctx.db, keyring, kind: "operation_output", session: ctx.session, id: args.handoffId });
    if (!held || held.payload.tenantId !== ctx.session.tenantId || held.payload.userId !== ctx.session.userId) throw new HttpError(410, "EXPIRED", "This private Operation expired or was already submitted. Do not automatically repeat it.");
    const { definitions } = await searchableSessionOperations(ctx);
    const definition = definitions.find(d => d.id === held.payload.operationId);
    if (!definition || !needsPrivateOutput(definition) || operationContractFingerprint(definition) !== held.payload.fingerprint) throw new HttpError(403, "FORBIDDEN", "The Operation is no longer available with this contract.");
    ctx.signal?.throwIfAborted(); ctx.assertParentInvocationActive?.(); ctx.assertInterceptorActive?.();
    if (!await consumeHandoffForSession({ db: ctx.db, kind: "operation_output", session: ctx.session, id: held.id })) throw new HttpError(410, "EXPIRED", "This private Operation was already submitted.");
    // Consume before side effects. A transport loss must never mint a second credential.
    executionStarted = true;
    const result = await ctx.modulePlatform.services.operations.execute(ctx.moduleSession, {
      operation: { id: definition.id, intent: definition.intent },
      // The person's submit click supplies the canonical acknowledgement, as a web form does.
      input: definition.interaction?.confirmation?.mode === "acknowledgement"
        ? { ...held.payload.input, confirmed: true } : held.payload.input,
      expectedContractFingerprint: held.payload.fingerprint,
    }, ctx.signal ? { signal: ctx.signal } : {});
    if ("error" in result) return { ...ok({ error: { code: "PRIVATE_OPERATION_FAILED", message: "Private Operation failed. Check its state before starting again.", retryable: false } }), isError: true };
    if (!("data" in result)) throw new HttpError(409, "INTERACTION_REQUIRED", "The Operation did not complete synchronously. Check its state before starting again.");
    const split = splitSensitiveOutput(definition.output.schema as Record<string, unknown>, result.data);
    // Do not forward handler-owned messages, links or follow-ups: they may repeat a secret.
    return { ...ok({ data: split.publicValue, operations: [] }), _meta: { privateOutput: { fields: split.privateFields } } };
  } catch (error) {
    // Unknown handler messages can contain credentials. Never echo them to the model.
    return failed(!executionStarted && error instanceof HttpError ? error : new HttpError(500, "PRIVATE_OPERATION_FAILED", "The private Operation outcome is uncertain. Check its state before starting again."));
  }
}
