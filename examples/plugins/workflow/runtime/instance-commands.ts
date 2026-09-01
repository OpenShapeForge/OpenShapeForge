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
import { WORKFLOW_WRITER_ROLES } from "../authorization.js";

export type StartWorkflowInstanceCommandInput = {
  definitionId: string;
  context?: unknown;
  initialProcessVariables?: unknown;
  entityType?: string | null;
  entityId?: string | null;
  triggerType?: string | null;
  triggerMeta?: unknown;
  signalDepth?: number | null;
  /**
   * Supplied by a caller that can be delivered more than once. Two calls
   * carrying the same key start one run; the second adopts the first. See
   * `enqueueWorkflowInstanceStartInTransaction`.
   */
  idempotencyKey?: string | null;
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

const workflowWriterRoles = new Set<string>(WORKFLOW_WRITER_ROLES);

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
    commandId?: string;
    idempotencyKey?: string | null;
    payload: Record<string, unknown>;
  },
) {
  const commandId = input.commandId ?? randomUUID();
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
  idempotencyKey?: string | null | undefined;
};

export type EnqueueWorkflowInstanceStartResult = {
  instanceId: string;
  commandId: string;
  versionId: string;
  version: number;
  definitionName: string;
  /**
   * False when an equal `idempotencyKey` had already enqueued this run. Nothing
   * was written: every field above describes the earlier run, which is the one
   * that will execute.
   */
  enqueued: boolean;
};

/** The run an already-claimed key resolves to, as that command recorded it. */
type AdoptedWorkflowInstanceStart = {
  commandId: string;
  instanceId: string;
  versionId: string;
  version: number;
  definitionName: string;
};

/**
 * Claim a start key, before any instance row exists. Returns null when this
 * call won it and may now write its instance, or the run to adopt when another
 * delivery already holds it.
 *
 * `workflow_instance_id` is left null and set once the instance exists, because
 * the foreign key admits no other order. Nothing can observe the gap: the row
 * is invisible until the caller's transaction commits, and a transaction that
 * dies in between takes the command with it.
 */
async function claimStartCommandKey(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    commandId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  },
): Promise<AdoptedWorkflowInstanceStart | null> {
  const claimed = await sql<{ id: string }>`
    insert into workflow.control_commands (
      id,
      tenant_id,
      command_type,
      idempotency_key,
      payload,
      status,
      next_attempt_at
    ) values (
      cast(${input.commandId} as uuid),
      cast(${input.tenantId} as uuid),
      'workflow.instance.start',
      ${input.idempotencyKey},
      ${jsonbLiteral(input.payload)},
      'pending',
      now()
    )
    -- Matches workflow_control_commands_idempotency_uidx exactly; a conflict
    -- target no index covers is a runtime error on first use.
    on conflict (
      tenant_id,
      idempotency_key
    )
    do nothing
    returning id::text
  `.execute(trx);

  if (claimed.rows.length === 1) {
    return null;
  }

  // Read in a statement of its own: under READ COMMITTED that snapshot is taken
  // after the transaction we lost to committed, which a read spliced into the
  // INSERT above would not be — it would still see the state from before.
  //
  // The pinned facts come from the surviving command's payload rather than from
  // its instance, because this function writes them there and nothing since can
  // clear them; the instance's own snapshot columns are nulled when a version
  // is purged.
  const existing = await sql<{
    command_id: string;
    instance_id: string | null;
    version_id: string | null;
    version: number | null;
    definition_name: string | null;
  }>`
    select
      id::text as command_id,
      workflow_instance_id::text as instance_id,
      payload ->> 'versionId' as version_id,
      (payload ->> 'version')::int as version,
      payload ->> 'definitionName' as definition_name
    from workflow.control_commands
    where tenant_id = cast(${input.tenantId} as uuid)
      and idempotency_key = ${input.idempotencyKey}
    limit 1
  `.execute(trx);

  const row = existing.rows[0];
  if (
    !row ||
    row.instance_id === null ||
    row.version_id === null ||
    row.version === null ||
    row.definition_name === null
  ) {
    throw new WorkflowInstanceCommandError(
      "Idempotency key is already held by a command that does not describe a workflow start.",
      "CONFLICT",
    );
  }

  return {
    commandId: row.command_id,
    instanceId: row.instance_id,
    versionId: row.version_id,
    version: row.version,
    definitionName: row.definition_name,
  };
}

/**
 * Insert a workflow instance row plus its `workflow.instance.start` control
 * command, all within an existing transaction. Used by:
 *   - the public `enqueueWorkflowInstanceStart` mutation (with session checks)
 *   - the case workflow runtime when it needs to start child subprocess
 *     workflows from inside the same transaction that seeded the ERP rows.
 *
 * ## Why a keyed start writes its command before its instance
 *
 * The unique index on (tenant_id, idempotency_key) is the only thing that can
 * decide which of two deliveries wins, so the instance cannot be written first:
 * the loser would find out it lost only after creating a row it has no way to
 * withdraw, leaving an instance in `starting` that no command points at and no
 * worker will ever run. A duplicate run is a visible mistake; that row is an
 * invisible one, and it is the more expensive of the two.
 *
 * So the key is claimed first and the instance is created only by the call that
 * won it. A call that lost adopts the run already enqueued rather than opening
 * one of its own. Without a key there is nothing to win and nothing to adopt,
 * and that path keeps the plain order.
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
  const callerKey = normalizeOptionalText(input.idempotencyKey);
  // Scoped like the `resume:` and `cancel:` keys, and per definition because a
  // caller's delivery id says nothing about which workflow it was delivered to:
  // one delivery fanned out to two definitions is two runs, and the index is
  // unique per tenant across every command type.
  const idempotencyKey = callerKey ? `start:${definitionId}:${callerKey}` : null;

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
  const commandId = randomUUID();
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

  if (idempotencyKey) {
    const adopted = await claimStartCommandKey(trx, {
      tenantId,
      commandId,
      idempotencyKey,
      payload: commandPayload,
    });
    if (adopted) {
      return { ...adopted, enqueued: false };
    }
  }

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

  if (idempotencyKey) {
    // The link the command insert could not carry, now that the instance it
    // names exists.
    await sql`
      update workflow.control_commands
      set workflow_instance_id = cast(${nextInstanceId} as uuid)
      where id = cast(${commandId} as uuid)
        and tenant_id = cast(${tenantId} as uuid)
    `.execute(trx);
  } else {
    await insertControlCommand(trx, {
      tenantId,
      commandId,
      commandType: "workflow.instance.start",
      workflowInstanceId: nextInstanceId,
      payload: commandPayload,
    });
  }

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
    enqueued: true,
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
        idempotencyKey: input.idempotencyKey,
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
