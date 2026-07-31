// SPDX-License-Identifier: BUSL-1.1
/**
 * The engine that turns a stored process graph into a run.
 *
 * One call walks one instance: pick the entry trigger, follow exactly one edge
 * per step, resolve each node's config, hand it to that node type's bridge, and
 * record what came back — until an end node, a park, or a failure stops the
 * walk. Everything happens inside the `Transaction<DB>` the caller hands in.
 * The engine opens neither a transaction nor a session of its own, so the run
 * and every row it writes commit together, and a bridge that throws takes the
 * step back with it rather than leaving half a node behind.
 *
 * Instance termination is not decided here. Node states are written, and
 * `tryCompleteInstanceInTransaction` reads them all and decides what the
 * instance became. Deciding it twice — once from the walk's own view, once from
 * the rows — is how the two answers get to disagree about a run that ended in
 * more than one way.
 *
 * ## What it deliberately does not do
 *
 * - **No parallelism, ever.** Every step resolves to one edge. Two edges that
 *   match a handle is an error, not a fork, and a trigger with two outgoing
 *   edges is an error too. This is a guarantee, not a limitation to be lifted
 *   quietly: the node-state model below cannot represent two live branches, so
 *   a fan-out that "worked" would silently interleave into one row set.
 * - **No expression language.** `{{ ... }}` substitution over a fixed set of
 *   roots is the whole of it — no operators, no calls, no conditionals. A
 *   placeholder that does not resolve fails the node; there is no
 *   leave-as-is fallback, because a template that survives into a bridge's
 *   config is a literal `{{...}}` string reaching a side effect.
 * - **One node-state row per node.** Writes are insert-if-absent then
 *   unconditional update on `(tenant_id, instance_id, node_id)`. Replay is
 *   therefore idempotent, but a node visited twice overwrites its own history:
 *   only `runtime.visitCount` survives from the earlier visit. A loop's
 *   per-iteration outputs are not recoverable from `workflow.node_states`.
 *
 * Node types are resolved through the hydrated catalog; see the note on silent
 * degradation in `node-catalog-store.ts` for why an unhydrated read throws
 * rather than answering "no such type".
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";
import { jsonbLiteral } from "../../../../apps/api/src/db/sql-helpers.js";
import type { DB } from "../../../../apps/api/src/generated/db/types.js";
import { isTriggerNodeType } from "./definition-types.js";
import { flattenFieldDefinitionSources } from "./field-definitions.js";
import {
  markNodeStateCompletedInTransaction,
  markNodeStateFailedInTransaction,
  markNodeStateWaitingInTransaction,
  tryCompleteInstanceInTransaction,
} from "./instance-completion.js";
import {
  getWorkflowNodeBridge,
  type WorkflowNodeBridgeContext,
  type WorkflowNodeBridgeOutput,
} from "./node-bridge.js";
import { getCatalogEntry } from "./node-catalog-store.js";
import {
  formatResolvedConfigValidationIssues,
  validateResolvedWorkflowNodeConfig,
} from "./resolved-config-validation.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProcessRuntimeNode = {
  id: string;
  type: string;
  config?: Record<string, unknown> | null;
};

export type ProcessRuntimeEdge = {
  source: string;
  /** Absent or null means "take the unique outgoing edge, whatever its handle". */
  sourceHandle?: string | null;
  target: string;
};

/**
 * What the engine needs from a definition, and nothing else.
 *
 * Structurally a supertype of `WorkflowDefinitionGraph`, so a stored graph can
 * be passed straight in. Declared separately rather than imported because the
 * authoring type describes a designer's document — labels, positions, edge
 * conditions — and an engine that took that type would imply it reads them.
 */
export type ProcessRuntimeDefinition = {
  nodes: ProcessRuntimeNode[];
  edges: ProcessRuntimeEdge[];
  /** Field definitions in the authoring layer's shape; read via `field-definitions.ts`. */
  processVariables?: readonly unknown[];
};

export type ProcessRuntimeOutputMapping = {
  sourcePath: string;
  targetKey: string;
};

export type ProcessRuntimeInput = {
  tenantId: string;
  instanceId: string;
  workflowDefinitionId: string;
  definition: ProcessRuntimeDefinition;
  /** "manual" | "schedule" | ... — picks a trigger node when `entryNodeId` is absent. */
  triggerType: string | null;
  /** The trigger's payload, exposed as `{{input.<field>}}`. */
  triggerPayload: Record<string, unknown>;
  /** Mutable run state, exposed as `{{process.<field>}}`. */
  processVariables?: Record<string, unknown>;
  /** Explicit entry node from the start command, when the caller knows it. */
  entryNodeId?: string | null;
  /** Node to continue from when a parked run is resumed; executed first, unrouted. */
  resumeFromNodeId?: string | null;
  startedBy: string;
};

export type ProcessRuntimeStatus = "completed" | "failed" | "noop" | "waiting";

export type ProcessRuntimeResult = {
  status: ProcessRuntimeStatus;
  visitedNodeIds: string[];
  finalNodeId: string | null;
  /** Set when status === "failed". */
  failure?: { code: string; message: string; nodeId: string | null };
};

export type ProcessRuntimeErrorCode =
  | "ENTRY_NOT_FOUND"
  | "ENTRY_TYPE_MISMATCH"
  | "AMBIGUOUS_TRIGGER"
  | "TRIGGER_FANOUT"
  | "EDGE_TARGET_MISSING"
  | "NO_EDGE_FOR_HANDLE"
  | "AMBIGUOUS_EDGES_FOR_HANDLE"
  | "UNKNOWN_NODE_TYPE"
  | "NO_BRIDGE"
  | "UNRESOLVED_VARIABLE"
  | "CONFIG_VALIDATION_FAILED"
  | "BRIDGE_THREW"
  | "END_STATUS_FAILURE"
  | "GRAPH_TOO_LARGE";

export class ProcessRuntimeError extends Error {
  readonly code: ProcessRuntimeErrorCode;
  readonly nodeId: string | null;

  constructor(
    message: string,
    code: ProcessRuntimeErrorCode,
    nodeId: string | null = null,
  ) {
    super(message);
    this.name = "ProcessRuntimeError";
    this.code = code;
    this.nodeId = nodeId;
  }
}

// ---------------------------------------------------------------------------
// Graph shape
// ---------------------------------------------------------------------------

/**
 * `isTriggerNodeType` decides what a trigger is everywhere else; `start` is the
 * one entry node that predates the naming convention and cannot be folded into
 * it. Restating the prefix rule here would give the two copies room to drift,
 * and a definition would then list a trigger the engine refuses to enter.
 */
function isTriggerNode(node: ProcessRuntimeNode): boolean {
  return isTriggerNodeType(node.type) || node.type === "start";
}

