// SPDX-License-Identifier: BUSL-1.1
/**
 * What a claimed control command actually does to a run.
 *
 * `workflow.control_commands` records the intent — start, resume, cancel — and
 * `control-command-worker.ts` decides when to act on one. This module is the
 * acting. Each entry point takes a single claimed command and applies it inside
 * one database transaction, so a command either takes full effect or leaves no
 * trace of having been attempted; there is no partially-started run to reason
 * about, and a worker that dies mid-command leaves the row reclaimable.
 *
 * The command's `payload` is decoded here rather than by the worker on purpose.
 * The worker's job is claiming rows and retrying them, which it can do without
 * understanding any of them; a payload that does not decode is this module's
 * `BAD_COMMAND`, not a queue problem.
 *
 * **Where idempotency comes from.** Not from a durable-execution service. These
 * three functions were once fronted by one, and removing that wrapper changes
 * nothing about correctness, because none of the guarantees were ever its:
 *
 *   - `consumeRuntimeCommand` moves the command row out of `pending`/
 *     `processing` in a conditional update and reports whether it won. A
 *     redelivery loses that update, gets `false` back, and returns without
 *     touching the run.
 *   - the instance row is taken `for update` before anything is decided, so two
 *     workers holding the same command serialize instead of interleaving.
 *   - a run already in a terminal status returns early, so a command that
 *     arrives after a cancel — or after the run finished on its own — cannot
 *     revive it.
 *
 * Those three hold for any dispatcher, which is what makes the plain in-process
 * one correct: durability lives in the queue, not in whoever drains it.
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import { withDbSession } from "../../../../apps/api/src/db/session.js";
import { jsonbLiteral } from "../../../../apps/api/src/db/sql-helpers.js";
import type { DB, Json } from "../../../../apps/api/src/generated/db/types.js";
import {
  appendScopedEntityEventInTransaction,
  normalizeJsonValue,
} from "../../../../apps/api/src/platform/entity-events.js";
import {
  applyResumeAndCascadeInTransaction,
  cancelWorkflowInstanceInTransaction,
} from "./instance-completion.js";
import {
  resolveConfigValue,
  runProcessInstance,
  type ProcessRuntimeDefinition,
} from "./process-runtime.js";

/**
 * One shape for all three entry points, because the worker has one shape to
 * give: a claimed row, plus its opaque payload. Which command it is, is which
 * function you call.
 */
export type WorkflowCommandRuntimeInput = {
  commandId: string;
  tenantId: string;
  instanceId: string;
  payload: Record<string, unknown>;
};

export type WorkflowCommandRuntimeResult = {
  ok: true;
  commandId: string;
  instanceId: string;
  status: "running" | "resume_requested" | "cancelled";
};

export type WorkflowCommandRuntimeCommandType =
  | "workflow.instance.start"
  | "workflow.instance.resume"
  | "workflow.instance.cancel";

export class WorkflowCommandRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "WorkflowCommandRuntimeError";
  }
}

/**
 * The subject recorded when a resume has no human behind it — a child run
 * finishing, a timer firing. A real UUID rather than null because the database
 * session refuses to open without one, and an anonymous session is not a thing
 * this runtime is allowed to have.
 */
const SYSTEM_ACTOR_ID = "00000000-0000-4000-8000-000000000000";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TERMINAL_INSTANCE_STATUSES = ["completed", "failed", "cancelled"];

function normalizeUuid(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new WorkflowCommandRuntimeError(`${label} is required.`, "BAD_COMMAND");
  }
  if (!UUID_PATTERN.test(normalized)) {
    throw new WorkflowCommandRuntimeError(`${label} must be a UUID.`, "BAD_COMMAND");
  }
  return normalized;
}

function normalizeRequiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new WorkflowCommandRuntimeError(`${label} is required.`, "BAD_COMMAND");
  }
  return normalized;
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : null;
}

function normalizeOptionalUuid(value: unknown, label: string): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) return null;
  if (!UUID_PATTERN.test(normalized)) {
    throw new WorkflowCommandRuntimeError(`${label} must be a UUID.`, "BAD_COMMAND");
  }
  return normalized;
}

function normalizeOptionalInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * A command payload has been through `jsonb` and back, so a nested document can
 * still arrive as text; normalizing is what makes `context.foo` readable
 * regardless of how the enqueuing side happened to encode it.
 */
function normalizeRuntimeJson(value: unknown): Json {
  return normalizeJsonValue(value as Json);
}

