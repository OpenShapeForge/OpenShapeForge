// SPDX-License-Identifier: BUSL-1.1
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import {
  withDbSession,
  type DbSessionContext,
  type DbSessionInput,
} from "../../../../apps/api/src/db/session.js";
import type { DB, Json } from "../../../../apps/api/src/generated/db/types.js";
import { jsonbLiteral } from "../../../../apps/api/src/db/sql-helpers.js";
import { appendScopedEntityEventInTransaction } from "../../../../apps/api/src/platform/entity-events.js";
import {
} from "./definitions.js";
import { canViewDefinition, normalizeDefinitionAuthorization } from "./definition-authorization.js";
import { normalizeJsonValue } from "../../../../apps/api/src/platform/entity-events.js";
import { getWorkflowInstance, type WorkflowInstanceDetailRecord } from "./instances.js";

export type StartWorkflowInstanceCommandInput = {
  definitionId: string;
  context?: unknown;
  initialProcessVariables?: unknown;
  entityType?: string | null;
  entityId?: string | null;
  triggerType?: string | null;
  triggerMeta?: unknown;
  signalDepth?: number | null;
};

export type ResumeWorkflowInstanceCommandInput = {
  instanceId: string;
  nodeId: string;
  input: unknown;
  actionId?: string | null;
  reason?: string | null;
  waitToken?: string | null;
};

export type CancelWorkflowInstanceInTransactionInput = {
  instanceId: string;
  cancelledBy: string;
  reason?: string | null;
  idempotencyKey?: string | null;
};

type PublishedDefinitionRow = {
  id: string;
  name: string;
  category: string;
  authorization: Json;
  version_id: string;
  version: number;
};

type InstanceForResumeRow = {
  id: string;
  status: string;
  definition_authorization: Json;
};

const workflowWriterRoles = new Set([
  "directie",
  "workflow-admin",
  "workflow-operator",
]);

export class WorkflowInstanceCommandError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

function normalizeUuid(value: string | null | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new WorkflowInstanceCommandError(`${label} is required.`, "BAD_USER_INPUT");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized,
    )
  ) {
    throw new WorkflowInstanceCommandError(`${label} must be a UUID.`, "BAD_USER_INPUT");
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeRequiredText(value: string | null | undefined, label: string) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new WorkflowInstanceCommandError(`${label} is required.`, "BAD_USER_INPUT");
  }
  return normalized;
}

function normalizeSignalDepth(value: number | null | undefined) {
  if (value === undefined || value === null) {
    return 0;
  }
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new WorkflowInstanceCommandError(
      "signalDepth must be an integer between 0 and 20.",
      "BAD_USER_INPUT",
    );
  }
  return value;
}

function normalizeCommandJson(value: unknown): Json {
  return normalizeJsonValue(value as Json);
}

function normalizeCommandJsonRecord(value: unknown): Record<string, unknown> {
  const normalized = normalizeCommandJson(value ?? {});
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : {};
}


function assertWorkflowWriter(session: Pick<DbSessionContext, "roles">) {
  if (!session.roles.some((role) => workflowWriterRoles.has(role))) {
    throw new WorkflowInstanceCommandError(
      "Not authorized to mutate workflow instances.",
      "FORBIDDEN",
    );
  }
}

function assertVisible(authorization: Json, session: DbSessionContext) {
  if (!canViewDefinition(normalizeDefinitionAuthorization(authorization), session)) {
    throw new WorkflowInstanceCommandError(
      "Workflow definition is not available for this user.",
      "FORBIDDEN",
    );
  }
}

async function latestPublishedDefinitionForUpdate(
  trx: Transaction<DB>,
  tenantId: string,
  definitionId: string,
): Promise<PublishedDefinitionRow | null> {
  return trx
    .selectFrom("workflow.definitions as d")
    .innerJoin("workflow.definition_versions as v", (join) =>
      join
        .onRef("v.definition_id", "=", "d.id")
        .onRef("v.tenant_id", "=", "d.tenant_id"),
    )
    .select([
      "d.id",
      "d.name",
      "d.category",
      "d.authorization",
      "v.id as version_id",
      "v.version",
    ])
    .where("d.tenant_id", "=", tenantId)
    .where("d.id", "=", definitionId)
    .where("d.is_active", "=", true)
    .where("v.published_at", "is not", null)
    .orderBy("v.version", "desc")
    .limit(1)
    .forUpdate()
    .executeTakeFirst() as Promise<PublishedDefinitionRow | null>;
}

