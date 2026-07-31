// SPDX-License-Identifier: BUSL-1.1
/**
 * Coarse-grained edits to a definition graph.
 *
 * The designer saves whole documents; this is the other way in — a caller that
 * knows what it wants changed rather than what the result should look like.
 * Eight operations (upsert/delete a node or edge, set a node's config, set a
 * mapping parameter, add or remove an end-node output), applied in order to the
 * current draft, validated, and only then saved.
 *
 * Why it exists at all, given `saveWorkflowDefinitionVersion` takes a graph:
 * sending the whole document to change one node makes every concurrent edit a
 * conflict, and makes an API caller reimplement the graph's invariants to
 * assemble it. Deleting a node here also removes the edges that referenced it,
 * which a document write would leave to the caller to get right.
 *
 * Three properties worth knowing:
 *
 * - **Optimistic, not locked.** `expectedUpdatedAt` is checked against the row,
 *   so a patch built against a stale read is refused rather than merged. The
 *   pessimistic path is `definition-locks.ts`, for a designer session; this is
 *   for a caller making one change.
 * - **Validated before saving, unlike a draft save.** A patch is a deliberate
 *   edit with a known intent, so producing a broken graph means the intent was
 *   wrong. A hand-authored draft is allowed to be broken mid-thought.
 * - **`dryRun` returns the resulting graph and its issues without writing**, so
 *   a caller can show what would happen. That is the only reason validation
 *   results are returned rather than thrown.
 *
 * Edge identity falls back to a `source:sourceHandle:target:targetHandle` tuple
 * when an edge carries no id, because the designer has not always written one.
 */
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import type { DbSessionInput } from "../../../../apps/api/src/db/session.js";
import type { Json } from "../../../../apps/api/src/generated/db/types.js";
import {
  getWorkflowDefinition,
  getWorkflowDefinitionVersion,
} from "./definitions.js";
import {
  WorkflowDefinitionError,
  type WorkflowDefinitionGraph,
  type WorkflowDefinitionRecord,
  type WorkflowDefinitionVersionRecord,
} from "./definition-types.js";
import {
  publishWorkflowDefinitionVersion,
  saveWorkflowDefinitionVersion,
} from "./definition-mutations.js";
import {
  validateWorkflowDefinition,
  type WorkflowDefinitionValidationResult,
} from "./definition-validation.js";

export type WorkflowDefinitionPatchOperationType =
  | "upsertNode"
  | "updateNodeConfig"
  | "deleteNode"
  | "upsertEdge"
  | "deleteEdge"
  | "updateMappingParameter"
  | "upsertEndOutput"
  | "deleteEndOutput";

export type WorkflowDefinitionPatchOperation = {
  op: WorkflowDefinitionPatchOperationType;
  nodeId?: string | null;
  edgeId?: string | null;
  key?: string | null;
  node?: Record<string, unknown> | null;
  edge?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
  parameter?: Record<string, unknown> | null;
  output?: Record<string, unknown> | null;
};

export type PatchWorkflowDefinitionInput = {
  definitionId: string;
  expectedUpdatedAt: string;
  operations: WorkflowDefinitionPatchOperation[];
  dryRun?: boolean | null;
  publish?: boolean | null;
  changelog?: string | null;
};

export type WorkflowDefinitionPatchResult = {
  dryRun: boolean;
  definition: Json;
  validation: WorkflowDefinitionValidationResult;
  savedDefinition: WorkflowDefinitionRecord | null;
  publishedVersion: WorkflowDefinitionVersionRecord | null;
};