function isEndNode(node: ProcessRuntimeNode): boolean {
  return node.type.startsWith("end");
}

function expectedTriggerTypeForTriggerType(
  triggerType: string | null | undefined,
): string | null {
  if (!triggerType) return null;
  switch (triggerType) {
    case "manual":
      return "triggerManual";
    case "schedule":
    case "scheduled":
    case "cron":
      return "triggerSchedule";
    case "webhook":
      return "triggerWebhook";
    case "event":
      return "triggerEvent";
    default:
      return null;
  }
}

/**
 * Pick the node the walk starts from.
 *
 * An explicit `entryNodeId` wins and is checked: naming a node that is absent,
 * or one that is not a trigger, is a caller bug worth surfacing. Falling back
 * to the trigger type resolves at most one node, and null — no trigger of that
 * kind on this graph — is a no-op rather than an error, because a definition is
 * allowed not to answer a trigger it never declared.
 */
export function pickEntryNode(
  definition: ProcessRuntimeDefinition,
  input: { entryNodeId?: string | null; triggerType: string | null },
): ProcessRuntimeNode | null {
  if (input.entryNodeId) {
    const node = definition.nodes.find((entry) => entry.id === input.entryNodeId);
    if (!node) {
      throw new ProcessRuntimeError(
        `Entry node "${input.entryNodeId}" was not found in the workflow definition.`,
        "ENTRY_NOT_FOUND",
        input.entryNodeId,
      );
    }
    if (!isTriggerNode(node)) {
      throw new ProcessRuntimeError(
        `Entry node "${input.entryNodeId}" has type "${node.type}", which is not a trigger.`,
        "ENTRY_TYPE_MISMATCH",
        input.entryNodeId,
      );
    }
    return node;
  }

  const expected = expectedTriggerTypeForTriggerType(input.triggerType);
  if (!expected) return null;

  const candidates = definition.nodes.filter((node) => node.type === expected);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new ProcessRuntimeError(
      `Workflow has ${candidates.length} "${expected}" trigger nodes; supply entryNodeId to disambiguate.`,
      "AMBIGUOUS_TRIGGER",
    );
  }
  return candidates[0]!;
}

/**
 * Pick the one outgoing edge for the handle a node just emitted.
 *
 * A null handle means the walk is leaving a trigger, which has no handles to
 * match on: any single outgoing edge is taken, and more than one is a fan-out
 * this engine does not run. Otherwise an absent `sourceHandle` reads as
 * `"default"`, matching how every other reader of a stored graph treats it.
 */
export function selectNextEdge(
  edges: ProcessRuntimeEdge[],
  nodeId: string,
  outputHandle: string | null,
): ProcessRuntimeEdge | null {
  const outgoing = edges.filter((edge) => edge.source === nodeId);
  if (outgoing.length === 0) return null;

  if (outputHandle === null) {
    if (outgoing.length > 1) {
      throw new ProcessRuntimeError(
        `Trigger node "${nodeId}" has ${outgoing.length} outgoing edges; only one is supported.`,
        "TRIGGER_FANOUT",
        nodeId,
      );
    }
    return outgoing[0]!;
  }

  const matching = outgoing.filter((edge) => (edge.sourceHandle ?? "default") === outputHandle);
  if (matching.length === 0) {
    throw new ProcessRuntimeError(
      `No edge from node "${nodeId}" matches output handle "${outputHandle}".`,
      "NO_EDGE_FOR_HANDLE",
      nodeId,
    );
  }
  if (matching.length > 1) {
    throw new ProcessRuntimeError(
      `Node "${nodeId}" has ${matching.length} edges for output handle "${outputHandle}"; only one is supported.`,
      "AMBIGUOUS_EDGES_FOR_HANDLE",
      nodeId,
    );
  }
  return matching[0]!;
}

function hasOutgoingHandle(
  edges: ProcessRuntimeEdge[],
  nodeId: string,
  outputHandle: string,
): boolean {
  return edges.some(
    (edge) => edge.source === nodeId && (edge.sourceHandle ?? "default") === outputHandle,
  );
}

// ---------------------------------------------------------------------------
// Placeholder resolution
// ---------------------------------------------------------------------------

const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const STANDALONE_TEMPLATE_PATTERN = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/;

type VariableSource = {
  triggerPayload: Record<string, unknown>;
  processVariables?: Record<string, unknown>;
  inputSchemaFields?: readonly unknown[];
  outputSchemaFieldsByNodeId?: ReadonlyMap<string, readonly unknown[]>;
  /** nodeId -> the payload that node produced, for `nodes.<id>.output`. */
  completedOutputs: ReadonlyMap<string, Record<string, unknown>>;
};

/**
 * Split a placeholder path into lookup segments: dots separate keys, and
 * `[n]` suffixes become their own numeric segments, so `fields[0].key` and
 * `fields.0.key` address the same thing.
 */
function parseRuntimePath(path: string): string[] {
  return path
    .split(".")
    .flatMap((part) => {
      const trimmed = part.trim();
      if (!trimmed) return [];
      const segments: string[] = [];
      const head = trimmed.match(/^[^[\]]+/)?.[0];
      if (head) {
        segments.push(head);
      }
      for (const match of trimmed.matchAll(/\[(\d+)\]/g)) {
        segments.push(match[1]!);
      }
      return segments;
    })
    .filter(Boolean);
}

/**
 * Read one segment, with arrays given three readings in order: a numeric index,
 * then the element whose `key`/`name`/`id` matches, then the segment plucked
 * from every element. The last one is what makes
 * `{{nodes.x.outputSchema.fields.key}}` yield the list of keys — authors write
 * against field lists far more often than against positions, and requiring an
 * index there would make every such path depend on catalog ordering.
 */
function readPathSegment(value: object, segment: string): unknown {
  if (!Array.isArray(value)) {
    return (value as Record<string, unknown>)[segment];
  }

  if (/^\d+$/.test(segment)) {
    return value[Number(segment)];
  }

  const keyedEntry = value.find((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const record = entry as Record<string, unknown>;
    return record.key === segment || record.name === segment || record.id === segment;
  });
  if (keyedEntry !== undefined) {
    return keyedEntry;
  }

  const mapped = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const next = (entry as Record<string, unknown>)[segment];
    return next === undefined ? [] : [next];
  });

  return mapped.length > 0 ? mapped : undefined;
}

function readRuntimePath(value: unknown, segments: string[]): unknown {
  let cursor = value;
  for (const segment of segments) {
    if (cursor == null || typeof cursor !== "object") {
      return undefined;
    }
    cursor = readPathSegment(cursor, segment);
  }
  return cursor;
}