function normalizeJsonRecord(value: unknown): Record<string, unknown> {
  const normalized = normalizeRuntimeJson(value ?? {});
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : {};
}

/**
 * Process workflow inputs — the variables an author wires up as
 * `{{input.<field>}}` — travel on the start command's `context`. The whole
 * context object is the trigger payload, so its top-level keys become
 * `input.X`. A non-record context is surfaced as `{ value: ... }` rather than
 * discarded, because a trigger that sent a scalar still sent something.
 */
function extractTriggerPayload(context: unknown): Record<string, unknown> {
  if (context && typeof context === "object" && !Array.isArray(context)) {
    return context as Record<string, unknown>;
  }
  return { value: context };
}

function definitionHasNode(definition: Json, nodeId: string): boolean {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return false;
  }
  const nodes = (definition as { nodes?: unknown }).nodes;
  return (
    Array.isArray(nodes) &&
    nodes.some(
      (node) =>
        Boolean(node) &&
        typeof node === "object" &&
        !Array.isArray(node) &&
        (node as { id?: unknown }).id === nodeId,
    )
  );
}

function normalizeProcessFields(definition: Json) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return [];
  }
  const fields = (definition as { processVariables?: unknown }).processVariables;
  if (!Array.isArray(fields)) {
    return [];
  }
  return fields.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key.trim() : "";
    if (!key) {
      return [];
    }
    return [{ key, defaultValue: record.defaultValue, value: record.value }];
  });
}

function normalizeProcessInitializers(definition: Json) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return [];
  }
  const initializers = (definition as { processVariableInitializers?: unknown })
    .processVariableInitializers;
  if (!Array.isArray(initializers)) {
    return [];
  }
  return initializers.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const targetKey = typeof record.targetKey === "string" ? record.targetKey.trim() : "";
    if (!targetKey) {
      return [];
    }
    return [{ targetKey, value: record.value ?? null }];
  });
}

/**
 * Seed `workflow.instances.process_variables` for a run that is about to start.
 *
 * The declared variable set is closed: a key the definition does not declare
 * cannot be introduced by an initializer or by the caller's overrides. That is
 * what makes `{{process.<key>}}` answerable from the definition alone — an
 * author can see every variable a run will have by reading the graph, and a
 * caller cannot smuggle state into a workflow that was never written to expect
 * it.
 *
 * Three layers, each overriding the last: the field's own value or default,
 * then any initializer targeting it, then the explicit overrides on the start
 * command. Declared values and initializers go through the same placeholder
 * resolution the runtime uses, so a default may itself read `{{input.x}}`;
 * overrides do not, because they arrive already resolved from the caller.
 */
export function initializeProcessVariables(input: {
  definition: Json;
  triggerPayload: Record<string, unknown>;
  overrides: Json;
}): Record<string, unknown> {
  const declared = normalizeProcessFields(input.definition);
  const declaredKeys = new Set(declared.map((field) => field.key));
  const processVariables: Record<string, unknown> = {};
  // `processVariables` is handed to the resolver by reference, so a later
  // field's default can read an earlier one that has already been seeded.
  const source = {
    triggerPayload: input.triggerPayload,
    processVariables,
    completedOutputs: new Map<string, Record<string, unknown>>(),
  };

  for (const field of declared) {
    const value = field.value ?? field.defaultValue;
    processVariables[field.key] = value !== undefined ? resolveConfigValue(value, source) : null;
  }

  for (const initializer of normalizeProcessInitializers(input.definition)) {
    if (!declaredKeys.has(initializer.targetKey)) {
      continue;
    }
    processVariables[initializer.targetKey] = resolveConfigValue(initializer.value, source);
  }

  for (const [key, value] of Object.entries(normalizeJsonRecord(input.overrides))) {
    if (declaredKeys.has(key)) {
      processVariables[key] = value;
    }
  }

  return processVariables;
}

/**
 * Pin the graph a run executes.
 *
 * An instance stores the version it started on, and that is what is loaded; the
 * latest version is only the answer when it has none, which happens for a
 * command enqueued before versions were pinned. Reading "latest" during a
 * resume would let an edit to the definition change what an in-flight run does
 * halfway through — the property the version table exists to prevent.
 */
