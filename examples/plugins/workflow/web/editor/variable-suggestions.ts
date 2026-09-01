// SPDX-License-Identifier: BUSL-1.1
/**
 * What one node can see: the variables an author may reference from its config.
 *
 * `workflowGraphVariables` — the resolver behind a field's variable picker — is
 * a protocol adapter that returns whatever it is handed, and the server's
 * version returns `[]` because nothing there can see a canvas. This is the walk
 * that produces the real list, and it is here rather than in the inspector
 * because `apps/web` has no test runner and a wrong answer here is invisible: a
 * missing variable is a picker that quietly offers less, and an invented one is
 * a graph that publishes and then dies on UNRESOLVED_VARIABLE at run time.
 *
 * ## The four roots, and where each one comes from
 *
 * Taken from `lookupPath` in `runtime/process-runtime.ts`, which is the only
 * authority on what a `{{…}}` may say. This offers a strict subset of it:
 *
 * - **`process.<key>`** — the definition's declared process variables. Every
 *   node sees all of them: the bag is seeded before the walk starts and is
 *   never scoped to a branch.
 * - **`input.<field>`** — the run's trigger payload. Offered from the entry
 *   nodes UPSTREAM of this one, because that is where a run entered to reach
 *   it. With several, only the fields they all declare compatibly are offered;
 *   see {@link commonStartFields}.
 * - **`nodes.<id>.output.<path>`** — a node's completed output, for every node
 *   upstream of this one, plus the whole `nodes.<id>.output` object.
 * - **`env.TODAY` / `env.NOW`** — deliberately absent. They resolve at run time
 *   with no reference to the graph, so they belong to whatever documents the
 *   template language rather than to a graph walk, and offering them here would
 *   make this list's contents depend on two unrelated things.
 *
 * `inputSchema.fields` and `nodes.<id>.outputSchema.fields` also resolve at run
 * time and are also left out: they yield a list of field DEFINITIONS rather
 * than a value, which is a shape only a field-schema editor consumes, and this
 * repo has none. Noted so that adding one is an addition rather than a
 * rediscovery.
 *
 * ## What "upstream" means, with cycles
 *
 * A workflow graph may legitimately loop — a decision that sends work back for
 * rework is the ordinary case — so a naive backwards walk would never
 * terminate, and a merely visited-guarded one would report a node's own
 * DOWNSTREAM neighbours as upstream of it.
 *
 * So back edges are removed first: a depth-first pass over the whole graph, and
 * any edge whose target is already on the current stack is one. What is left is
 * a DAG, and "upstream" is reachability backwards through it. On the second lap
 * of a loop a node's output genuinely IS available, but on the first it is not,
 * and a picker that offered it would be right only sometimes — which is worse
 * than being conservatively silent, because the author cannot tell which lap
 * they are authoring for.
 *
 * Unreachable nodes fall out of the same rule without a special case: nothing
 * connects them to the target, so nothing they emit is offered, and a node with
 * no incoming edges at all sees only `process.*`.
 *
 * ## Where a node's output fields come from
 *
 * The same four places `getNodeOutputSchemaFields` in `runtime/process-runtime.ts`
 * looks, in the same order, ending at the catalog's `outputFields` — and read
 * through the runtime's own `flattenFieldDefinitionSources`, imported rather
 * than reimplemented. Two readings of an authored field list is how a designer
 * comes to offer a variable the engine cannot resolve.
 */
import type { CanvasEdge, CanvasNode } from "../graph/canvas-graph";
import { isEntryNodeType } from "../../runtime/definition-types";
import { flattenFieldDefinitionSources } from "../../runtime/field-definitions";

/**
 * One entry in a field's variable picker.
 *
 * Declared structurally rather than imported, for the reason `config-form.ts`
 * gives: `VariableSuggestion` lives in `apps/web` and reaches its own types
 * through the `@/*` alias, which the plugin's web project does not declare. The
 * assignment at the call site in `apps/web` is what pins the two together, so a
 * shape that stops satisfying `VariableSuggestion` fails `typecheck:web` there.
 */
