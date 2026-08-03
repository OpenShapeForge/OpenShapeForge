// SPDX-License-Identifier: BUSL-1.1
/**
 * Which node types a palette may offer, without a database.
 *
 * The rule has to agree with the process runtime's dispatch order, and the two
 * disagree in a way no type checker catches: the runtime executes `end*` and
 * `trigger*` nodes itself, with no bridge, so an availability check written
 * against the bridge registry alone reports the entry and exit of every
 * workflow as unavailable. That case is pinned first because it is the one a
 * plausible implementation gets wrong.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/runtime/__tests__/node-executability.unit.test.ts 2>&1
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetWorkflowNodeBridgesForTests,
  registerWorkflowNodeBridge,
} from "../node-bridge.js";
import {
  getWorkflowNodeRuntimeSupport,
  WORKFLOW_NODE_RUNTIME_SUPPORT_ENUM_VALUES,
  type WorkflowNodeRuntimeSupport,
} from "../node-executability.js";

/** A handler is never called here; only its presence in the registry matters. */
const NEVER_RUNS = async () => ({ outputHandle: "completed", payload: {} });

afterEach(() => {
  __resetWorkflowNodeBridgesForTests();
});

describe("getWorkflowNodeRuntimeSupport", () => {
  test("entry and exit nodes are executable with an empty bridge registry", () => {
    // No bridge is registered in this test at all. Were availability sourced
    // from `listRegisteredWorkflowNodeBridges()`, every one of these would come
    // back unimplemented and the palette would offer no way to begin or end a
    // workflow.
    for (const nodeType of [
      "end",
      "start",
      "triggerManual",
      "triggerSchedule",
      "triggerWebhook",
      "triggerEvent",
      "triggerEntity",
    ]) {
      expect(getWorkflowNodeRuntimeSupport(nodeType)).toBe("executable");
    }
  });

  test("a catalogued node type with no bridge is unimplemented", () => {
    // The bridge backlog: in the catalog, validates clean, fails on the first
    // run with NO_BRIDGE. A host repo closes this by registering a bridge.
    for (const nodeType of [
      "condition",
      "flow.userInput",
      "subWorkflow",
      "action",
      "workflow.startDefinition",
    ]) {
      expect(getWorkflowNodeRuntimeSupport(nodeType)).toBe("unimplemented");
    }
  });

  test("registering a bridge flips a node type to executable", () => {
    expect(getWorkflowNodeRuntimeSupport("message.reply")).toBe("unimplemented");
    registerWorkflowNodeBridge("message.reply", NEVER_RUNS);
    // A domain node, so this also pins that availability does not consult the
    // catalog slice: a host repo that implements one gets it in the palette.
    expect(getWorkflowNodeRuntimeSupport("message.reply")).toBe("executable");
  });

  test("fan-out stays unsupported even when a bridge is registered", () => {
    // `join` and `split` are not the bridge backlog. The runtime holds a single
    // cursor and raises AMBIGUOUS_EDGES_FOR_HANDLE on fan-out, so a bridge does
    // not make them runnable and must not make them look runnable.
    for (const nodeType of ["join", "split"]) {
      expect(getWorkflowNodeRuntimeSupport(nodeType)).toBe("unsupported");
      registerWorkflowNodeBridge(nodeType, NEVER_RUNS);
      expect(getWorkflowNodeRuntimeSupport(nodeType)).toBe("unsupported");
    }
  });

  test("an unknown node type is unimplemented rather than throwing", () => {
    // The catalog decides what exists; this decides what runs. A type absent
    // from both still has to produce an answer, because callers map over rows
    // rather than guarding each one.
    expect(getWorkflowNodeRuntimeSupport("nothing.like.this")).toBe("unimplemented");
  });
});

describe("WORKFLOW_NODE_RUNTIME_SUPPORT_ENUM_VALUES", () => {
  test("maps every GraphQL member onto the value the runtime returns", () => {
    // The mapped type makes a missing member a compile error; this catches the
    // other direction, a member wired to the wrong internal value, which
    // typechecks and would serialize the wrong state to the palette.
    expect(WORKFLOW_NODE_RUNTIME_SUPPORT_ENUM_VALUES).toEqual({
      EXECUTABLE: "executable",
      UNIMPLEMENTED: "unimplemented",
      UNSUPPORTED: "unsupported",
    });

    const returned: WorkflowNodeRuntimeSupport[] = [
      getWorkflowNodeRuntimeSupport("end"),
      getWorkflowNodeRuntimeSupport("condition"),
      getWorkflowNodeRuntimeSupport("join"),
    ];
    expect(new Set(returned)).toEqual(
      new Set(Object.values(WORKFLOW_NODE_RUNTIME_SUPPORT_ENUM_VALUES)),
    );
  });
});
