// SPDX-License-Identifier: BUSL-1.1
/**
 * Workflow node runtime bridge — a tiny in-process registry that maps a
 * compiler-defined workflow nodeType ("ai.extractParameters", "billing.runProlongation",
 * ...) to the function that actually executes it inside the API process.
 *
 * Why this exists: the compiler-owned node catalog only validates that a
 * workflow definition references a known node type — it cannot run those
 * nodes. The process runtime calls into this registry whenever an
 * instance reaches such a node so the side-effecting service code lives where
 * it belongs (e.g. apps/api/src/modules/billing for billing.runProlongation).
 *
 * Usage from a feature module:
 *   import { registerWorkflowNodeBridge } from "../../workflow/node-bridge.js";
 *   registerWorkflowNodeBridge("billing.runProlongation", async (ctx, config) => { ... });
 *
 * Usage from the workflow runtime:
 *   const handler = getWorkflowNodeBridge(node.type);
 *   if (handler) {
 *     const result = await handler({ db, tenantId, instanceId, nodeId, ... }, node.config);
 *   }
 */
import type { OpenShapeForgeDatabase } from "../../../../apps/api/src/db/connection.js";

export type WorkflowNodeBridgeContext<
  ResolvedConfig extends Record<string, unknown> = Record<string, unknown>,
> = {
  db: OpenShapeForgeDatabase;
  tenantId: string;
  instanceId: string;
  nodeId: string;
  workflowDefinitionId: string;
  triggeredBy?: string;
  /** Original node config before template resolution; used for contracts that need source paths. */
  rawConfig?: Record<string, unknown>;
  /** Variables resolved from the workflow context, keyed by configField. */
  resolvedConfig: ResolvedConfig;
  /** Runtime AI execution policy. `deterministic` is test-only and must not call live LLM providers. */
  /** Declared process-variable field definitions for this workflow definition. */
  processVariableFields?: Record<string, unknown>[];
  /** Root case process-variable owner when this process is running inside a case. */
  processVariableScope?: {
    instanceId: string;
    declaredKeys: string[];
  } | null;
};

/**
 * Each node executor returns either a successful payload + chosen output handle,
 * or throws. Throwing routes the workflow to its `failed` handle. Callers can
 * also return `{ outputHandle: "configError", payload }` for typed error routing.
 */
export type WorkflowNodeBridgeOutput = {
  /** Compiler-defined output handle name (e.g. "completed", "partial", "noWork"). */
  outputHandle: string;
  /** JSON-serialisable payload exposed to downstream nodes via the workflow context. */
  payload: Record<string, unknown>;
  /**
   * Optional patch into the parent workflow's process variables. Keys are
   * process paths relative to `process`, e.g. `address` or `address.postcode`.
   */
  processVariablePatch?: Record<string, unknown>;
  /**
   * When set, the process runtime leaves the node_state running and keeps the
   * instance open. A later resume command can rerun the deterministic prefix of
   * the process; idempotent bridges will return their previous result, and the
   * waiting bridge can then emit its normal output handle.
   */
  wait?: {
    waitToken: string;
    waitKind: string;
  };
};

export type WorkflowNodeBridgeHandler<
  ResolvedConfig extends Record<string, unknown> = Record<string, unknown>,
> = (
  context: WorkflowNodeBridgeContext<ResolvedConfig>,
) => Promise<WorkflowNodeBridgeOutput>;

const REGISTRY = new Map<string, WorkflowNodeBridgeHandler>();

export function registerWorkflowNodeBridge(
  nodeType: string,
  handler: WorkflowNodeBridgeHandler,
): void {
  if (REGISTRY.has(nodeType)) {
    throw new Error(
      `Workflow node bridge for "${nodeType}" is already registered.`,
    );
  }
  REGISTRY.set(nodeType, handler);
}

export function getWorkflowNodeBridge(
  nodeType: string,
): WorkflowNodeBridgeHandler | null {
  return REGISTRY.get(nodeType) ?? null;
}

export function listRegisteredWorkflowNodeBridges(): string[] {
  return Array.from(REGISTRY.keys()).sort();
}

/** Test-only — clears the registry between test cases. */
export function __resetWorkflowNodeBridgesForTests(): void {
  REGISTRY.clear();
}