function lookupPath(
  expression: string,
  source: VariableSource,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const segments = parseRuntimePath(expression);
  if (segments.length === 0) {
    return { ok: false, reason: "empty expression" };
  }
  const head = segments[0];

  if (head === "input") {
    if (segments.length < 2) {
      return { ok: false, reason: "input.<field> requires a field name" };
    }
    const value = readRuntimePath(source.triggerPayload, segments.slice(1));
    if (value === undefined) {
      return { ok: false, reason: `input.${segments.slice(1).join(".")} is undefined` };
    }
    return { ok: true, value };
  }

  if (head === "inputSchema") {
    if (segments.length < 2 || segments[1] !== "fields") {
      return { ok: false, reason: "inputSchema.fields shape required" };
    }
    const value = readRuntimePath({ fields: source.inputSchemaFields ?? [] }, segments.slice(1));
    if (value === undefined) {
      return { ok: false, reason: `inputSchema.${segments.slice(1).join(".")} is undefined` };
    }
    return { ok: true, value };
  }

  if (head === "process") {
    if (segments.length < 2) {
      return { ok: false, reason: "process.<field> requires a field name" };
    }
    const value = readRuntimePath(source.processVariables ?? {}, segments.slice(1));
    if (value === undefined) {
      return { ok: false, reason: `process.${segments.slice(1).join(".")} is undefined` };
    }
    return { ok: true, value };
  }

  if (head === "nodes") {
    if (segments.length >= 3 && segments[2] === "outputSchema") {
      if (segments.length < 4 || segments[3] !== "fields") {
        return {
          ok: false,
          reason: `nodes.<id>.outputSchema.fields shape required (got ${expression})`,
        };
      }
      const nodeId = segments[1]!;
      const fields = source.outputSchemaFieldsByNodeId?.get(nodeId);
      if (!fields) {
        return { ok: false, reason: `node "${nodeId}" has no output schema fields` };
      }
      const value = readRuntimePath({ fields }, segments.slice(3));
      if (value === undefined) {
        return {
          ok: false,
          reason: `nodes.${nodeId}.outputSchema.${segments.slice(3).join(".")} is undefined`,
        };
      }
      return { ok: true, value };
    }

    if (segments.length < 3 || segments[2] !== "output") {
      return {
        ok: false,
        reason: `nodes.<id>.output.<field> shape required (got ${expression})`,
      };
    }
    const nodeId = segments[1]!;
    const output = source.completedOutputs.get(nodeId);
    if (!output) {
      return { ok: false, reason: `node "${nodeId}" has no completed output yet` };
    }
    if (segments.length === 3) {
      return { ok: true, value: output };
    }
    const value = readRuntimePath(output, segments.slice(3));
    if (value === undefined) {
      return {
        ok: false,
        reason: `nodes.${nodeId}.output.${segments.slice(3).join(".")} is undefined`,
      };
    }
    return { ok: true, value };
  }

  if (head === "env") {
    if (segments.length !== 2) {
      return { ok: false, reason: "env.<field> requires a single field name" };
    }
    if (segments[1] === "TODAY") {
      return { ok: true, value: new Date().toISOString().slice(0, 10) };
    }
    if (segments[1] === "NOW") {
      return { ok: true, value: new Date().toISOString() };
    }
    return { ok: false, reason: `env.${segments[1]} is undefined` };
  }

  return { ok: false, reason: `unknown variable root "${head}"` };
}

/**
 * A string that is nothing but one placeholder yields the value itself, so a
 * number stays a number and an object stays an object; anything mixed with
 * literal text is stringified per substitution. Without the first case every
 * config field fed by a placeholder would arrive at its bridge as a string, and
 * the resolved-config schemas would reject the run.
 */
function substituteString(value: string, source: VariableSource): unknown {
  const standalone = value.match(STANDALONE_TEMPLATE_PATTERN);
  if (standalone) {
    const lookup = lookupPath(standalone[1]!, source);
    if (!lookup.ok) {
      throw new ProcessRuntimeError(
        `Unresolved variable {{${standalone[1]!}}} (${lookup.reason}).`,
        "UNRESOLVED_VARIABLE",
      );
    }
    return lookup.value;
  }

  return value.replace(TEMPLATE_PATTERN, (_match, expression: string) => {
    const lookup = lookupPath(expression, source);
    if (!lookup.ok) {
      throw new ProcessRuntimeError(
        `Unresolved variable {{${expression}}} (${lookup.reason}).`,
        "UNRESOLVED_VARIABLE",
      );
    }
    if (lookup.value === null || lookup.value === undefined) return "";
    if (typeof lookup.value === "object") return JSON.stringify(lookup.value);
    return String(lookup.value);
  });
}

/**
 * Resolve a config value, recursing into arrays and objects.
 *
 * Operand objects — `{ kind: "field" | "path", path }`, as decision branches
 * carry them — additionally get a resolved `value` alongside their path. They
 * are addressed by path rather than by placeholder, so string substitution
 * never sees them, and the node that compares them would otherwise have to
 * reach back into the runtime's variable roots itself. `entityData.` paths are
 * left alone: those resolve against a row the bridge loads, which this engine
 * knows nothing about.
 */
