// SPDX-License-Identifier: BUSL-1.1
/**
 * What the palette may offer.
 *
 * Two of these are worth more than the rest. The agreement test pins the
 * palette's gate against `getWorkflowNodeRuntimeSupport` itself, so the
 * question "which node types are refused outright" has one answer rather than
 * two that can drift. The category-folding test pins the lesson that a free-text
 * field with two spellings produced two buckets for one category — which is
 * already in the shipped catalogs, not a hypothetical.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/editor/__tests__/palette.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { getWorkflowNodeRuntimeSupport } from "../../../runtime/node-executability.js";
import {
  buildWorkflowPalette,
  type WorkflowPaletteNodeType,
} from "../palette.js";

function entry(
  type: string,
  overrides: Partial<WorkflowPaletteNodeType> = {},
): WorkflowPaletteNodeType {
  return {
    type,
    category: "flow",
    label: { en: type },
    runtimeSupport: "EXECUTABLE",
    ...overrides,
  };
}

function typesIn(groups: ReturnType<typeof buildWorkflowPalette>): string[] {
  return groups.flatMap((group) => group.items.map((item) => item.type));
}

describe("buildWorkflowPalette", () => {
  test("offers EXECUTABLE, disables UNIMPLEMENTED, hides UNSUPPORTED", () => {
    const groups = buildWorkflowPalette({
      nodeTypes: [
        entry("decision"),
        entry("action", { runtimeSupport: "UNIMPLEMENTED" }),
        entry("join", { runtimeSupport: "UNSUPPORTED" }),
      ],
    });

    const items = groups.flatMap((group) => group.items);
    expect(items.map((item) => item.type)).toEqual(["decision", "action"]);
    expect(items[0]?.unavailable).toBeNull();
    // Shown, not hidden: the type is real and a host repo can bridge it, so
    // omitting it would misdescribe the catalog.
    expect(items[1]?.unavailable).toBe("UNIMPLEMENTED");
  });

  test("the refusal agrees with the runtime's own answer", () => {
    // The palette's gate and the API's are the same question. Sourced from the
    // runtime rather than restated, so a change to either fails here.
    const catalogTypes = ["decision", "timer", "end", "triggerManual", "join", "split"];
    const nodeTypes = catalogTypes.map((type) =>
      entry(type, { runtimeSupport: getWorkflowNodeRuntimeSupport(type) }),
    );

    const offered = new Set(typesIn(buildWorkflowPalette({ nodeTypes })));
    for (const type of catalogTypes) {
      expect(offered.has(type)).toBe(getWorkflowNodeRuntimeSupport(type) !== "unsupported");
    }
    // Named explicitly, because these two are the whole reason the third state
    // exists: the engine holds a single cursor and cannot fan out.
    expect(offered.has("join")).toBe(false);
    expect(offered.has("split")).toBe(false);
  });

  test("accepts the runtime's lower-case union as well as the wire's enum", () => {
    // `getWorkflowNodeRuntimeSupport` returns "executable"; GraphQL serializes
    // "EXECUTABLE". A palette handed either must gate the same way.
    const groups = buildWorkflowPalette({
      nodeTypes: [entry("a", { runtimeSupport: "executable" }), entry("b", { runtimeSupport: "unsupported" })],
    });
    expect(typesIn(groups)).toEqual(["a"]);
  });

  test("a runtimeSupport value it has not been taught is refused, not offered", () => {
    // Fail closed. An unknown state is one nothing can promise a run for, and
    // an absent entry is a better failure than a node that dies on first run.
    const groups = buildWorkflowPalette({
      nodeTypes: [entry("mystery", { runtimeSupport: "PROBABLY" }), entry("known")],
    });
    expect(typesIn(groups)).toEqual(["known"]);
  });

  test("categories that differ only in case are one group", () => {
    // Both spellings ship today: `flow` in the standard pack, `Flow` in a
    // domain pack. Grouping on the raw string splits one category in two.
    const groups = buildWorkflowPalette({
      nodeTypes: [
        entry("a", { category: "flow" }),
        entry("b", { category: "Flow" }),
        entry("c", { category: " FLOW " }),
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("flow");
    expect(groups[0]?.items.map((item) => item.type)).toEqual(["a", "b", "c"]);
  });

  test("the group heading does not depend on which spelling arrived first", () => {
    // Catalog row order is not something a palette should be able to see.
    const forward = buildWorkflowPalette({
      nodeTypes: [entry("a", { category: "FLOW" }), entry("b", { category: "flow" })],
    });
    const reversed = buildWorkflowPalette({
      nodeTypes: [entry("b", { category: "flow" }), entry("a", { category: "FLOW" })],
    });
    expect(forward[0]?.label).toBe("Flow");
    expect(reversed[0]?.label).toBe(forward[0]?.label);
  });

  test("an acronym heading survives the fold", () => {
    // Folding is not reversible: `ai` capitalised is `Ai`, which reads as a
    // typo. Nothing in a lowercase string says which letters were capitals, so
    // the override map is the only place that knows — and it is a second
    // description of a category, which is why it goes away when the catalog
    // serves a display form (#260).
    const groups = buildWorkflowPalette({
      nodeTypes: [entry("a", { category: "ai" }), entry("b", { category: "AI" })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("ai");
    expect(groups[0]?.label).toBe("AI");
  });

  test("triggers come first, everything else alphabetically", () => {
    // A workflow cannot start without one, so the group that holds them is the
    // one a reader needs first.
    const groups = buildWorkflowPalette({
      nodeTypes: [
        entry("z", { category: "integrations" }),
        entry("y", { category: "flow" }),
        entry("x", { category: "triggers" }),
      ],
    });
    expect(groups.map((group) => group.key)).toEqual(["triggers", "flow", "integrations"]);
  });

  test("available items sort ahead of unavailable ones", () => {
    // A domain pack can leave a category holding more unbridged types than
    // bridged ones; a reader scanning for something to place should not have to
    // read past them.
    const groups = buildWorkflowPalette({
      nodeTypes: [
        entry("aaa", { runtimeSupport: "UNIMPLEMENTED", label: { en: "Aaa" } }),
        entry("zzz", { label: { en: "Zzz" } }),
      ],
    });
    expect(groups[0]?.items.map((item) => item.type)).toEqual(["zzz", "aaa"]);
  });

  test("labels follow the locale, then English, then anything", () => {
    const [group] = buildWorkflowPalette({
      locale: "nl",
      nodeTypes: [
        entry("a", { label: { nl: "Keuze", en: "Decision" } }),
        entry("b", { label: { en: "Timer" } }),
        entry("c", { label: { fr: "Fin" } }),
        entry("d", { label: null }),
      ],
    });
    const labels = new Map(group?.items.map((item) => [item.type, item.label]));
    expect(labels.get("a")).toBe("Keuze");
    expect(labels.get("b")).toBe("Timer");
    expect(labels.get("c")).toBe("Fin");
    // No label at all falls back to the type, which is what every server-side
    // finding names, so a reader can still connect the two.
    expect(labels.get("d")).toBe("d");
  });

  test("catalog is carried through as a label and gates nothing", () => {
    // Provenance and executability are different questions. Filtering on this
    // would hide a domain node from the deployment that implemented it.
    const groups = buildWorkflowPalette({
      nodeTypes: [entry("a", { catalog: "domain" }), entry("b", { catalog: "standard" })],
    });
    expect(typesIn(groups)).toEqual(["a", "b"]);
    expect(groups[0]?.items[0]?.catalog).toBe("domain");
  });

  test("a node type with no category is bucketed, not dropped", () => {
    const groups = buildWorkflowPalette({ nodeTypes: [entry("a", { category: null })] });
    expect(groups[0]?.key).toBe("other");
    expect(groups[0]?.items.map((item) => item.type)).toEqual(["a"]);
  });

  test("an entry with no type is skipped without throwing", () => {
    // `workflowNodeTypes` is typed non-null, but the palette also renders what
    // a cached or partial response handed it.
    const groups = buildWorkflowPalette({
      nodeTypes: [{ type: "" }, { type: "  " }, entry("real")],
    });
    expect(typesIn(groups)).toEqual(["real"]);
  });
});