async function loadInstanceForResume(
  trx: Transaction<DB>,
  tenantId: string,
  instanceId: string,
): Promise<InstanceForResumeRow | null> {
  return trx
    .selectFrom("workflow.instances as i")
    .innerJoin("workflow.definitions as d", (join) =>
      join
        .onRef("d.id", "=", "i.definition_id")
        .onRef("d.tenant_id", "=", "i.tenant_id"),
    )
    .select([
      "i.id",
      "i.status",
      "d.authorization as definition_authorization",
    ])
    .where("i.tenant_id", "=", tenantId)
    .where("i.id", "=", instanceId)
    .forUpdate()
    .executeTakeFirst() as Promise<InstanceForResumeRow | null>;
}

async function insertControlCommand(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    commandType: string;
    workflowInstanceId: string | null;
    idempotencyKey?: string | null;
    payload: Record<string, unknown>;
  },
) {
  const commandId = randomUUID();
  const idempotencyKey = normalizeOptionalText(input.idempotencyKey);
  if (idempotencyKey) {
    const result = await sql<{ id: string; inserted: boolean }>`
      with inserted as (
        insert into workflow.control_commands (
          id,
          tenant_id,
          command_type,
          workflow_instance_id,
          idempotency_key,
          payload,
          status,
          next_attempt_at
        ) values (
          cast(${commandId} as uuid),
          cast(${input.tenantId} as uuid),
          ${input.commandType},
          ${input.workflowInstanceId ? sql`cast(${input.workflowInstanceId} as uuid)` : sql`null`},
          ${idempotencyKey},
          ${jsonbLiteral(input.payload)},
          'pending',
          now()
        )
        -- Matches workflow_control_commands_idempotency_uidx exactly. A conflict
        -- target that names columns no index covers is not a slow query, it is a
        -- runtime error on first use. The keys already carry their intent in the
        -- prefix (resume:…, cancel:…), so scoping per tenant is enough; and a
        -- null key never conflicts, which is what an unkeyed command wants.
        on conflict (
          tenant_id,
          idempotency_key
        )
        do nothing
        returning id::text, true as inserted
      )
      select id, inserted from inserted
      union all
      select id::text, false as inserted
      from workflow.control_commands
      where tenant_id = cast(${input.tenantId} as uuid)
        and command_type = ${input.commandType}
        and workflow_instance_id = cast(${input.workflowInstanceId} as uuid)
        and idempotency_key = ${idempotencyKey}
      limit 1
    `.execute(trx);

    const row = result.rows[0];
    if (!row) {
      throw new Error("Workflow control command could not be inserted or loaded.");
    }
    return {
      commandId: row.id,
      inserted: row.inserted,
    };
  }

  await sql`
    insert into workflow.control_commands (
      id,
      tenant_id,
      command_type,
      workflow_instance_id,
      payload,
      status,
      next_attempt_at
    ) values (
      cast(${commandId} as uuid),
      cast(${input.tenantId} as uuid),
      ${input.commandType},
      ${input.workflowInstanceId ? sql`cast(${input.workflowInstanceId} as uuid)` : sql`null`},
      ${jsonbLiteral(input.payload)},
      'pending',
      now()
    )
  `.execute(trx);
  return {
    commandId,
    inserted: true,
  };
}

export type EnqueueWorkflowInstanceStartInTransactionInput = {
  definitionId: string;
  startedBy: string;
  context?: unknown;
  initialProcessVariables?: unknown;
  triggerType?: string | null | undefined;
  triggerMeta?: unknown;
  signalDepth?: number | null | undefined;
  entityType?: string | null | undefined;
  entityId?: string | null | undefined;
  parentInstanceId?: string | null | undefined;
  parentNodeId?: string | null | undefined;
};

export type EnqueueWorkflowInstanceStartResult = {
  instanceId: string;
  commandId: string;
  versionId: string;
  version: number;
  definitionName: string;
};

/**
 * Insert a workflow instance row plus its `workflow.instance.start` control
 * command, all within an existing transaction. Used by:
 *   - the public `enqueueWorkflowInstanceStart` mutation (with session checks)
 *   - the case workflow runtime when it needs to start child subprocess
 *     workflows from inside the same transaction that seeded the ERP rows.
 */