type DefinitionRecord = Record<string, unknown> & {
  nodes?: unknown[];
  edges?: unknown[];
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asDefinition(value: unknown): DefinitionRecord {
  const cloned = cloneJson(value ?? {});
  return cloned && typeof cloned === "object" && !Array.isArray(cloned)
    ? (cloned as DefinitionRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredText(value: string | null | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new WorkflowDefinitionError("BAD_USER_INPUT", `${label} is required.`);
  }
  return normalized;
}

function itemKey(value: unknown) {
  const record = asRecord(value);
  const key = record.key;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

function edgeIdentity(edge: Record<string, unknown>) {
  const id = edge.id;
  if (typeof id === "string" && id.trim()) {
    return `id:${id.trim()}`;
  }
  return [
    "route",
    edge.source,
    edge.sourceHandle,
    edge.target,
    edge.targetHandle,
  ].join(":");
}

function findNodeIndex(nodes: unknown[], nodeId: string) {
  return nodes.findIndex((entry) => asRecord(entry).id === nodeId);
}

function findEdgeIndex(edges: unknown[], edgeId: string) {
  return edges.findIndex((entry) => asRecord(entry).id === edgeId);
}

function upsertArrayItemByKey(items: unknown[], key: string, nextValue: Record<string, unknown>) {
  const index = items.findIndex((entry) => itemKey(entry) === key);
  if (index >= 0) {
    items[index] = { ...asRecord(items[index]), ...nextValue, key };
  } else {
    items.push({ ...nextValue, key });
  }
}

function applyOperation(definition: DefinitionRecord, operation: WorkflowDefinitionPatchOperation) {
  definition.nodes = asArray(definition.nodes);
  definition.edges = asArray(definition.edges);

  switch (operation.op) {
    case "upsertNode": {
      const node = asRecord(operation.node);
      const nodeId = requiredText(operation.nodeId ?? (node.id as string | undefined), "nodeId");
      const index = findNodeIndex(definition.nodes, nodeId);
      const nextNode = { ...node, id: nodeId };
      if (index >= 0) {
        definition.nodes[index] = { ...asRecord(definition.nodes[index]), ...nextNode };
      } else {
        definition.nodes.push(nextNode);
      }
      return;
    }
    case "updateNodeConfig": {
      const nodeId = requiredText(operation.nodeId, "nodeId");
      const index = findNodeIndex(definition.nodes, nodeId);
      if (index < 0) {
        throw new WorkflowDefinitionError("BAD_USER_INPUT", `Node "${nodeId}" was not found.`);
      }
      const node = asRecord(definition.nodes[index]);
      definition.nodes[index] = {
        ...node,
        config: {
          ...asRecord(node.config),
          ...asRecord(operation.config),
        },
      };
      return;
    }
    case "deleteNode": {
      const nodeId = requiredText(operation.nodeId, "nodeId");
      definition.nodes = definition.nodes.filter((entry) => asRecord(entry).id !== nodeId);
      definition.edges = definition.edges.filter((entry) => {
        const edge = asRecord(entry);
        return edge.source !== nodeId && edge.target !== nodeId;
      });
      return;
    }
    case "upsertEdge": {
      const edge = asRecord(operation.edge);
      const nextEdge = operation.edgeId ? { ...edge, id: operation.edgeId } : edge;
      const identity = edgeIdentity(nextEdge);
      const index = definition.edges.findIndex((entry) => edgeIdentity(asRecord(entry)) === identity);
      if (index >= 0) {
        definition.edges[index] = { ...asRecord(definition.edges[index]), ...nextEdge };
      } else {
        definition.edges.push(nextEdge);
      }
      return;
    }
    case "deleteEdge": {
      const edgeId = requiredText(operation.edgeId, "edgeId");
      definition.edges = definition.edges.filter((entry) => asRecord(entry).id !== edgeId);
      return;
    }
    case "updateMappingParameter": {
      const edgeId = requiredText(operation.edgeId, "edgeId");
      const key = requiredText(operation.key ?? itemKey(operation.parameter), "key");
      const index = findEdgeIndex(definition.edges, edgeId);
      if (index < 0) {
        throw new WorkflowDefinitionError("BAD_USER_INPUT", `Edge "${edgeId}" was not found.`);
      }
      const edge = asRecord(definition.edges[index]);
      const mappingParameters = [...asArray(edge.mappingParameters)];
      upsertArrayItemByKey(mappingParameters, key, asRecord(operation.parameter));
      definition.edges[index] = { ...edge, mappingParameters };
      return;
    }
    case "upsertEndOutput": {
      const nodeId = requiredText(operation.nodeId, "nodeId");
      const key = requiredText(operation.key ?? itemKey(operation.output), "key");
      const index = findNodeIndex(definition.nodes, nodeId);
      if (index < 0) {
        throw new WorkflowDefinitionError("BAD_USER_INPUT", `Node "${nodeId}" was not found.`);
      }
      const node = asRecord(definition.nodes[index]);
      const config = asRecord(node.config);
      const fields = [...asArray(config.fields)];
      upsertArrayItemByKey(fields, key, asRecord(operation.output));
      definition.nodes[index] = { ...node, config: { ...config, fields } };
      return;
    }
    case "deleteEndOutput": {
      const nodeId = requiredText(operation.nodeId, "nodeId");
      const key = requiredText(operation.key, "key");
      const index = findNodeIndex(definition.nodes, nodeId);
      if (index < 0) {
        throw new WorkflowDefinitionError("BAD_USER_INPUT", `Node "${nodeId}" was not found.`);
      }
      const node = asRecord(definition.nodes[index]);
      const config = asRecord(node.config);
      definition.nodes[index] = {
        ...node,
        config: {
          ...config,
          fields: asArray(config.fields).filter((entry) => itemKey(entry) !== key),
        },
      };
      return;
    }
  }
}

export function applyWorkflowDefinitionPatch(
  definition: unknown,
  operations: WorkflowDefinitionPatchOperation[],
): Json {
  const nextDefinition = asDefinition(definition);
  nextDefinition.nodes = asArray(nextDefinition.nodes);
  nextDefinition.edges = asArray(nextDefinition.edges);

  for (const operation of operations) {
    applyOperation(nextDefinition, operation);
  }

  return nextDefinition as Json;
}

export async function patchWorkflowDefinition(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  input: PatchWorkflowDefinitionInput,
): Promise<WorkflowDefinitionPatchResult | null> {
  const existing = await getWorkflowDefinition(db, session, input.definitionId);
  if (!existing) {
    return null;
  }
  if (existing.updatedAt !== input.expectedUpdatedAt) {
    throw new WorkflowDefinitionError("CONCURRENT_MODIFICATION", "Workflow definition was modified by another request.");
  }

  // The record carries a version NUMBER, not the graph — a list read must not
  // drag every definition's document with it. Fetch the draft being patched.
  const baseVersion =
    existing.latestVersion === null
      ? null
      : await getWorkflowDefinitionVersion(db, session, input.definitionId, existing.latestVersion);
  const baseDefinition: WorkflowDefinitionGraph = baseVersion?.definition ?? {
    nodes: [],
    edges: [],
  };
  const definition = applyWorkflowDefinitionPatch(baseDefinition, input.operations);
  const validation = validateWorkflowDefinition(definition);

  // A dry run reports, it does not refuse. Checking for errors first would mean
  // the preview could only ever come back valid — unavailable in exactly the
  // case a designer needs it, and returning one error's message in place of the
  // issue list the caller asked for.
  if (input.dryRun) {
    return {
      dryRun: true,
      definition,
      validation,
      savedDefinition: null,
      publishedVersion: null,
    };
  }

  const firstError = validation.issues.find((entry) => entry.severity === "error");
  if (firstError) {
    throw new WorkflowDefinitionError("BAD_USER_INPUT", firstError.message);
  }

  const savedDefinition = await saveWorkflowDefinitionVersion(db, session, {
    definitionId: input.definitionId,
    expectedUpdatedAt: input.expectedUpdatedAt,
    definition,
    changelog: input.changelog ?? null,
  });
  if (!savedDefinition) {
    return null;
  }

  const publishedVersion =
    input.publish && savedDefinition.latestVersion !== null
      ? await publishWorkflowDefinitionVersion(db, session, {
          definitionId: input.definitionId,
          version: savedDefinition.latestVersion,
        })
      : null;

  return {
    dryRun: false,
    definition,
    validation,
    savedDefinition,
    publishedVersion,
  };
}