export async function loadDefinitionVersion(
  trx: Transaction<DB>,
  input: { tenantId: string; definitionId: string; versionId: string | null },
) {
  if (input.versionId) {
    return trx
      .selectFrom("workflow.definition_versions")
      .select(["definition"])
      .where("tenant_id", "=", input.tenantId)
      .where("definition_id", "=", input.definitionId)
      .where("id", "=", input.versionId)
      .executeTakeFirst();
  }
  return trx
    .selectFrom("workflow.definition_versions")
    .select(["definition"])
    .where("tenant_id", "=", input.tenantId)
    .where("definition_id", "=", input.definitionId)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
}

/**
 * Claim a control command for execution, exactly once.
 *
 * The update is conditional on the row still being unconsumed, so it is the
 * claim: whoever's update returns a row is the one execution, and everyone else
 * gets `false` and must do nothing. This — not any external service — is what
 * makes redelivery safe, and it is why a `false` return is an ordinary outcome
 * rather than an error.
 *
 * A command that matches nothing at all is different and does throw: it means
 * the caller was handed an id, a type and an instance that do not belong
 * together, which no amount of retrying will fix.
 */
export async function consumeRuntimeCommand(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    commandId: string;
    commandType: WorkflowCommandRuntimeCommandType;
    instanceId: string;
  },
): Promise<boolean> {
  const result = await sql<{ id: string }>`
    update workflow.control_commands
    set
      status = 'runtime_consumed',
      locked_at = null,
      locked_by = null,
      last_error = null,
      updated_at = now()
    where id = cast(${input.commandId} as uuid)
      and tenant_id = cast(${input.tenantId} as uuid)
      and command_type = ${input.commandType}
      and workflow_instance_id = cast(${input.instanceId} as uuid)
      and status in ('pending', 'processing')
    returning id::text
  `.execute(trx);

  if (result.rows.length === 1) {
    return true;
  }

  const existing = await sql<{ status: string | null }>`
    select status
    from workflow.control_commands
    where id = cast(${input.commandId} as uuid)
      and tenant_id = cast(${input.tenantId} as uuid)
      and command_type = ${input.commandType}
      and workflow_instance_id = cast(${input.instanceId} as uuid)
    limit 1
  `.execute(trx);

  if (existing.rows[0]?.status === "runtime_consumed") {
    return false;
  }

  throw new WorkflowCommandRuntimeError(
    "Workflow command runtime could not consume a matching control command.",
    "COMMAND_NOT_FOUND",
  );
}

/**
 * Begin a run: flip the instance to `running`, seed its process variables from
 * the pinned graph, and walk it until it finishes or parks.
 */