export function resolveConfigValue(value: unknown, source: VariableSource): unknown {
  if (typeof value === "string") {
    return substituteString(value, source);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveConfigValue(entry, source));
  }
  if (value !== null && typeof value === "object") {
    const operand = value as Record<string, unknown>;
    const operandPath = typeof operand.path === "string" ? operand.path.trim() : "";
    if (
      (operand.kind === "field" || operand.kind === "path") &&
      operandPath &&
      !operandPath.startsWith("entityData.")
    ) {
      const lookup = lookupPath(operandPath, source);
      if (lookup.ok) {
        return {
          ...Object.fromEntries(
            Object.entries(operand).map(([key, entry]) => [key, resolveConfigValue(entry, source)]),
          ),
          value: lookup.value,
        };
      }
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = resolveConfigValue(entry, source);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

function normalizeJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return normalizeJsonRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSchemaFields(
  value: unknown,
  definition: ProcessRuntimeDefinition,
): Record<string, unknown>[] {
  return flattenFieldDefinitionSources(
    value,
    definition.processVariables ? { processVariables: definition.processVariables } : {},
  );
}

/**
 * The trigger's own declared fields, which double as the run's input schema.
 * Schedule triggers carry them under `mappingParameters` because their input is
 * a mapping from the schedule rather than a caller-supplied payload.
 */
function getInputSchemaFields(
  node: ProcessRuntimeNode | null,
  definition: ProcessRuntimeDefinition,
): Record<string, unknown>[] {
  if (!node || !isTriggerNode(node)) {
    return [];
  }
  const config = normalizeJsonRecord(node.config);
  const source =
    node.type === "triggerSchedule" ? config.mappingParameters : config.inputParameters;
  return normalizeSchemaFields(source, definition);
}

function applyInputSchemaDefaults(
  triggerPayload: Record<string, unknown>,
  inputSchemaFields: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const output = { ...triggerPayload };
  for (const field of inputSchemaFields) {
    const key = typeof field.key === "string" ? field.key.trim() : "";
    if (!key || output[key] !== undefined || field.defaultValue === undefined) {
      continue;
    }
    output[key] = field.defaultValue;
  }
  return output;
}

/**
 * Where a node says what it emits, most specific first. A definition that
 * declares its own output fields overrides the catalog's, so a node configured
 * for a narrower shape does not advertise the type's generic one.
 */
function getNodeOutputSchemaFields(
  node: ProcessRuntimeNode,
  definition: ProcessRuntimeDefinition,
): Record<string, unknown>[] {
  const config = normalizeJsonRecord(node.config);
  const candidates = [
    config.outputParameters,
    config.fieldDefinitions,
    config.fields,
    isTriggerNode(node)
      ? node.type === "triggerSchedule"
        ? config.mappingParameters
        : config.inputParameters
      : undefined,
    getCatalogEntry(node.type)?.outputFields,
  ];

  for (const candidate of candidates) {
    const fields = normalizeSchemaFields(candidate, definition);
    if (fields.length > 0) {
      return fields;
    }
  }

  return [];
}

function buildOutputSchemaFieldsByNodeId(
  definition: ProcessRuntimeDefinition,
): Map<string, readonly unknown[]> {
  const byNodeId = new Map<string, readonly unknown[]>();
  for (const node of definition.nodes) {
    const fields = getNodeOutputSchemaFields(node, definition);
    if (fields.length > 0) {
      byNodeId.set(node.id, fields);
    }
  }
  return byNodeId;
}

function processVariableFieldRecords(
  definition: ProcessRuntimeDefinition,
): Record<string, unknown>[] {
  return (definition.processVariables ?? []).filter(isPlainRecord);
}

/**
 * The process-variable keys a definition declares. A patch or mapping that
 * names anything else is dropped: process variables are part of a definition's
 * declared surface, and a bridge that could invent them would put state into a
 * run that nothing in the graph knows how to read.
 */
function declaredProcessVariableKeysOf(definition: ProcessRuntimeDefinition): Set<string> {
  return new Set(
    processVariableFieldRecords(definition)
      .map((field) => (typeof field.key === "string" ? field.key.trim() : ""))
      .filter((key) => key.length > 0),
  );
}

/**
 * The end node's payload: its declared fields, each resolved. This is the run's
 * result, so it is built from the definition rather than from whatever the last
 * bridge happened to return.
 */
function resolveEndPayload(
  node: ProcessRuntimeNode,
  source: VariableSource,
): Record<string, unknown> {
  const config = normalizeJsonRecord(node.config);
  const fields = flattenFieldDefinitionSources(resolveConfigValue(config.fields, source));
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const key = typeof field.key === "string" && field.key.trim() ? field.key.trim() : null;
    if (!key) continue;
    payload[key] = resolveConfigValue(field.value ?? field.defaultValue ?? null, source);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * A run that reaches this many node executions is looping, not progressing. The
 * cap exists because the graph is allowed to contain cycles — validation does
 * not reject them — so nothing else bounds the walk.
 */
const MAX_NODE_VISITS = 256;

type ProcessNodeExecutionState = {
  visitCounts: Map<string, number>;
};

/**
 * Walk one process instance.
 *
 * The caller must already be inside a database session, so the GUCs that RLS
 * and the audit triggers read are set; this function reuses the caller's
 * transaction rather than opening one, which is what makes a step atomic with
 * the bridge's own writes.
 */
export async function runProcessInstance(
  trx: Transaction<DB>,
  input: ProcessRuntimeInput,
): Promise<ProcessRuntimeResult> {
  const resumeFromNodeId = input.resumeFromNodeId ?? null;
  // A resume names its node directly: the run parked there, so it is entered
  // again without consulting an edge. Everything else starts at a trigger.
  const entry = resumeFromNodeId
    ? input.definition.nodes.find((node) => node.id === resumeFromNodeId) ?? null
    : pickEntryNode(input.definition, {
        entryNodeId: input.entryNodeId ?? null,
        triggerType: input.triggerType,
      });
  if (!entry) {
    if (resumeFromNodeId) {
      throw new ProcessRuntimeError(
        `Resume node "${resumeFromNodeId}" was not found in the workflow definition.`,
        "ENTRY_NOT_FOUND",
        resumeFromNodeId,
      );
    }
    // No trigger of this kind on this graph. The instance is left as it is;
    // something other than this trigger may still complete it.
    return { status: "noop", visitedNodeIds: [], finalNodeId: null };
  }

  const visited: string[] = [entry.id];
  const inputSchemaFields = getInputSchemaFields(entry, input.definition);
  const triggerPayload = applyInputSchemaDefaults(input.triggerPayload, inputSchemaFields);
  const outputSchemaFieldsByNodeId = buildOutputSchemaFieldsByNodeId(input.definition);
  const declaredProcessVariableKeys = declaredProcessVariableKeysOf(input.definition);
  const processVariableFields = processVariableFieldRecords(input.definition);

  // A resume re-enters a graph whose earlier nodes ran in a previous call, so
  // their outputs and visit counts have to come back out of node_states — an
  // in-memory walk cannot reconstruct what a previous transaction wrote.
  const completedOutputs = resumeFromNodeId
    ? await loadCompletedNodeOutputsInTransaction(trx, {
        tenantId: input.tenantId,
        instanceId: input.instanceId,
      })
    : new Map<string, Record<string, unknown>>();
  const executionState: ProcessNodeExecutionState = resumeFromNodeId
    ? await loadProcessNodeExecutionStateInTransaction(trx, {
        tenantId: input.tenantId,
        instanceId: input.instanceId,
      })
    : { visitCounts: new Map<string, number>() };

  let processVariables = normalizeJsonRecord(input.processVariables ?? {});

  if (!resumeFromNodeId) {
    completedOutputs.set(entry.id, triggerPayload);
    // Record the trigger up front, so node_states shows where the run entered
    // even if the first bridge never returns.
    await markNodeStateCompletedInTransaction(trx, {
      tenantId: input.tenantId,
      instanceId: input.instanceId,
      nodeId: entry.id,
      nodeType: entry.type,
      result: { trigger: input.triggerType ?? null, payload: triggerPayload },
    });
  }

  let cursor: ProcessRuntimeNode = entry;
  let lastOutputHandle: string | null = null;
  let lastPayload: Record<string, unknown> = {};
  let finalNodeId: string | null = entry.id;
  let executeCursorFirst = Boolean(resumeFromNodeId);
  let replayingResumeNode = Boolean(resumeFromNodeId);

  for (let step = 0; step < MAX_NODE_VISITS; step += 1) {
    const fromHandle = isTriggerNode(cursor) ? null : lastOutputHandle;
    let nextNode: ProcessRuntimeNode;
    if (executeCursorFirst) {
      executeCursorFirst = false;
      nextNode = cursor;
    } else {
      let nextEdge: ProcessRuntimeEdge | null;
      try {
        nextEdge = selectNextEdge(input.definition.edges, cursor.id, fromHandle);
      } catch (caught) {
        if (caught instanceof ProcessRuntimeError) {
          await failInstance(trx, input, cursor.id, caught);
          return failedResult(visited, cursor.id, caught);
        }
        throw caught;
      }

      if (!nextEdge) {
        // Nowhere to go. From an end node that is the run finishing; from
        // anything else it is a definition that stops mid-flow, which an
        // operator has to see rather than have silently treated as success.
        if (!isEndNode(cursor)) {
          const error = new ProcessRuntimeError(
            `Node "${cursor.id}" has no outgoing edges and is not an end node.`,
            "NO_EDGE_FOR_HANDLE",
            cursor.id,
          );
          await failInstance(trx, input, cursor.id, error);
          return failedResult(visited, cursor.id, error);
        }
        break;
      }

      const edgeTarget = input.definition.nodes.find((node) => node.id === nextEdge.target);
      if (!edgeTarget) {
        const error = new ProcessRuntimeError(
          `Edge from "${cursor.id}" points at unknown target "${nextEdge.target}".`,
          "EDGE_TARGET_MISSING",
          cursor.id,
        );
        await failInstance(trx, input, cursor.id, error);
        return failedResult(visited, cursor.id, error);
      }
      nextNode = edgeTarget;
      visited.push(nextNode.id);
      finalNodeId = nextNode.id;
    }

    if (isEndNode(nextNode)) {
      let endPayload: Record<string, unknown>;
      try {
        endPayload = resolveEndPayload(nextNode, {
          triggerPayload,
          processVariables,
          completedOutputs,
          inputSchemaFields,
          outputSchemaFieldsByNodeId,
        });
      } catch (caught) {
        if (caught instanceof ProcessRuntimeError) {
          await failInstance(trx, input, nextNode.id, caught);
          return failedResult(visited, nextNode.id, caught);
        }
        throw caught;
      }

      // An end node is how a definition reports a deliberate failure, so its
      // own payload decides whether the run succeeded — not whether the walk
      // reached it.
      if (endPayload.status === "failure") {
        const error = new ProcessRuntimeError(
          `Workflow end node "${nextNode.id}" returned failure status.`,
          "END_STATUS_FAILURE",
          nextNode.id,
        );
        const errorPayload = { code: error.code, message: error.message, details: endPayload };
        await markNodeStateFailedInTransaction(trx, {
          tenantId: input.tenantId,
          instanceId: input.instanceId,
          nodeId: nextNode.id,
          nodeType: nextNode.type,
          error: errorPayload,
        });
        await tryCompleteInstanceInTransaction(trx, {
          tenantId: input.tenantId,
          instanceId: input.instanceId,
          completedBy: input.startedBy,
          sharedResult: { ...endPayload, error: errorPayload },
        });
        return failedResult(visited, nextNode.id, error);
      }

      await markNodeStateCompletedInTransaction(trx, {
        tenantId: input.tenantId,
        instanceId: input.instanceId,
        nodeId: nextNode.id,
        nodeType: nextNode.type,
        result: { outputHandle: nextNode.id, payload: endPayload, end: true },
      });
      completedOutputs.set(nextNode.id, endPayload);
      cursor = nextNode;
      lastOutputHandle = nextNode.id;
      lastPayload = endPayload;
      break;
    }

    if (isTriggerNode(nextNode)) {
      // A trigger is an entry point, never a step. Reaching one along an edge
      // means the graph wires a second start into a running flow.
      const error = new ProcessRuntimeError(
        `Encountered trigger node "${nextNode.id}" mid-graph; triggers may only be entry points.`,
        "ENTRY_TYPE_MISMATCH",
        nextNode.id,
      );
      await failInstance(trx, input, nextNode.id, error);
      return failedResult(visited, nextNode.id, error);
    }

    const bridge = getWorkflowNodeBridge(nextNode.type);
    if (!bridge) {
      const error = new ProcessRuntimeError(
        `No workflow node bridge registered for type "${nextNode.type}".`,
        "NO_BRIDGE",
        nextNode.id,
      );
      await failInstance(trx, input, nextNode.id, error);
      return failedResult(visited, nextNode.id, error);
    }

    // The resumed node keeps the visit number it parked on, so its execution
    // key — and with it the idempotency key its bridge was given — is the same
    // string it saw before parking. Incrementing here would hand an idempotent
    // bridge a fresh key and make it redo the work the run was waiting on.
    const replayExistingWait = replayingResumeNode && nextNode.id === resumeFromNodeId;
    replayingResumeNode = false;
    const executionVisit = nextNodeExecutionVisit(executionState, {
      nodeId: nextNode.id,
      reuseCurrentVisit: replayExistingWait,
    });
    const executionKey = processNodeExecutionKey(input.instanceId, nextNode.id, executionVisit);

    let resolvedConfig: Record<string, unknown>;
    try {
      const source: VariableSource = {
        triggerPayload,
        processVariables,
        completedOutputs,
        inputSchemaFields,
        outputSchemaFieldsByNodeId,
      };
      resolvedConfig = resolveConfigValue(nextNode.config ?? {}, source) as Record<string, unknown>;
    } catch (caught) {
      if (caught instanceof ProcessRuntimeError) {
        await failInstance(trx, input, nextNode.id, caught);
        return failedResult(visited, nextNode.id, caught);
      }
      throw caught;
    }

    // Default the per-node idempotency key so a replayed step lands on the same
    // row in whatever ledger the bridge keeps.
    if (resolvedConfig.idempotencyKey === undefined || resolvedConfig.idempotencyKey === null) {
      resolvedConfig.idempotencyKey = executionKey;
    }

    let output: WorkflowNodeBridgeOutput | null = null;
    const configValidation = validateResolvedWorkflowNodeConfig(nextNode.type, resolvedConfig);
    // The validated value replaces the config rather than merely approving it:
    // validation is where the catalog's defaults and field aliases are applied,
    // so the bridge must see what came back, not what went in.
    resolvedConfig = configValidation.value;
    if (!configValidation.ok) {
      const message = formatResolvedConfigValidationIssues(configValidation.issues);
      const payload = {
        code: "CONFIG_VALIDATION_FAILED",
        message,
        issues: configValidation.issues,
      };
      // A graph that wires `configError` has said it wants to handle bad config
      // itself; one that has not gets the run failed, because there is nowhere
      // for the walk to continue to.
      if (hasOutgoingHandle(input.definition.edges, nextNode.id, "configError")) {
        output = { outputHandle: "configError", payload };
      } else {
        const error = new ProcessRuntimeError(
          `Resolved config for workflow node "${nextNode.type}" is invalid: ${message}`,
          "CONFIG_VALIDATION_FAILED",
          nextNode.id,
        );
        await failInstance(trx, input, nextNode.id, error);
        return failedResult(visited, nextNode.id, error);
      }
    }

    await upsertStartedNodeState(trx, {
      tenantId: input.tenantId,
      instanceId: input.instanceId,
      nodeId: nextNode.id,
      nodeType: nextNode.type,
      resolvedConfig,
      executionVisit,
    });

    const bridgeContext: WorkflowNodeBridgeContext = {
      // A Transaction<DB> satisfies every Kysely call a bridge makes, so the
      // bridge's writes join this transaction and commit or roll back with the
      // step. The cast is the type system catching up with that, not a widening.
      db: trx as unknown as OpenShapeForgeDatabase,
      tenantId: input.tenantId,
      instanceId: input.instanceId,
      nodeId: nextNode.id,
      workflowDefinitionId: input.workflowDefinitionId,
      triggeredBy: input.startedBy,
      rawConfig: nextNode.config ?? {},
      resolvedConfig,
      ...(processVariableFields.length > 0 ? { processVariableFields } : {}),
    };

    if (!output) {
      try {
        output = await bridge(bridgeContext);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        const error = new ProcessRuntimeError(
          `Workflow node bridge for "${nextNode.type}" threw: ${message}`,
          "BRIDGE_THREW",
          nextNode.id,
        );
        try {
          await failInstance(trx, input, nextNode.id, error);
        } catch (failureWriteError) {
          // The transaction is probably already aborted by whatever the bridge
          // did. Log what was lost and throw, rather than return a "failed"
          // result whose rows were never written.
          console.error(
            {
              instanceId: input.instanceId,
              nodeId: nextNode.id,
              nodeType: nextNode.type,
              originalError: message,
              failureWriteError:
                failureWriteError instanceof Error
                  ? failureWriteError.message
                  : String(failureWriteError),
            },
            "Workflow node bridge failed and the runtime could not persist the node failure.",
          );
          throw error;
        }
        return failedResult(visited, nextNode.id, error);
      }
    }

    completedOutputs.set(nextNode.id, output.payload ?? {});
    lastPayload = output.payload ?? {};

    if (output.wait) {
      // Parking, and the walk stops here without cascading. The node state the
      // shared writer leaves behind is non-terminal, and that open row IS the
      // parking mechanism — it is what holds the instance running until a
      // resume command re-enters this node. Nothing else marks the instance as
      // waiting, so returning without completing it is not an omission.
      // `markNodeStateWaitingInTransaction` documents why the status it writes
      // is `running`.
      await markNodeStateWaitingInTransaction(trx, {
        tenantId: input.tenantId,
        instanceId: input.instanceId,
        nodeId: nextNode.id,
        nodeType: nextNode.type,
        wait: output.wait,
        payload: output.payload ?? {},
        executionVisit,
      });
      return { status: "waiting", visitedNodeIds: visited, finalNodeId: nextNode.id };
    }

    await markProcessNodeStateCompletedInTransaction(trx, {
      tenantId: input.tenantId,
      instanceId: input.instanceId,
      nodeId: nextNode.id,
      nodeType: nextNode.type,
      result: { outputHandle: output.outputHandle, payload: output.payload ?? {} },
      executionVisit,
    });
    processVariables = await applyProcessVariablePatchInTransaction(trx, {
      tenantId: input.tenantId,
      instanceId: input.instanceId,
      declaredProcessVariableKeys,
      patch: output.processVariablePatch,
    });
    processVariables = await applyProcessOutputMappingsInTransaction(trx, {
      tenantId: input.tenantId,
      instanceId: input.instanceId,
      currentProcessVariables: processVariables,
      declaredProcessVariableKeys,
      node: nextNode,
      outputPayload: output.payload ?? {},
    });

    cursor = nextNode;
    lastOutputHandle = output.outputHandle;
  }

  if (visited.length >= MAX_NODE_VISITS) {
    const error = new ProcessRuntimeError(
      `Process workflow exceeded maximum node visits (${MAX_NODE_VISITS}); aborting to avoid runaway loop.`,
      "GRAPH_TOO_LARGE",
      cursor.id,
    );
    await failInstance(trx, input, cursor.id, error);
    return failedResult(visited, cursor.id, error);
  }

  // Termination is read off the rows, not asserted from here. Every node this
  // walk visited was written `completed`, so the cascade returns `completed`
  // unless something else on the instance says otherwise.
  const completion = await tryCompleteInstanceInTransaction(trx, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    completedBy: input.startedBy,
    sharedResult: lastOutputHandle
      ? { outputHandle: lastOutputHandle, payload: lastPayload, ...lastPayload }
      : {},
  });

  return {
    status: completion.finalStatus === "failed" ? "failed" : "completed",
    visitedNodeIds: visited,
    finalNodeId,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function failedResult(
  visited: string[],
  nodeId: string,
  error: ProcessRuntimeError,
): ProcessRuntimeResult {
  return {
    status: "failed",
    visitedNodeIds: visited,
    finalNodeId: nodeId,
    failure: { code: error.code, message: error.message, nodeId },
  };
}

/**
 * Write the node failure, then let the completion cascade read it and flip the
 * instance. The instance status is never set from here for the same reason the
 * success path does not set it: one reader of the rows, one answer.
 */
async function failInstance(
  trx: Transaction<DB>,
  input: ProcessRuntimeInput,
  nodeId: string,
  error: ProcessRuntimeError,
): Promise<void> {
  await markNodeStateFailedInTransaction(trx, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    nodeId,
    error: { code: error.code, message: error.message },
  });
  await tryCompleteInstanceInTransaction(trx, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    completedBy: input.startedBy,
    sharedResult: { error: { code: error.code, message: error.message } },
  });
}

async function loadCompletedNodeOutputsInTransaction(
  trx: Transaction<DB>,
  input: { tenantId: string; instanceId: string },
): Promise<Map<string, Record<string, unknown>>> {
  const rows = await trx
    .selectFrom("workflow.node_states")
    .select(["node_id", "shared_output"])
    .where("tenant_id", "=", input.tenantId)
    .where("instance_id", "=", input.instanceId)
    .where("status", "=", "completed")
    .execute();

  const outputs = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const sharedOutput = normalizeJsonRecord(row.shared_output);
    outputs.set(row.node_id, normalizeJsonRecord(sharedOutput.payload));
  }
  return outputs;
}

/**
 * How many times each node has already run, recovered from the one row it has.
 * `runtime.visitCount` is the only per-visit fact that survives an overwrite,
 * which is why it is written on every node-state update.
 */
async function loadProcessNodeExecutionStateInTransaction(
  trx: Transaction<DB>,
  input: { tenantId: string; instanceId: string },
): Promise<ProcessNodeExecutionState> {
  const rows = await trx
    .selectFrom("workflow.node_states")
    .select(["node_id", "shared_output"])
    .where("tenant_id", "=", input.tenantId)
    .where("instance_id", "=", input.instanceId)
    .execute();

  const visitCounts = new Map<string, number>();
  for (const row of rows) {
    const runtime = normalizeJsonRecord(normalizeJsonRecord(row.shared_output).runtime);
    const visitCount =
      typeof runtime.visitCount === "number" && Number.isFinite(runtime.visitCount)
        ? Math.max(1, Math.floor(runtime.visitCount))
        : 1;
    visitCounts.set(row.node_id, Math.max(visitCounts.get(row.node_id) ?? 0, visitCount));
  }

  return { visitCounts };
}

function processNodeExecutionKey(
  instanceId: string,
  nodeId: string,
  visitCount: number,
): string {
  // The first visit is unsuffixed so a graph without loops produces the same
  // key it would have before visit counting existed.
  return visitCount <= 1 ? `${instanceId}:${nodeId}` : `${instanceId}:${nodeId}:${visitCount}`;
}

function nextNodeExecutionVisit(
  state: ProcessNodeExecutionState,
  input: { nodeId: string; reuseCurrentVisit: boolean },
): number {
  const current = state.visitCounts.get(input.nodeId) ?? 0;
  const next = input.reuseCurrentVisit ? Math.max(1, current) : current + 1;
  state.visitCounts.set(input.nodeId, next);
  return next;
}

// ---------------------------------------------------------------------------
// Process variables
// ---------------------------------------------------------------------------

async function loadInstanceProcessVariablesInTransaction(
  trx: Transaction<DB>,
  input: { tenantId: string; instanceId: string; lock?: boolean },
): Promise<Record<string, unknown>> {
  let query = trx
    .selectFrom("workflow.instances")
    .select("process_variables")
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.instanceId);
  if (input.lock) {
    query = query.forUpdate();
  }
  const row = await query.executeTakeFirst();
  return normalizeJsonRecord(row?.process_variables);
}

