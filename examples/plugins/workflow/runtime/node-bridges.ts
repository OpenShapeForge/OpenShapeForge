// SPDX-License-Identifier: BUSL-1.1
/**
 * Which node types this deployment can actually execute.
 *
 * The node catalog is compiled from YAML and describes 44 node types. This
 * registers bridges for the ones whose behaviour is generic — flow control and
 * entity CRUD — and deliberately not for the rest. A messaging node, an
 * LLM-backed node or a billing node describes a capability nothing here
 * provides; registering a stub for it would be worse than registering nothing,
 * because a workflow would then run and quietly do nothing rather than failing
 * where the gap is.
 *
 * A node type with no bridge fails at execution with NO_BRIDGE, naming the
 * type. That is the honest answer, and it is why the designer palette should
 * filter on what is registered rather than on what the catalog contains — see
 * the plugin's own note on the domain node packs.
 *
 * Registration is one-shot and idempotent: the registry refuses a duplicate,
 * and the module contract's `init` may run more than once across a test suite.
 */
import { registerDecisionNodeBridge } from "./decision-bridge.js";
import { registerGeneratedEntityNodeBridges } from "./generated-entity-bridges.js";
import { registerTimerNodeBridge } from "./timer-bridge.js";

let registered = false;

export function registerAllWorkflowNodeBridges(): void {
  if (registered) return;
  registered = true;

  // Flow control: the two hand-written bridges that are not entity CRUD.
  registerDecisionNodeBridge();
  // `timer` is the only one that parks a run rather than answering in the same
  // transaction; its deadline is swept by the worker role, not by this file.
  registerTimerNodeBridge();

  // One bridge per generated `entity.<module>.<entity>.<action>` node type,
  // driven by the compiler's manifest rather than by per-entity code.
  registerGeneratedEntityNodeBridges();
}

/** Test hook: forget that registration happened, so a suite can re-register. */
export function __resetWorkflowNodeBridgeRegistrationForTests(): void {
  registered = false;
}