export async function enqueueWorkflowInstanceStartInTransaction(
  trx: Transaction<DB>,
  tenantId: string,
  input: EnqueueWorkflowInstanceStartInTransactionInput,
): Promise<EnqueueWorkflowInstanceStartResult> {
  const definitionId = normalizeUuid(input.definitionId, "definitionId");
  const startedBy = normalizeUuid(input.startedBy, "startedBy");
  const rawContext = normalizeCommandJson(input.context ?? {});
  const initialProcessVariables = normalizeCommandJson(input.initialProcessVariables ?? {});
  const triggerMeta = normalizeCommandJson(input.triggerMeta ?? {});
  const context = normalizeCommandJsonRecord(rawContext);
  const triggerType = normalizeOptionalText(input.triggerType) ?? "manual";
  const entityType = normalizeOptionalText(input.entityType);
  const entityId = normalizeOptionalText(input.entityId);
  const signalDepth = normalizeSignalDepth(input.signalDepth);
  const parentInstanceId = input.parentInstanceId
    ? normalizeUuid(input.parentInstanceId, "parentInstanceId")
    : null;
  const parentNodeId = normalizeOptionalText(input.parentNodeId);

  const definition = await latestPublishedDefinitionForUpdate(
    trx,
    tenantId,
    definitionId,
  );
  if (!definition) {
    throw new WorkflowInstanceCommandError(
      "Workflow definition was not found or has no published version.",
      "NOT_FOUND",
    );
  }
  const nextInstanceId = randomUUID();
  const commandPayload = {
    instanceId: nextInstanceId,
    definitionId,
    versionId: definition.version_id,
    version: definition.version,
    definitionName: definition.name,
    context,
    initialProcessVariables,
    triggerType,
    triggerMeta,
    signalDepth,
    entityType,
    entityId,
    parentInstanceId,
    parentNodeId,
    requestedBy: startedBy,
  };

  await trx
    .insertInto("workflow.instances")
    .values({
      id: nextInstanceId,
      tenant_id: tenantId,
      definition_id: definitionId,
      version_id: definition.version_id,
      status: "starting",
      context: context as Json,
      started_by: startedBy,
      entity_type: entityType,
      entity_id: entityId,
      parent_instance_id: parentInstanceId,
      parent_node_id: parentNodeId,
      // Snapshot of what was published when the run started, written with the
      // row rather than by a follow-up update: an instance that exists without
      // them is an instance a list read cannot describe.
      definition_version: definition.version,
      definition_name: definition.name,
      trigger_type: triggerType,
      trigger_meta: triggerMeta as Json,
    })
    .execute();

  const { commandId } = await insertControlCommand(trx, {
    tenantId,
    commandType: "workflow.instance.start",
    workflowInstanceId: nextInstanceId,
    payload: commandPayload,
  });

  await appendScopedEntityEventInTransaction(trx, {
    aggregateType: "workflow.instance",
    aggregateId: nextInstanceId,
    eventType: "workflow.instance.start_requested",
    payload: {
      instanceId: nextInstanceId,
      definitionId,
      versionId: definition.version_id,
      commandId,
      triggerType,
      parentInstanceId,
      parentNodeId,
    },
  });

  return {
    instanceId: nextInstanceId,
    commandId,
    versionId: definition.version_id,
    version: definition.version,
    definitionName: definition.name,
  };
}

export async function enqueueWorkflowInstanceStart(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: StartWorkflowInstanceCommandInput,
): Promise<WorkflowInstanceDetailRecord> {
  const instanceId = await withDbSession(db, session, async (trx, scopedSession) => {
    assertWorkflowWriter(scopedSession);

    const definition = await latestPublishedDefinitionForUpdate(
      trx,
      scopedSession.tenantId,
      normalizeUuid(input.definitionId, "definitionId"),
    );
    if (definition) {
      assertVisible(definition.authorization, scopedSession);
    }

    const result = await enqueueWorkflowInstanceStartInTransaction(
      trx,
      scopedSession.tenantId,
      {
        definitionId: input.definitionId,
        startedBy: scopedSession.userId,
        context: input.context,
        triggerType: input.triggerType,
        triggerMeta: input.triggerMeta,
        signalDepth: input.signalDepth,
        entityType: input.entityType,
        entityId: input.entityId,
      },
    );

    return result.instanceId;
  });

  const instance = await getWorkflowInstance(db, session, instanceId);
  if (!instance) {
    throw new Error("Started workflow instance could not be loaded.");
  }
  return instance;
}

/**
 * In-transaction variant of `enqueueWorkflowInstanceResume`. Callers
 * provide an open Kysely transaction + already-scoped session. Used by
 * `workflow.llm_call_waits` dispatch so the terminal-state UPDATE on the
 * wait row commits atomically with the resume command insert — without
 * that atomicity a worker crash between the two writes (or a transient
 * DB error on the second) leaves the wait row terminal while no resume
 * command was enqueued, silently stalling the workflow.
 *
 * The function intentionally mirrors `enqueueWorkflowInstanceResume`'s
 * logic; the only difference is that the trx is supplied by the caller
 * AND the human-operator `workflowWriterRoles` gate is the public
 * wrapper's job (symmetric with `enqueueWorkflowInstanceStartInTransaction`
 * vs the public `enqueueWorkflowInstanceStart`). The in-trx variant is
 * a low-level primitive that trusts its caller; this is what lets the
 * system worker (whose session carries `["system", "workflow-worker"]`
 * but no human-operator role) participate in the atomic terminal-state
 * + resume-enqueue write.
 */