function isArrayIndexSegment(segment: string): boolean {
  return /^\d+$/.test(segment);
}

function deepMergeJsonRecords(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    next[key] =
      isPlainRecord(existing) && isPlainRecord(value)
        ? deepMergeJsonRecords(existing, value)
        : value;
  }
  return next;
}

/**
 * Two records merge; anything else replaces. A node that writes an object into
 * a variable that already holds one is adding fields, not discarding the ones
 * it did not mention.
 */
function writeRuntimePathLeaf(current: unknown, value: unknown): unknown {
  return isPlainRecord(current) && isPlainRecord(value)
    ? deepMergeJsonRecords(current, value)
    : value;
}

function setRuntimePathValue(current: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) {
    return value;
  }

  const [head, ...tail] = segments;
  if (!head) {
    return current;
  }

  if (Array.isArray(current) || isArrayIndexSegment(head)) {
    const next = Array.isArray(current) ? [...current] : [];
    const index = Number(head);
    if (!Number.isSafeInteger(index)) {
      return current;
    }
    next[index] =
      tail.length === 0
        ? writeRuntimePathLeaf(next[index], value)
        : setRuntimePathValue(next[index], tail, value);
    return next;
  }

  const next = isPlainRecord(current) ? { ...current } : {};
  next[head] =
    tail.length === 0
      ? writeRuntimePathLeaf(next[head], value)
      : setRuntimePathValue(next[head], tail, value);
  return next;
}

