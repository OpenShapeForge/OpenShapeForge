// SPDX-License-Identifier: BUSL-1.1
/**
 * What a settings sheet sends, and what it must not.
 *
 * The cost of getting this wrong is not cosmetic. `updateWorkflowDefinition`
 * stamps `updated_at` on every write, and that column is `expectedUpdatedAt` —
 * the optimistic-concurrency token the open editor is holding. A settings write
 * therefore invalidates that editor's next save, so sending a field that did
 * not change buys the author a stale-save error for nothing at all. The server
 * refuses an update naming no field outright.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/definitions/__tests__/definition-settings.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { WORKFLOW_DEFINITION_CATEGORIES } from "../../../runtime/definition-types.js";
import {
  diffWorkflowDefinitionSettings,
  readWorkflowDefinitionSettings,
  WORKFLOW_DEFINITION_CATEGORY_OPTIONS,
  type WorkflowDefinitionSettings,
} from "../definition-settings.js";

const CURRENT: WorkflowDefinitionSettings = {
  name: "Onboarding",
  description: "Takes a new hire through day one.",
  category: "process",
};

function diff(next: Partial<{ name: string; description: string | null; category: string }>) {
  return diffWorkflowDefinitionSettings({
    current: CURRENT,
    next: {
      name: next.name ?? CURRENT.name,
      description: next.description === undefined ? CURRENT.description : next.description,
      category: next.category ?? CURRENT.category,
    },
  });
}

describe("the category list", () => {
  test("offers exactly the categories the runtime declares", () => {
    // Two lists, because this one is bundled for the browser and the runtime's
    // is compiled with NodeNext and reached by the API. Pinned here so that a
    // category added there fails rather than silently going unofferable.
    expect(WORKFLOW_DEFINITION_CATEGORY_OPTIONS.map((option) => option.value)).toEqual([
      ...WORKFLOW_DEFINITION_CATEGORIES,
    ]);
  });
});

describe("reading a definition record", () => {
  test("a blank description is null, which is what the API stores", () => {
    expect(readWorkflowDefinitionSettings({ name: " Onboarding ", description: "   " })).toEqual({
      name: "Onboarding",
      description: null,
      category: "process",
    });
  });

  test("a category the schema does not have reads as the one anything runs", () => {
    expect(readWorkflowDefinitionSettings({ name: "x", category: "wormhole" }).category).toBe(
      "process",
    );
    expect(readWorkflowDefinitionSettings({ name: "x", category: "orchestrator" }).category).toBe(
      "orchestrator",
    );
  });
});

describe("the diff", () => {
  test("nothing changed is its own answer, not an empty input the server rejects", () => {
    expect(diff({})).toEqual({ ok: false, refusal: "UNCHANGED" });
  });

  test("whitespace-only changes are not changes", () => {
    expect(diff({ name: "  Onboarding  ", description: "Takes a new hire through day one." })).toEqual({
      ok: false,
      refusal: "UNCHANGED",
    });
  });

  test("only the fields that differ are sent", () => {
    const result = diff({ description: "Day one, end to end." });
    expect(result).toEqual({
      ok: true,
      change: { description: "Day one, end to end." },
      changed: ["description"],
    });
  });

  test("an unchanged name does not block a changed description", () => {
    // `checkWorkflowDefinitionName` reports `UNCHANGED` for a rename to the
    // name it already has; here that means "leave the name out", not "refuse".
    const result = diff({ category: "orchestrator" });
    expect(result).toEqual({
      ok: true,
      change: { category: "orchestrator" },
      changed: ["category"],
    });
  });

  test("a cleared description is sent as null rather than as an empty string", () => {
    expect(diff({ description: "   " })).toEqual({
      ok: true,
      change: { description: null },
      changed: ["description"],
    });
  });

  test("all three at once", () => {
    const result = diff({ name: "Onboarding v2", description: null, category: "orchestrator" });
    expect(result).toEqual({
      ok: true,
      change: { name: "Onboarding v2", description: null, category: "orchestrator" },
      changed: ["name", "description", "category"],
    });
  });

  test("a name the rules refuse stops the whole write", () => {
    expect(diff({ name: "   " })).toEqual({ ok: false, refusal: "EMPTY" });
    expect(diff({ name: "x".repeat(200) })).toEqual({ ok: false, refusal: "TOO_LONG" });
  });

  test("a name the rules refuse is not rescued by another field changing", () => {
    // The write is one mutation, so a refused name is not a partial send.
    expect(diff({ name: "", description: "something else" })).toEqual({
      ok: false,
      refusal: "EMPTY",
    });
  });

  test("a category the schema does not have is normalized rather than sent", () => {
    expect(diff({ category: "wormhole" })).toEqual({ ok: false, refusal: "UNCHANGED" });
  });
});