export async function enqueueWorkflowInstanceResumeInTransaction(
  trx: Transaction<DB>,
  scopedSession: DbSessionContext,
  input: ResumeWorkflowInstanceCommandInput,
) {
  const instanceId = normalizeUuid(input.instanceId, "instanceId");
  const nodeId = normalizeRequiredText(input.nodeId, "nodeId");
  const actionId = normalizeOptionalText(input.actionId);
  const reason = normalizeOptionalText(input.reason);
  const waitToken = normalizeOptionalText(input.waitToken);
  const resumeInput = normalizeCommandJson(input.input ?? {});

  const instance = await loadInstanceForResume(
    trx,
    scopedSession.tenantId,
    instanceId,
  );
  if (!instance) {
    return {
      ok: true as const,
      alreadyResolved: true as const,
      instanceId,
      waitToken,
    };
  }
  assertVisible(instance.definition_authorization, scopedSession);
  if (["completed", "failed", "cancelled"].includes(instance.status)) {
    return {
      ok: true as const,
      alreadyResolved: true as const,
      instanceId,
      waitToken,
    };
  }

  const commandPayload = {
    instanceId,
    nodeId,
    input: resumeInput,
    actionId,
    reason,
    waitToken,
    completedBy: scopedSession.userId,
  };
  const { commandId, inserted } = await insertControlCommand(trx, {
    tenantId: scopedSession.tenantId,
    commandType: "workflow.instance.resume",
    workflowInstanceId: instanceId,
    idempotencyKey: `resume:${instanceId}:${waitToken ?? nodeId}`,
    payload: commandPayload,
  });

  if (inserted) {
    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: "workflow.instance",
      aggregateId: instanceId,
      eventType: "workflow.instance.resume_requested",
      payload: {
        instanceId,
        nodeId,
        actionId,
        waitToken,
        commandId,
      },
    });
  }

  return {
    ok: true as const,
    alreadyResolved: false as const,
    instanceId,
    waitToken,
    status: "running" as const,
    commandId,
  };
}

export async function enqueueWorkflowInstanceResume(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: ResumeWorkflowInstanceCommandInput,
) {
  return withDbSession(db, session, async (trx, scopedSession) => {
    // Human-operator role gate lives on the public wrapper. The in-trx
    // primitive is trusted to be called only by system code that
    // already established its own authorization (the LLM-call-wait
    // dispatch worker is the canonical example).
    assertWorkflowWriter(scopedSession);
    return enqueueWorkflowInstanceResumeInTransaction(trx, scopedSession, input);
  });
}

export async function enqueueWorkflowInstanceCancelInTransaction(
  trx: Transaction<DB>,
  tenantId: string,
  input: CancelWorkflowInstanceInTransactionInput,
) {
  const instanceId = normalizeUuid(input.instanceId, "instanceId");
  const cancelledBy = normalizeUuid(input.cancelledBy, "cancelledBy");
  const reason = normalizeOptionalText(input.reason) ?? "cancelled";
  const instance = await trx
    .selectFrom("workflow.instances")
    .select(["id", "status"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", instanceId)
    .forUpdate()
    .executeTakeFirst();

  if (!instance || ["completed", "failed", "cancelled"].includes(instance.status)) {
    return {
      ok: true,
      alreadyResolved: true,
      instanceId,
      commandId: null,
    };
  }

  const { commandId, inserted } = await insertControlCommand(trx, {
    tenantId,
    commandType: "workflow.instance.cancel",
    workflowInstanceId: instanceId,
    idempotencyKey: input.idempotencyKey ?? `cancel:${instanceId}:${reason}`,
    payload: {
      instanceId,
      reason,
      cancelledBy,
    },
  });

  if (inserted) {
    await appendScopedEntityEventInTransaction(trx, {
      aggregateType: "workflow.instance",
      aggregateId: instanceId,
      eventType: "workflow.instance.cancel_requested",
      payload: {
        instanceId,
        reason,
        commandId,
      },
    });
  }

  return {
    ok: true,
    alreadyResolved: false,
    instanceId,
    commandId,
  };
}