function setProcessVariablePath(
  current: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const segments = parseRuntimePath(path);
  if (segments.length === 0) return current;
  const next = setRuntimePathValue(current, segments, value);
  return isPlainRecord(next) ? next : current;
}

/**
 * Apply a bridge's patch, keyed by process path. Every key is checked against
 * the definition's declared variables by its root segment; a definition that
 * declares none accepts no patch at all, which is what makes "this workflow has
 * no process state" a statement the graph can make rather than an absence.
 */
function mergeProcessVariablePatch(
  currentProcessVariables: Record<string, unknown>,
  patch: unknown,
  declaredProcessVariableKeys?: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isPlainRecord(patch)) {
    return currentProcessVariables;
  }

  return Object.entries(patch).reduce((next, [path, value]) => {
    const root = path.split(".")[0]?.trim() ?? "";
    if (
      declaredProcessVariableKeys &&
      (declaredProcessVariableKeys.size === 0 || !declaredProcessVariableKeys.has(root))
    ) {
      return next;
    }
    return setProcessVariablePath(next, path, value);
  }, currentProcessVariables);
}

function normalizeProcessOutputMappings(value: unknown): ProcessRuntimeOutputMapping[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!isPlainRecord(entry)) {
      return [];
    }
    const sourcePath = typeof entry.sourcePath === "string" ? entry.sourcePath.trim() : "";
    const targetKey = typeof entry.targetKey === "string" ? entry.targetKey.trim() : "";
    if (!sourcePath || !targetKey) {
      return [];
    }
    return [{ sourcePath, targetKey }];
  });
}

