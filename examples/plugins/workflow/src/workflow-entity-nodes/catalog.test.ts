// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CoreEntity } from "../../../../../packages/compiler/src/authoring/types.js";
import { isWorkflowEntityListDiscoverable } from "./catalog.js";

const entity = (actions: readonly string[]): CoreEntity => ({
  schemaVersion: 3,
  kind: "coreEntity",
  module: "core",
  entity: "Widget",
  title: "Widget",
  language: "en",
  fields: [],
  operations: Object.fromEntries(actions.map((action) => [action, {
    name: action, description: action,
    implementation: { type: "entity", action },
    effects: { data: "read", external: "none" },
    reliability: { idempotency: { mode: "natural" } },
    confirmation: { mode: "none" },
  }])),
  interfaces: {},
} as CoreEntity);

describe("workflow entity discovery", () => {
  test("an entity without a list Operation is not advertised through list-query pickers", () => {
    expect(isWorkflowEntityListDiscoverable(entity(["get"]))).toBe(false);
    expect(isWorkflowEntityListDiscoverable(entity(["list", "get"]))).toBe(true);
  });
});
