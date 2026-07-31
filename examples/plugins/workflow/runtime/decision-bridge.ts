// SPDX-License-Identifier: BUSL-1.1
/**
 * The `decision` node: choose one outgoing handle from authored conditions.
 *
 * Branches are evaluated in the order they were authored and the first whose
 * `when` holds wins; its handle is returned and the process runtime follows the
 * edge wired to that handle. When no branch matches, the configured default
 * handle is returned instead, so a decision node always routes somewhere and
 * never ends a run by falling off the end of its own config.
 *
 * ## Why this is the only hand-written bridge that ships
 *
 * Every other executable node in the shipped catalog is generated from an
 * entity (see `generated-entity-bridges.ts`): its behaviour is a create,
 * update, delete or list against a table this deployment already owns. The
 * catalogued types that are neither — the ones that reach a model gateway, a
 * message transport or a billing service — need capabilities this deployment
 * does not have. Registering them anyway would only move a missing integration
 * from install time to the middle of somebody's run. Flow control needs nothing
 * but the config it was handed, so it is the one node type that can ship
 * unconditionally.
 *
 * ## Coupled to the validator
 *
 * `definition-validation.ts` derives the handles a decision node can emit from
 * this same config, and warns when an edge names a handle no branch produces
 * (ORPHAN_EDGE_HANDLE) or a branch produces a handle no edge wires
 * (ORPHAN_NODE_HANDLE). The two must resolve handles identically. If they
 * drift, a definition either validates clean and then dead-ends mid-run on a
 * handle with no edge, or is flagged for edges it genuinely needs. Anything
 * that changes `branchOutputHandle` or `defaultOutputHandle` below has to
 * change `declaredOutputHandles` there in the same edit.
 */
import {
  registerWorkflowNodeBridge,
  type WorkflowNodeBridgeHandler,
  type WorkflowNodeBridgeOutput,
} from "./node-bridge.js";

const DECISION_NODE_TYPE = "decision" as const;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * An operand's value, whichever kind it is.
 *
 * Operands are `{ kind: "literal" | "path" }`, and both are read the same way:
 * the process runtime substitutes `{{ ... }}` placeholders and writes a `path`
 * operand's looked-up value onto `value` before any bridge is called, so by the
 * time a condition is evaluated a path has already collapsed into a literal.
 * A path the runtime could not resolve arrives with no `value` at all, which
 * the comparisons below read as empty rather than raising — an author's typo
 * costs a branch, not the run.
 */
function operandValue(operand: unknown): unknown {
  return asRecord(operand).value;
}

/**
 * Comparison is stringified, so an authored `"5"` matches a numeric `5` pulled
 * from context. It also makes null, undefined and the empty string mutually
 * equal, which is why emptiness has its own operators rather than being
 * expressed as `equals ""`.
 */
function valuesEqual(left: unknown, right: unknown): boolean {
  return String(left ?? "") === String(right ?? "");
}

function evaluateRule(rule: JsonRecord): boolean {
  const left = operandValue(rule.left);
  const right = operandValue(rule.right);
  switch (rule.operator) {
    case "equals":
      return valuesEqual(left, right);
    case "notEquals":
      return !valuesEqual(left, right);
    case "isEmpty":
      return isEmptyValue(left);
    case "isNotEmpty":
      return !isEmptyValue(left);
    case "contains":
      return String(left ?? "").includes(String(right ?? ""));
    case "notContains":
      return !String(left ?? "").includes(String(right ?? ""));
    case "startsWith":
      return String(left ?? "").startsWith(String(right ?? ""));
    case "endsWith":
      return String(left ?? "").endsWith(String(right ?? ""));
    default:
      return false;
  }
}

/**
 * Evaluate one authored condition — a leaf rule, or a group nesting others
 * through `all` (every child) or `any` (some child).
 *
 * Exported so the decision logic can be driven directly, without a database or
 * a running process, by anything that needs to check it.
 */
export function evaluateDecisionCondition(condition: unknown): boolean {
  const record = asRecord(condition);
  if (record.kind === "rule" || "operator" in record) return evaluateRule(record);

  const children = asArray(
    record.conditions ?? record.rules ?? record.all ?? record.any,
  );
  // A group with no children matches nothing rather than matching vacuously: an
  // empty condition is an unfinished one, and an unfinished condition must not
  // take a branch the author never described.
  if (children.length === 0) return false;

  return record.mode === "any" || Array.isArray(record.any)
    ? children.some(evaluateDecisionCondition)
    : children.every(evaluateDecisionCondition);
}

/** Keep identical to `declaredOutputHandles` in `definition-validation.ts`. */
function branchOutputHandle(branch: JsonRecord): string | null {
  return asString(branch.handle) ?? asString(branch.targetEdgeId) ?? asString(branch.id);
}

/** Keep identical to `declaredOutputHandles` in `definition-validation.ts`. */
function defaultOutputHandle(config: JsonRecord): string {
  return asString(config.defaultEdgeId) ?? "default";
}

/**
 * The routing decision itself, over an already-resolved node config. Split out
 * from the handler so it can be exercised with a plain object.
 */
export function selectDecisionOutcome(config: JsonRecord): WorkflowNodeBridgeOutput {
  for (const entry of asArray(config.branches)) {
    const branch = asRecord(entry);
    const outputHandle = branchOutputHandle(branch);
    // A branch naming no handle at all is one the validator declares nothing
    // for either, so skipping it is what keeps the two in agreement.
    if (!outputHandle) continue;
    if (!evaluateDecisionCondition(branch.when)) continue;
    return {
      outputHandle,
      payload: {
        selectedBranchId: asString(branch.id) ?? outputHandle,
        selectedOutputHandle: outputHandle,
        selectedBranchLabel: asString(branch.label) ?? asString(branch.id) ?? outputHandle,
      },
    };
  }

  const fallback = defaultOutputHandle(config);
  return {
    outputHandle: fallback,
    payload: {
      selectedBranchId: fallback,
      selectedOutputHandle: fallback,
      selectedBranchLabel: "Default",
    },
  };
}

const decisionHandler: WorkflowNodeBridgeHandler = async (context) =>
  selectDecisionOutcome(context.resolvedConfig);

export function registerDecisionNodeBridge(): void {
  registerWorkflowNodeBridge(DECISION_NODE_TYPE, decisionHandler);
}