function applyProcessOutputMappingsToVariables(input: {
  currentProcessVariables: Record<string, unknown>;
  declaredProcessVariableKeys: ReadonlySet<string>;
  mappings: ProcessRuntimeOutputMapping[];
  outputPayload: Record<string, unknown>;
}): Record<string, unknown> {
  if (input.declaredProcessVariableKeys.size === 0 || input.mappings.length === 0) {
    return input.currentProcessVariables;
  }

  return input.mappings.reduce((next, mapping) => {
    const targetRoot = parseRuntimePath(mapping.targetKey)[0]?.trim() ?? "";
    if (!targetRoot || !input.declaredProcessVariableKeys.has(targetRoot)) {
      return next;
    }
    const value = readRuntimePath(input.outputPayload, parseRuntimePath(mapping.sourcePath));
    if (value === undefined) {
      return next;
    }
    return setProcessVariablePath(next, mapping.targetKey, value);
  }, input.currentProcessVariables);
}

/**
 * Both writers re-read the row `for update` rather than patching the copy the
 * walk carries: a bridge may have written process variables itself, and merging
 * onto a stale snapshot would silently drop that.
 */
async function applyProcessVariablePatchInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    declaredProcessVariableKeys: ReadonlySet<string>;
    patch: unknown;
  },
): Promise<Record<string, unknown>> {
  const currentProcessVariables = await loadInstanceProcessVariablesInTransaction(trx, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    lock: true,
  });
  const next = mergeProcessVariablePatch(
    currentProcessVariables,
    input.patch,
    input.declaredProcessVariableKeys,
  );
  if (next === currentProcessVariables) {
    return currentProcessVariables;
  }

  await sql`
    update workflow.instances
    set process_variables = ${jsonbLiteral(next)}
    where tenant_id = cast(${input.tenantId} as uuid)
      and id = cast(${input.instanceId} as uuid)
  `.execute(trx);
  return next;
}