export type WorkflowVariableSuggestion = {
  /** The runtime path, without braces. `nodes.approve_1.output.decision`. */
  path: string;
  /** The same path as a reader should see it. `output.decision`. */
  displayPath: string;
  /** The path WITHIN its source. `decision`. */
  fieldPath: string;
  /** What gets typed into the field. `{{…}}` around the path. */
  insertText: string;
  label: string;
  /** The label with its parents, for a nested field. Absent when it adds nothing. */
  displayLabel?: string;
  sourceNodeId: string;
  sourceNodeLabel: string;
  /** Edges from the node being configured back to the source. Absent for `process.*`. */
  sourceNodeDistance?: number;
  valueType: "string" | "number" | "boolean" | "object" | "array";
  semanticType?: string;
  itemSemanticType?: string;
};

export type BuildWorkflowVariableSuggestionsInput = {
  /** The graph as the canvas holds it. */
  graph: {
    readonly nodes: readonly CanvasNode[];
    readonly edges: readonly CanvasEdge[];
  };
  /** The node whose config is being edited. Not itself a source. */
  nodeId: string;
  /** `processVariables`, as the document holds them. */
  processVariables?: readonly unknown[];
  /**
   * The catalog's `outputFields` for a node type, when the caller has them.
   *
   * An input rather than a lookup for the same reason `resolveConfigFields` is
   * on `CanvasGraphOptions`: the catalog store is hydrated from Postgres and
   * throws outside the API process. A caller that omits it still gets every
   * variable a node's own config declares — which is most of them, since a node
   * configured for a narrower shape overrides the catalog's anyway — and loses
   * the generic per-type list.
   */
  resolveOutputFields?: (nodeType: string) => unknown;
  /** Preferred locale for labels; falls back to English, then to any. */
  locale?: string;
};

/** The source id `process.*` suggestions carry. Not a node; nothing draws it. */
export const PROCESS_VARIABLE_SOURCE_ID = "workflow-process";

/** The source id `input.*` suggestions carry. Also not a node. */
export const START_INPUT_SOURCE_ID = "workflow-input";

/**
 * Guard against a field tree that refers to itself.
 *
 * `configFields` and `outputFields` arrive from a JSON column, so a cycle is a
 * document nobody validated rather than a thing that cannot happen. Ten levels
 * is deeper than any authored field in this repo and shallow enough that the
 * flattening cannot become the reason a picker is slow.
 */
const MAX_FIELD_DEPTH = 10;