export async function applyWorkflowCommandRuntimeStart(
  db: OpenShapeForgeDatabase,
  input: WorkflowCommandRuntimeInput,
): Promise<WorkflowCommandRuntimeResult> {
  const commandId = normalizeUuid(input.commandId, "commandId");
  const tenantId = normalizeUuid(input.tenantId, "tenantId");
  const instanceId = normalizeUuid(input.instanceId, "instanceId");

  const payload = input.payload ?? {};
  const definitionId = normalizeUuid(payload.definitionId, "definitionId");
  const startedBy = normalizeUuid(payload.requestedBy, "requestedBy");
  const versionId = normalizeOptionalUuid(payload.versionId, "versionId");
  const version = normalizeOptionalInteger(payload.version);
  const triggerType = normalizeOptionalText(payload.triggerType) ?? "manual";
  const triggerMeta = normalizeRuntimeJson(payload.triggerMeta ?? {});
  const contextRecord = normalizeJsonRecord(payload.context);
  const initialProcessVariables = normalizeRuntimeJson(payload.initialProcessVariables ?? {});
  const entryNodeId = normalizeOptionalText(payload.entryNodeId);
  const signalDepth = normalizeOptionalInteger(payload.signalDepth) ?? 0;
  const entityType = normalizeOptionalText(payload.entityType);
  const entityId = normalizeOptionalText(payload.entityId);
  const source = normalizeOptionalText(payload.source) ?? "workflow-command-runtime";

  await withDbSession(
    db,
    { tenantId, userId: startedBy, roles: ["workflow-worker"] },
    async (trx) => {
      const instance = await trx
        .selectFrom("workflow.instances")
        .select(["id", "status", "definition_id"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", instanceId)
        .forUpdate()
        .executeTakeFirst();
      if (!instance) {
        throw new WorkflowCommandRuntimeError(
          "Workflow instance was not found for command runtime start.",
          "INSTANCE_NOT_FOUND",
        );
      }
      // A start command that names a different definition than the instance was
      // created with is a corrupted pairing, not a definition change: the
      // instance already pins a version of its own definition.
      if (instance.definition_id !== definitionId) {
        throw new WorkflowCommandRuntimeError(
          "Workflow instance definition does not match the start command.",
          "DEFINITION_MISMATCH",
        );
      }

      const consumed = await consumeRuntimeCommand(trx, {
        tenantId,
        commandId,
        commandType: "workflow.instance.start",
        instanceId,
      });
      if (TERMINAL_INSTANCE_STATUSES.includes(instance.status)) {
        return;
      }
      if (!consumed) {
        return;
      }

      const definitionVersion = await loadDefinitionVersion(trx, {
        tenantId,
        definitionId,
        versionId,
      });
      if (!definitionVersion) {
        throw new WorkflowCommandRuntimeError(
          "Workflow runtime could not load the workflow definition version.",
          "DEFINITION_VERSION_NOT_FOUND",
        );
      }

      const definition = normalizeJsonValue(definitionVersion.definition);
      const triggerPayload = extractTriggerPayload(contextRecord);
      const processVariables = initializeProcessVariables({
        definition,
        triggerPayload,
        overrides: initialProcessVariables,
      });

      await sql`
        update workflow.instances
        set
          status = 'running',
          context = ${jsonbLiteral(contextRecord)},
          process_variables = ${jsonbLiteral(processVariables)},
          trigger_type = ${triggerType},
          trigger_meta = ${jsonbLiteral(triggerMeta)}
        where tenant_id = cast(${tenantId} as uuid)
          and id = cast(${instanceId} as uuid)
      `.execute(trx);

      await appendScopedEntityEventInTransaction(trx, {
        aggregateType: "workflow.instance",
        aggregateId: instanceId,
        eventType: "workflow.instance.runtime_started",
        payload: {
          commandId,
          definitionId,
          versionId,
          version,
          triggerType,
          source,
          signalDepth,
          entityType,
          entityId,
        },
      });

      // The walk's result is deliberately not consumed. Every outcome it can
      // report has already been written to the database inside this same
      // transaction — a failed node and its cascade, or an explicit instance
      // failure for a graph that could not be routed — so the return value is a
      // second copy of what the rows already say. Acting on it here would make
      // this a second writer of the instance's terminal status, which is
      // precisely what `instance-completion.ts` reserves to itself.
      await runProcessInstance(trx, {
        tenantId,
        instanceId,
        workflowDefinitionId: definitionId,
        definition: definition as unknown as ProcessRuntimeDefinition,
        triggerType,
        triggerPayload,
        processVariables,
        entryNodeId,
        startedBy,
      });
    },
  );

  return { ok: true, commandId, instanceId, status: "running" };
}

/**
 * Continue a parked run at one node.
 *
 * Two shapes of resume exist and they are not interchangeable. A process graph
 * is re-entered at the node itself, so the runtime walks on from there and
 * every downstream node still runs. Anything else — a definition category the
 * process runtime does not drive, or a node the pinned graph does not contain,
 * which is what a subprocess-invoking node looks like from the parent's side —
 * is settled by the completion cascade instead. Choosing the second for a graph
 * that could have been walked would silently truncate the run at the resumed
 * node.
 */
export async function applyWorkflowCommandRuntimeResume(
  db: OpenShapeForgeDatabase,
  input: WorkflowCommandRuntimeInput,
): Promise<WorkflowCommandRuntimeResult> {
  const commandId = normalizeUuid(input.commandId, "commandId");
  const tenantId = normalizeUuid(input.tenantId, "tenantId");
  const instanceId = normalizeUuid(input.instanceId, "instanceId");

  const payload = input.payload ?? {};
  const nodeId = normalizeRequiredText(payload.nodeId, "nodeId");
  const waitToken = normalizeOptionalText(payload.waitToken);
  const actionId = normalizeOptionalText(payload.actionId);
  const reason = normalizeOptionalText(payload.reason);
  const completedBy = normalizeOptionalUuid(payload.completedBy, "completedBy") ?? SYSTEM_ACTOR_ID;
  // `result` is what the cascade calls it and `input` is what an operator-facing
  // resume calls it; both mean the values the parked node was waiting for.
  const result = normalizeJsonRecord(payload.result ?? payload.input ?? {});

  await withDbSession(
    db,
    { tenantId, userId: completedBy, roles: ["workflow-worker"] },
    async (trx) => {
      const instance = await trx
        .selectFrom("workflow.instances")
        .select(["id", "status", "definition_id", "version_id", "context", "process_variables"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", instanceId)
        .forUpdate()
        .executeTakeFirst();
      if (!instance) {
        throw new WorkflowCommandRuntimeError(
          "Workflow instance was not found for command runtime resume.",
          "INSTANCE_NOT_FOUND",
        );
      }

      const consumed = await consumeRuntimeCommand(trx, {
        tenantId,
        commandId,
        commandType: "workflow.instance.resume",
        instanceId,
      });
      if (TERMINAL_INSTANCE_STATUSES.includes(instance.status)) {
        return;
      }
      if (!consumed) {
        return;
      }

      await appendScopedEntityEventInTransaction(trx, {
        aggregateType: "workflow.instance",
        aggregateId: instanceId,
        eventType: "workflow.instance.runtime_resume_requested",
        payload: {
          commandId,
          nodeId,
          waitToken,
          actionId,
          reason,
          completedBy,
          result: result as Json,
        },
      });

      const definitionMeta = await trx
        .selectFrom("workflow.definitions")
        .select(["category"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", instance.definition_id)
        .executeTakeFirst();
      const definitionVersion = await loadDefinitionVersion(trx, {
        tenantId,
        definitionId: instance.definition_id,
        versionId: instance.version_id ?? null,
      });
      if (!definitionVersion) {
        throw new WorkflowCommandRuntimeError(
          "Workflow runtime could not load the workflow definition version.",
          "DEFINITION_VERSION_NOT_FOUND",
        );
      }
      const definition = normalizeJsonValue(definitionVersion.definition);

      const shouldRunAsProcess =
        definitionMeta?.category === "process" || definitionMeta?.category === "orchestrator";

      if (shouldRunAsProcess && definitionHasNode(definition, nodeId)) {
        await runProcessInstance(trx, {
          tenantId,
          instanceId,
          workflowDefinitionId: instance.definition_id,
          definition: definition as unknown as ProcessRuntimeDefinition,
          triggerType: "manual",
          triggerPayload: extractTriggerPayload(normalizeJsonRecord(instance.context)),
          processVariables: normalizeJsonRecord(instance.process_variables),
          entryNodeId: null,
          resumeFromNodeId: nodeId,
          startedBy: completedBy,
        });
        return;
      }

      await applyResumeAndCascadeInTransaction(trx, {
        tenantId,
        instanceId,
        nodeId,
        result,
        completedBy,
      });
    },
  );

  return { ok: true, commandId, instanceId, status: "resume_requested" };
}

/**
 * End a run early.
 *
 * The consume result is deliberately not branched on: cancelling is already
 * idempotent one level down — an instance that is terminal stays terminal and
 * reports `already_terminal` — so a redelivered cancel costs an extra event
 * append and nothing else. Refusing to proceed on a lost claim would be worse,
 * because the one case where a cancel must still land is a command that was
 * consumed by a worker that then died before the transaction committed.
 */
export async function applyWorkflowCommandRuntimeCancel(
  db: OpenShapeForgeDatabase,
  input: WorkflowCommandRuntimeInput,
): Promise<WorkflowCommandRuntimeResult> {
  const commandId = normalizeUuid(input.commandId, "commandId");
  const tenantId = normalizeUuid(input.tenantId, "tenantId");
  const instanceId = normalizeUuid(input.instanceId, "instanceId");

  const payload = input.payload ?? {};
  const cancelledBy = normalizeUuid(payload.cancelledBy, "cancelledBy");
  const reason = normalizeOptionalText(payload.reason) ?? "cancelled";

  await withDbSession(
    db,
    { tenantId, userId: cancelledBy, roles: ["workflow-worker"] },
    async (trx) => {
      await consumeRuntimeCommand(trx, {
        tenantId,
        commandId,
        commandType: "workflow.instance.cancel",
        instanceId,
      });

      await cancelWorkflowInstanceInTransaction(trx, {
        tenantId,
        instanceId,
        cancelledBy,
        reason,
      });

      await appendScopedEntityEventInTransaction(trx, {
        aggregateType: "workflow.instance",
        aggregateId: instanceId,
        eventType: "workflow.instance.runtime_cancel_requested",
        payload: { commandId, instanceId, reason },
      });
    },
  );

  return { ok: true, commandId, instanceId, status: "cancelled" };
}