/**
 * The declarative half of the same write: a node's `processOutputMappings` copy
 * paths out of its payload into process variables. A node may narrow the
 * allowed targets with its own `processVariableKeys`; absent that, the
 * definition's declared set applies.
 */
async function applyProcessOutputMappingsInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    currentProcessVariables: Record<string, unknown>;
    declaredProcessVariableKeys: ReadonlySet<string>;
    node: ProcessRuntimeNode;
    outputPayload: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const mappings = normalizeProcessOutputMappings(input.node.config?.processOutputMappings);
  if (mappings.length === 0) {
    return input.currentProcessVariables;
  }

  const nodeKeys = new Set(
    (input.node.config?.processVariableKeys as unknown[] | undefined)
      ?.filter((key): key is string => typeof key === "string")
      .map((key) => key.trim())
      .filter(Boolean) ?? [],
  );
  const currentProcessVariables = await loadInstanceProcessVariablesInTransaction(trx, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    lock: true,
  });
  const next = applyProcessOutputMappingsToVariables({
    currentProcessVariables,
    declaredProcessVariableKeys:
      nodeKeys.size > 0 ? nodeKeys : input.declaredProcessVariableKeys,
    mappings,
    outputPayload: input.outputPayload,
  });
  if (next === currentProcessVariables) {
    return currentProcessVariables;
  }

  await sql`
    update workflow.instances
    set process_variables = ${jsonbLiteral(next)}
    where tenant_id = cast(${input.tenantId} as uuid)
      and id = cast(${input.instanceId} as uuid)
  `.execute(trx);
  return next;
}

// ---------------------------------------------------------------------------
// Node-state writes
// ---------------------------------------------------------------------------
//
// Both follow the same shape as the shared writers in `instance-completion.ts`:
// insert if no row exists for (tenant_id, instance_id, node_id), then update
// unconditionally. That makes a replayed step idempotent and keeps exactly one
// row per node — at the cost of history. A node visited a second time
// overwrites what the first visit recorded, and only `runtime.visitCount`
// carries across. There is no per-iteration record of a loop in
// `workflow.node_states`; anything that needs one has to be written by the node
// itself.
//
// These two stay local because they carry `runtime.visitCount`, which only the
// walk knows; the completed/failed/waiting writers are shared, so the cascade
// and the engine cannot disagree about what a settled node looks like.

async function upsertStartedNodeState(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    nodeId: string;
    nodeType: string;
    resolvedConfig: Record<string, unknown>;
    executionVisit: number;
  },
): Promise<void> {
  await sql`
    insert into workflow.node_states (
      tenant_id, instance_id, node_id, node_type,
      status, input, resolved_parameters,
      shared_output, private_output, started_at, completed_at, error
    )
    select
      cast(${input.tenantId} as uuid),
      cast(${input.instanceId} as uuid),
      ${input.nodeId},
      ${input.nodeType},
      'running',
      '{}'::jsonb,
      ${jsonbLiteral(input.resolvedConfig)},
      '{}'::jsonb,
      '{}'::jsonb,
      now(),
      null,
      null
    where not exists (
      select 1 from workflow.node_states
      where tenant_id = cast(${input.tenantId} as uuid)
        and instance_id = cast(${input.instanceId} as uuid)
        and node_id = ${input.nodeId}
    )
  `.execute(trx);

  await sql`
    update workflow.node_states
    set
      node_type = ${input.nodeType},
      status = 'running',
      resolved_parameters = ${jsonbLiteral(input.resolvedConfig)},
      shared_output = ${jsonbLiteral({ runtime: { visitCount: input.executionVisit } })},
      completed_at = null,
      error = null
    where tenant_id = cast(${input.tenantId} as uuid)
      and instance_id = cast(${input.instanceId} as uuid)
      and node_id = ${input.nodeId}
  `.execute(trx);
}

async function markProcessNodeStateCompletedInTransaction(
  trx: Transaction<DB>,
  input: {
    tenantId: string;
    instanceId: string;
    nodeId: string;
    nodeType: string;
    result: Record<string, unknown>;
    executionVisit: number;
  },
): Promise<void> {
  const sharedOutput = { ...input.result, runtime: { visitCount: input.executionVisit } };
  await sql`
    insert into workflow.node_states (
      tenant_id, instance_id, node_id, node_type,
      status, input, resolved_parameters,
      shared_output, private_output, started_at, completed_at, error
    )
    select
      cast(${input.tenantId} as uuid),
      cast(${input.instanceId} as uuid),
      ${input.nodeId},
      ${input.nodeType},
      'completed',
      '{}'::jsonb,
      '{}'::jsonb,
      ${jsonbLiteral(sharedOutput)},
      '{}'::jsonb,
      now(),
      now(),
      null
    where not exists (
      select 1 from workflow.node_states
      where tenant_id = cast(${input.tenantId} as uuid)
        and instance_id = cast(${input.instanceId} as uuid)
        and node_id = ${input.nodeId}
    )
  `.execute(trx);

  await sql`
    update workflow.node_states
    set
      node_type = ${input.nodeType},
      status = 'completed',
      shared_output = ${jsonbLiteral(sharedOutput)},
      completed_at = now(),
      error = null
    where tenant_id = cast(${input.tenantId} as uuid)
      and instance_id = cast(${input.instanceId} as uuid)
      and node_id = ${input.nodeId}
  `.execute(trx);
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

/** The pure helpers, exposed so they can be tested without a database. */
export const __processRuntimeInternals = {
  isTriggerNode,
  isEndNode,
  expectedTriggerTypeForTriggerType,
  pickEntryNode,
  selectNextEdge,
  hasOutgoingHandle,
  resolveConfigValue,
  resolveEndPayload,
  buildOutputSchemaFieldsByNodeId,
  mergeProcessVariablePatch,
  applyProcessOutputMappingsToVariables,
};