export function buildWorkflowVariableSuggestions(
  input: BuildWorkflowVariableSuggestionsInput,
): WorkflowVariableSuggestion[] {
  const locale = input.locale ?? "en";
  const nodesById = new Map(input.graph.nodes.map((node) => [node.id, node] as const));
  const incoming = upstreamEdgesByTarget(input.graph);
  const distances = upstreamDistances(input.nodeId, incoming);

  // Keyed by path, first writer winning. Nodes are visited nearest-first, so a
  // path two nodes offer is attributed to the closer one — which is the one an
  // author configuring this node is thinking about.
  const byPath = new Map<string, WorkflowVariableSuggestion>();

  for (const field of flattenFieldDefinitionSources(input.processVariables ?? [])) {
    addFlattenedField(byPath, {
      field,
      pathPrefix: "process",
      displayPathPrefix: "process",
      sourceNodeId: PROCESS_VARIABLE_SOURCE_ID,
      sourceNodeLabel: "Process variables",
      locale,
    });
  }

  const upstream = [...distances.entries()]
    .flatMap(([id, distance]) => {
      const node = nodesById.get(id);
      return node ? [{ node, distance }] : [];
    })
    .sort((left, right) => left.distance - right.distance || left.node.id.localeCompare(right.node.id));

  const triggers = upstream.filter((entry) => isEntryNodeType(entry.node.type));
  // The nearest trigger's distance, because `upstream` is sorted by it. There
  // is one `input.*` list however many triggers contributed to it, so it gets
  // the closest of their distances rather than one per source.
  const nearestTrigger = triggers[0]?.distance;
  for (const field of commonStartFields(triggers.map((entry) => entry.node))) {
    addFlattenedField(byPath, {
      field,
      pathPrefix: "input",
      displayPathPrefix: "input",
      sourceNodeId: START_INPUT_SOURCE_ID,
      sourceNodeLabel: "Start variables",
      ...(nearestTrigger !== undefined ? { sourceNodeDistance: nearestTrigger } : {}),
      locale,
    });
  }

  for (const { node, distance } of upstream) {
    const sourceNodeLabel = node.data.label.trim() || node.id;
    const outputPath = `nodes.${node.id}.output`;
    const fields = nodeOutputFields(node, input.resolveOutputFields);

    for (const field of fields) {
      addFlattenedField(byPath, {
        field,
        pathPrefix: outputPath,
        displayPathPrefix: "output",
        sourceNodeId: node.id,
        sourceNodeLabel,
        sourceNodeDistance: distance,
        locale,
      });
    }

    // The whole payload, for a template that wants the record rather than a
    // leaf of it. `lookupPath` answers `nodes.<id>.output` with the output
    // object itself, so this is a path the runtime resolves whether or not the
    // node declares any fields at all.
    if (!byPath.has(outputPath)) {
      byPath.set(outputPath, {
        path: outputPath,
        displayPath: "output",
        fieldPath: "output",
        insertText: `{{${outputPath}}}`,
        label: "Output",
        sourceNodeId: node.id,
        sourceNodeLabel,
        sourceNodeDistance: distance,
        valueType: "object",
      });
    }
  }

  // Sorted by path rather than by distance: the picker reads `sourceNodeDistance`
  // itself when it wants proximity, and a stable order is what makes this
  // testable and makes a re-render not reshuffle the list under a cursor.
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * What a process variable's START VALUE may reference, which is a strictly
 * smaller list than what a node's config may.
 *
 * Seeding happens once, before the walk, against
 * `{ triggerPayload, processVariables, completedOutputs: <empty> }` — read
 * `initializeProcessVariables` in `runtime/command-runtime.ts`. Two things
 * follow, and both are the sort of thing a picker gets wrong silently:
 *
 * - **No node output.** `completedOutputs` is empty at that moment, so every
 *   `{{nodes.…}}` an author could pick would fail the run it is meant to start.
 * - **Only EARLIER process variables.** The bag is handed to the resolver by
 *   reference and filled in document order, so a declaration can read the ones
 *   above it and not the ones below. Offering the whole list would let an
 *   author seed `total` from `tax` and get `null`.
 *
 * `input.*` comes from every entry node on the graph rather than from the ones
 * upstream of anything: seeding is per RUN, and which trigger started it is not
 * a property of the variable. The agreement rule in {@link commonStartFields}
 * therefore does the whole job — a field only one trigger declares would be
 * undefined on a run through another.
 */
export function buildProcessVariableStartValueSuggestions(input: {
  graph: { readonly nodes: readonly CanvasNode[] };
  /** `processVariables`, as the document holds them. */
  processVariables?: readonly unknown[];
  /** The variable being seeded. Omit for the whole list. */
  key?: string;
  locale?: string;
}): WorkflowVariableSuggestion[] {
  const locale = input.locale ?? "en";
  const byPath = new Map<string, WorkflowVariableSuggestion>();

  const declared = flattenFieldDefinitionSources(input.processVariables ?? []);
  const seededAt =
    input.key === undefined
      ? declared.length
      : declared.findIndex((field) => asString(field.key) === input.key!.trim());
  for (const field of declared.slice(0, seededAt < 0 ? declared.length : seededAt)) {
    addFlattenedField(byPath, {
      field,
      pathPrefix: "process",
      displayPathPrefix: "process",
      sourceNodeId: PROCESS_VARIABLE_SOURCE_ID,
      sourceNodeLabel: "Process variables",
      locale,
    });
  }

  const triggers = input.graph.nodes.filter((node) => isEntryNodeType(node.type));
  for (const field of commonStartFields(triggers)) {
    addFlattenedField(byPath, {
      field,
      pathPrefix: "input",
      displayPathPrefix: "input",
      sourceNodeId: START_INPUT_SOURCE_ID,
      sourceNodeLabel: "Start variables",
      locale,
    });
  }

  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/**
 * Every edge that is not a back edge, grouped by the node it points at.
 *
 * A back edge is one whose target is already on the depth-first stack — the
 * textbook definition, run from every node in document order so that a
 * component with no entry node is covered too. Removing them is what makes the
 * remaining walk finite and stops a loop reporting a node's successors as its
 * predecessors; see the file header.
 *
 * Exported for the tests, which is the only way to assert the rule directly:
 * from the outside a dropped back edge and a node that simply has no fields
 * look the same.
 */
export function upstreamEdgesByTarget(graph: {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
}): Map<string, CanvasEdge[]> {
  const outgoing = new Map<string, CanvasEdge[]>();
  for (const edge of graph.edges) {
    const edges = outgoing.get(edge.source) ?? [];
    edges.push(edge);
    outgoing.set(edge.source, edges);
  }

  const visited = new Set<string>();
  const onStack = new Set<string>();
  const backEdgeIds = new Set<string>();

  // Iterative, not recursive: a graph is a document and a deep chain of nodes
  // must not be able to overflow the stack of the browser drawing it.
  const walk = (start: string): void => {
    const frames: { nodeId: string; index: number }[] = [{ nodeId: start, index: 0 }];
    visited.add(start);
    onStack.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const edges = outgoing.get(frame.nodeId) ?? [];
      if (frame.index >= edges.length) {
        onStack.delete(frame.nodeId);
        frames.pop();
        continue;
      }

      const edge = edges[frame.index]!;
      frame.index += 1;
      if (onStack.has(edge.target)) {
        backEdgeIds.add(edge.id);
        continue;
      }
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      onStack.add(edge.target);
      frames.push({ nodeId: edge.target, index: 0 });
    }
  };

  for (const node of graph.nodes) {
    if (!visited.has(node.id)) walk(node.id);
  }

  const incoming = new Map<string, CanvasEdge[]>();
  for (const edge of graph.edges) {
    if (backEdgeIds.has(edge.id)) continue;
    const edges = incoming.get(edge.target) ?? [];
    edges.push(edge);
    incoming.set(edge.target, edges);
  }
  return incoming;
}

/**
 * How many edges back each upstream node is, by breadth-first search against
 * the reversed graph.
 *
 * The target itself is deliberately absent: a node cannot read its own output,
 * and with back edges already removed it cannot reach itself either, so this
 * needs no special case.
 */
function upstreamDistances(
  targetNodeId: string,
  incoming: ReadonlyMap<string, readonly CanvasEdge[]>,
): Map<string, number> {
  const distances = new Map<string, number>();
  let frontier = [targetNodeId];
  let distance = 0;

  while (frontier.length > 0) {
    distance += 1;
    const next: string[] = [];
    for (const nodeId of frontier) {
      for (const edge of incoming.get(nodeId) ?? []) {
        if (edge.source === targetNodeId || distances.has(edge.source)) continue;
        distances.set(edge.source, distance);
        next.push(edge.source);
      }
    }
    frontier = next;
  }

  return distances;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * A node's output fields: the four places the process runtime looks, in the
 * same order, first non-empty winning.
 *
 * A definition that declares its own fields therefore overrides the catalog's,
 * so a node configured for a narrower shape does not advertise the generic one
 * — which is what `getNodeOutputSchemaFields` decided and is why this list is
 * copied from it rather than invented.
 */
function nodeOutputFields(
  node: CanvasNode,
  resolveOutputFields: ((nodeType: string) => unknown) | undefined,
): Record<string, unknown>[] {
  const config = node.data.config;
  const candidates: unknown[] = [
    config.outputParameters,
    config.fieldDefinitions,
    config.fields,
    isEntryNodeType(node.type)
      ? node.type === "triggerSchedule"
        ? config.mappingParameters
        : config.inputParameters
      : undefined,
    resolveOutputFields?.(node.type),
  ];

  for (const candidate of candidates) {
    const fields = flattenFieldDefinitionSources(candidate);
    if (fields.length > 0) return fields;
  }
  return [];
}

/**
 * A trigger's declared start fields, exactly as `getInputSchemaFields` reads
 * them: `mappingParameters` for a schedule, whose input is a mapping rather
 * than a caller-supplied payload, and `inputParameters` for everything else.
 */
function startFields(node: CanvasNode): Record<string, unknown>[] {
  const config = node.data.config;
  return flattenFieldDefinitionSources(
    node.type === "triggerSchedule" ? config.mappingParameters : config.inputParameters,
  );
}

/**
 * The start fields every upstream trigger agrees on.
 *
 * `input.*` is the payload of whichever trigger the run entered at, and a node
 * with two triggers upstream of it cannot know which. So a field is offered
 * only when every one of them declares it compatibly — same key, same value
 * type, same cardinality, same semantic type — and a field only one trigger has
 * is not offered at all, because a run through the other would resolve it as
 * undefined and fail.
 *
 * With exactly one upstream trigger this is all of its fields, which is the
 * ordinary case and the reason the rule is stated as agreement rather than as a
 * multi-trigger special case.
 */
function commonStartFields(triggers: readonly CanvasNode[]): Record<string, unknown>[] {
  if (triggers.length === 0) return [];
  const declared = triggers.map((node) => startFields(node));
  const [first, ...rest] = declared;
  if (!first) return [];

  return first.filter((candidate) => {
    const key = asString(candidate.key);
    if (!key) return false;
    return rest.every((fields) =>
      fields.some((field) => sameStartField(candidate, field)),
    );
  });
}

/**
 * Whether two triggers are declaring the same start variable.
 *
 * The four properties a caller could observe a difference in. Labels and
 * descriptions are deliberately not compared: two triggers wording one field
 * differently still deliver the same value, and refusing it over the wording
 * would hide a variable that is genuinely there.
 */
function sameStartField(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return (
    asString(left.key) === asString(right.key) &&
    asString(left.valueType) === asString(right.valueType) &&
    isCollection(left) === isCollection(right) &&
    asString(left.semanticType) === asString(right.semanticType)
  );
}

type FlattenedField = {
  path: string;
  label: string;
  displayLabel: string;
  valueType: WorkflowVariableSuggestion["valueType"];
  semanticType?: string;
  itemSemanticType?: string;
};

function addFlattenedField(
  byPath: Map<string, WorkflowVariableSuggestion>,
  input: {
    field: Record<string, unknown>;
    pathPrefix: string;
    displayPathPrefix: string;
    sourceNodeId: string;
    sourceNodeLabel: string;
    sourceNodeDistance?: number;
    locale: string;
  },
): void {
  for (const flattened of flattenField(input.field, input.locale)) {
    const path = `${input.pathPrefix}.${flattened.path}`;
    if (byPath.has(path)) continue;
    byPath.set(path, {
      path,
      displayPath: `${input.displayPathPrefix}.${flattened.path}`,
      fieldPath: flattened.path,
      insertText: `{{${path}}}`,
      label: flattened.label,
      // Only when it says something the label does not; a nested field's
      // parents are the whole value of this and a top-level field has none.
      ...(flattened.displayLabel !== flattened.label
        ? { displayLabel: flattened.displayLabel }
        : {}),
      sourceNodeId: input.sourceNodeId,
      sourceNodeLabel: input.sourceNodeLabel,
      ...(input.sourceNodeDistance !== undefined
        ? { sourceNodeDistance: input.sourceNodeDistance }
        : {}),
      valueType: flattened.valueType,
      ...(flattened.semanticType ? { semanticType: flattened.semanticType } : {}),
      ...(flattened.itemSemanticType
        ? { itemSemanticType: flattened.itemSemanticType }
        : {}),
    });
  }
}

/**
 * One authored field as every path it offers.
 *
 * An object's children are reachable through it, and a collection's element is
 * reachable as `<key>[0]` — which `parseRuntimePath` splits into a numeric
 * segment, so `fields[0].key` and `fields.0.key` address the same thing. The
 * element is offered at index zero rather than at every index because a
 * document cannot say how many there will be; an author who wants another
 * writes the number.
 */
function flattenField(
  field: Record<string, unknown>,
  locale: string,
  prefix = "",
  labelPrefix = "",
  depth = 0,
): FlattenedField[] {
  const key = asString(field.key);
  if (!key || depth > MAX_FIELD_DEPTH) return [];

  const path = prefix ? `${prefix}.${key}` : key;
  const label = localized(field.label, locale) ?? key;
  const displayLabel = labelPrefix ? `${labelPrefix} > ${label}` : label;
  const collection = isCollection(field);
  const item = asRecord(field.item);
  const flattened: FlattenedField[] = [
    {
      path,
      label,
      displayLabel,
      valueType: collection ? "array" : valueTypeOf(field.valueType),
      ...(asString(field.semanticType) ? { semanticType: asString(field.semanticType)! } : {}),
      ...(asString(item.semanticType)
        ? { itemSemanticType: asString(item.semanticType)! }
        : {}),
    },
  ];

  if (collection) {
    const elementPath = `${path}[0]`;
    const elementLabel = `${label} item`;
    const element = Object.keys(item).length > 0 ? item : field;
    flattened.push({
      path: elementPath,
      label: elementLabel,
      displayLabel: labelPrefix ? `${labelPrefix} > ${elementLabel}` : elementLabel,
      valueType: valueTypeOf(element.valueType),
      ...(asString(element.semanticType)
        ? { semanticType: asString(element.semanticType)! }
        : {}),
    });
    for (const child of asArray(element.children)) {
      flattened.push(
        ...flattenField(asRecord(child), locale, elementPath, elementLabel, depth + 1),
      );
    }
    return flattened;
  }

  for (const child of asArray(field.children)) {
    flattened.push(...flattenField(asRecord(child), locale, path, displayLabel, depth + 1));
  }
  return flattened;
}

/**
 * `FieldDefinitionCardinality`, read the three ways it is authored: the word
 * `"collection"`, an unbounded `max`, or a `max` above one. Anything else,
 * including absent, is a single value.
 */
function isCollection(field: Record<string, unknown>): boolean {
  const cardinality = field.cardinality;
  if (cardinality === "collection") return true;
  if (!isRecord(cardinality)) return false;
  const max = (cardinality as Record<string, unknown>).max;
  if (max === "unbounded") return true;
  return typeof max === "number" && max > 1;
}

/** The authoring contract's value types, as the four a suggestion carries. */
function valueTypeOf(value: unknown): WorkflowVariableSuggestion["valueType"] {
  switch (asString(value)) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      // `date` and `datetime` included: both are carried as ISO strings by
      // every reader in this repo, and a picker that called them something
      // else would filter them out of a text field they belong in.
      return "string";
  }
}

/**
 * A locale map's text for a locale, then English, then any of them. The chain
 * `presentation.ts` uses on a catalog label, for the reason it gives: choosing
 * a locale belongs to whatever renders the text.
 */
function localized(value: unknown, locale: string): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isRecord(value)) return null;
  const map = value as Record<string, unknown>;
  return (
    asString(map[locale]) ??
    asString(map.en) ??
    Object.values(map).map(asString).find((entry): entry is string => entry !== null) ??
    null
  );
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? (value as Record<string, unknown>) : {};
}

/** Identical to the `asString` every other reader of a stored graph uses. */
function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
