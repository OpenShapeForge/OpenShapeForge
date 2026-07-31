// SPDX-License-Identifier: BUSL-1.1
import { Buffer } from "node:buffer";
import type { Selectable, Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import {
  withDbSession,
  type DbSessionInput,
} from "../../../../apps/api/src/db/session.js";
import type {
  DB,
  Json,
  WorkflowInstancesTable,
  WorkflowNodeStatesTable,
} from "../../../../apps/api/src/generated/db/types.js";
import {
} from "./definitions.js";
import { canViewDefinition, normalizeDefinitionAuthorization } from "./definition-authorization.js";
import { normalizeJsonValue } from "../../../../apps/api/src/platform/entity-events.js";

export type WorkflowInstancesListInput = {
  status?: string | null;
  definitionId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  limit?: number | null;
  cursor?: string | null;
};

export type WorkflowInstanceListRecord = {
  id: string;
  definitionId: string;
  definitionName: string;
  versionId: string | null;
  status: string;
  context: Json;
  processVariables: Json;
  startedBy: string | null;
  startedAt: string;
  completedAt: string | null;
  error: Json;
  entityType: string | null;
  entityId: string | null;
  parentInstanceId: string | null;
  parentNodeId: string | null;
};

export type WorkflowInstanceNodeStateRecord = {
  id: string;
  instanceId: string;
  nodeId: string;
  nodeType: string;
  status: string;
  input: Json;
  resolvedParameters: Json;
  sharedOutput: Json;
  privateOutput: Json;
  error: Json;
  startedAt: string | null;
  completedAt: string | null;
};

export type WorkflowChildInstanceRecord = {
  id: string;
  definitionId: string;
  definitionName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  parentNodeId: string | null;
};

export type WorkflowInstanceDetailRecord = WorkflowInstanceListRecord & {
  nodeStates: WorkflowInstanceNodeStateRecord[];
  childInstances: WorkflowChildInstanceRecord[];
};

export type WorkflowInstanceConnection = {
  instances: WorkflowInstanceListRecord[];
  nextCursor: string | null;
};

type WorkflowInstanceRow = Pick<
  Selectable<WorkflowInstancesTable>,
  | "id"
  | "definition_id"
  | "version_id"
  | "status"
  | "context"
  | "process_variables"
  | "started_by"
  | "started_at"
  | "completed_at"
  | "error"
  | "entity_type"
  | "entity_id"
  | "parent_instance_id"
  | "parent_node_id"
> & {
  definition_name: string;
  definition_authorization: Json;
};

type WorkflowNodeStateRow = Selectable<WorkflowNodeStatesTable>;

type InstanceCursor = {
  startedAt: string;
  id: string;
};

function timestampToIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableTimestampToIso(value: Date | string | null) {
  return value ? timestampToIso(value) : null;
}

function normalizeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function normalizeTextFilter(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeLimit(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) {
    return 50;
  }
  return Math.max(1, Math.min(Math.trunc(value as number), 200));
}

export function encodeWorkflowInstanceCursor(row: WorkflowInstanceListRecord) {
  return Buffer.from(
    JSON.stringify({
      startedAt: row.startedAt,
      id: row.id,
    } satisfies InstanceCursor),
  ).toString("base64url");
}

function decodeWorkflowInstanceCursor(cursor?: string | null): InstanceCursor | null {
  if (!cursor) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      parsed &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.id === "string" &&
      normalizeUuid(parsed.id)
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export function mapWorkflowInstanceRecord(
  row: WorkflowInstanceRow,
): WorkflowInstanceListRecord {
  return {
    id: row.id,
    definitionId: row.definition_id,
    definitionName: row.definition_name,
    versionId: row.version_id,
    status: row.status,
    context: normalizeJsonValue(row.context),
    processVariables: normalizeJsonValue(row.process_variables),
    startedBy: row.started_by,
    startedAt: timestampToIso(row.started_at),
    completedAt: nullableTimestampToIso(row.completed_at),
    error: row.error ? normalizeJsonValue(row.error) : null,
    entityType: row.entity_type,
    entityId: row.entity_id,
    parentInstanceId: row.parent_instance_id,
    parentNodeId: row.parent_node_id,
  };
}

export function mapWorkflowNodeState(
  row: WorkflowNodeStateRow,
): WorkflowInstanceNodeStateRecord {
  return {
    id: row.id,
    instanceId: row.instance_id,
    nodeId: row.node_id,
    nodeType: row.node_type,
    status: row.status,
    input: row.input ? normalizeJsonValue(row.input) : null,
    resolvedParameters: row.resolved_parameters
      ? normalizeJsonValue(row.resolved_parameters)
      : null,
    sharedOutput: row.shared_output ? normalizeJsonValue(row.shared_output) : null,
    privateOutput: row.private_output ? normalizeJsonValue(row.private_output) : null,
    error: row.error ? normalizeJsonValue(row.error) : null,
    startedAt: nullableTimestampToIso(row.started_at),
    completedAt: nullableTimestampToIso(row.completed_at),
  };
}

function baseInstanceQuery(trx: Transaction<DB>) {
  return trx
    .selectFrom("workflow.instances as i")
    .innerJoin("workflow.definitions as d", (join) =>
      join
        .onRef("d.id", "=", "i.definition_id")
        .onRef("d.tenant_id", "=", "i.tenant_id"),
    )
    .select([
      "i.id",
      "i.definition_id",
      "d.name as definition_name",
      "d.authorization as definition_authorization",
      "i.version_id",
      "i.status",
      "i.context",
      "i.process_variables",
      "i.started_by",
      "i.started_at",
      "i.completed_at",
      "i.error",
      "i.entity_type",
      "i.entity_id",
      "i.parent_instance_id",
      "i.parent_node_id",
    ]);
}

export async function listWorkflowInstances(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: WorkflowInstancesListInput = {},
): Promise<WorkflowInstanceConnection> {
  const limit = normalizeLimit(input.limit);
  const cursor = decodeWorkflowInstanceCursor(input.cursor);
  const status = normalizeTextFilter(input.status);
  const definitionId = normalizeTextFilter(input.definitionId);
  const entityType = normalizeTextFilter(input.entityType);
  const entityId = normalizeTextFilter(input.entityId);

  if (definitionId && !normalizeUuid(definitionId)) {
    return {
      instances: [],
      nextCursor: null,
    };
  }

  return withDbSession(db, session, async (trx, scopedSession) => {
    let pageCursor = cursor;
    const visibleRows: WorkflowInstanceRow[] = [];
    let hasMore = false;

    while (visibleRows.length <= limit) {
      let query = baseInstanceQuery(trx)
        .where("i.tenant_id", "=", scopedSession.tenantId)
        .orderBy("i.started_at", "desc")
        .orderBy("i.id", "desc")
        .limit(limit + 1);

      if (status) {
        query = query.where("i.status", "=", status);
      }
      if (definitionId) {
        query = query.where("i.definition_id", "=", definitionId);
      }
      if (entityType) {
        query = query.where("i.entity_type", "=", entityType);
      }
      if (entityId) {
        query = query.where("i.entity_id", "=", entityId);
      }
      if (pageCursor) {
        const activeCursor = pageCursor;
        query = query.where((eb) =>
          eb.or([
            eb("i.started_at", "<", activeCursor.startedAt),
            eb.and([
              eb("i.started_at", "=", activeCursor.startedAt),
              eb("i.id", "<", activeCursor.id),
            ]),
          ]),
        );
      }

      const rows = await query.execute();
      if (rows.length === 0) {
        hasMore = false;
        break;
      }

      for (const row of rows) {
        if (canViewDefinition(normalizeDefinitionAuthorization(row.definition_authorization), scopedSession)) {
          visibleRows.push(row);
        }
      }

      hasMore = rows.length > limit;
      const lastRow = rows[rows.length - 1]!;
      pageCursor = {
        startedAt: timestampToIso(lastRow.started_at),
        id: lastRow.id,
      };

      if (!hasMore) {
        break;
      }
    }

    const instances = visibleRows.slice(0, limit).map(mapWorkflowInstanceRecord);
    const nextCursor =
      (hasMore || visibleRows.length > limit) && instances.length > 0
        ? encodeWorkflowInstanceCursor(instances[instances.length - 1]!)
        : null;

    return {
      instances,
      nextCursor,
    };
  });
}

export async function getWorkflowInstance(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  instanceId: string,
): Promise<WorkflowInstanceDetailRecord | null> {
  if (!normalizeUuid(instanceId)) {
    return null;
  }

  return withDbSession(db, session, async (trx, scopedSession) => {
    const instance = await baseInstanceQuery(trx)
      .where("i.tenant_id", "=", scopedSession.tenantId)
      .where("i.id", "=", instanceId)
      .executeTakeFirst();

    if (
      !instance ||
      !canViewDefinition(normalizeDefinitionAuthorization(instance.definition_authorization), scopedSession)
    ) {
      return null;
    }

    const nodeStates = await trx
      .selectFrom("workflow.node_states")
      .selectAll()
      .where("tenant_id", "=", scopedSession.tenantId)
      .where("instance_id", "=", instanceId)
      .orderBy("started_at", "asc")
      .orderBy("id", "asc")
      .execute();

    const childInstances = await baseInstanceQuery(trx)
      .where("i.tenant_id", "=", scopedSession.tenantId)
      .where("i.parent_instance_id", "=", instanceId)
      .orderBy("i.started_at", "desc")
      .orderBy("i.id", "desc")
      .execute();

    const mappedChildInstances = childInstances
      .filter((child) =>
        canViewDefinition(normalizeDefinitionAuthorization(child.definition_authorization), scopedSession),
      )
      .map((child) => {
        const mapped = mapWorkflowInstanceRecord(child);
        return {
          id: mapped.id,
          definitionId: mapped.definitionId,
          definitionName: mapped.definitionName,
          status: mapped.status,
          startedAt: mapped.startedAt,
          completedAt: mapped.completedAt,
          parentNodeId: mapped.parentNodeId,
        };
      });
    const mappedNodeStates = nodeStates.map(mapWorkflowNodeState);

    return {
      ...mapWorkflowInstanceRecord(instance),
      nodeStates: mappedNodeStates,
      childInstances: mappedChildInstances,
    };
  });
}
