// SPDX-License-Identifier: BUSL-1.1
/**
 * What the palette may offer.
 *
 * Two of these are worth more than the rest. The agreement test pins the
 * palette's gate against `getWorkflowNodeRuntimeSupport` itself, so the
 * question "which node types are refused outright" has one answer rather than
 * two that can drift. The category-folding test pins the lesson that a free-text
 * field with two spellings produced two buckets for one category — which is
 * already in the shipped catalogs, not a hypothetical. The set is still open
 * after #260, so the fold is still what stops it recurring.
 *
 * The heading tests pin the other half of #260: it is authored text now, in a
 * locale map, so it follows the reader — and it must not depend on which
 * catalog row arrived first, because the catalog is read unordered.
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
    category: { en: "Flow", nl: "Stroom" },
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
    // Both spellings shipped once: `flow` in the standard pack, `Flow` in a
    // domain pack. Grouping on the raw string splits one category in two, and
    // the set is still open after #260 — a host repo's pack can spell it either
    // way — so the fold is what keeps this from recurring.
    const groups = buildWorkflowPalette({
      nodeTypes: [
        entry("a", { category: { en: "flow" } }),
        entry("b", { category: { en: "Flow" } }),
        entry("c", { category: { en: " FLOW " } }),
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("flow");
    expect(groups[0]?.items.map((item) => item.type)).toEqual(["a", "b", "c"]);
  });

  test("the group heading does not depend on which spelling arrived first", () => {
    // Catalog row order is not something a palette should be able to see: the
    // rows are selected with no `order by`. Resolved by node type, which is the
    // table's primary key.
    const forward = buildWorkflowPalette({
      nodeTypes: [entry("a", { category: { en: "FLOW" } }), entry("b", { category: { en: "flow" } })],
    });
    const reversed = buildWorkflowPalette({
      nodeTypes: [entry("b", { category: { en: "flow" } }), entry("a", { category: { en: "FLOW" } })],
    });
    expect(forward[0]?.label).toBe("FLOW");
    expect(reversed[0]?.label).toBe(forward[0]?.label);
  });

  test("the heading is the category in the reader's locale", () => {
    // The whole point of #260. The group headings were the only text on this
    // screen that could not follow the reader, because `category` was one bare
    // word with no key to put a translation under.
    const [group] = buildWorkflowPalette({
      locale: "nl",
      nodeTypes: [entry("a", { category: { en: "Billing", nl: "Facturatie" } })],
    });
    expect(group?.key).toBe("billing");
    expect(group?.label).toBe("Facturatie");
  });

  test("two packs naming one category contribute their locales to one heading", () => {
    // The standard pack can carry `en` alone where a domain pack carries both.
    // Picking one row's map whole would hand a Dutch reader the English word
    // depending on which row the catalog returned first.
    const [group] = buildWorkflowPalette({
      locale: "nl",
      nodeTypes: [
        entry("standard", { category: { en: "Flow" } }),
        entry("domain", { category: { en: "Flow", nl: "Stroom" } }),
      ],
    });
    expect(group?.key).toBe("flow");
    expect(group?.label).toBe("Stroom");
  });

  test("an acronym is authored, not reconstructed", () => {
    // This used to need a hand-kept override map: folding is not reversible, so
    // `ai` capitalised is `Ai`, which reads as a typo. The catalog serves the
    // display form now, so the map is gone and the heading is what somebody
    // wrote.
    const groups = buildWorkflowPalette({
      nodeTypes: [entry("a", { category: { en: "AI" } }), entry("b", { category: { en: "ai" } })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("ai");
    expect(groups[0]?.label).toBe("AI");
  });

  test("a category with no English spelling still groups, by one locale", () => {
    // The identity has to come from somewhere, and every map in this repository
    // carries `en`. A pack that omits it groups consistently — by the
    // alphabetically first locale — rather than collapsing into `other`.
    const groups = buildWorkflowPalette({
      locale: "nl",
      nodeTypes: [
        entry("a", { category: { nl: "Berichten" } }),
        entry("b", { category: { nl: "berichten" } }),
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("berichten");
    expect(groups[0]?.label).toBe("Berichten");
  });

  test("triggers come first, everything else alphabetically", () => {
    // A workflow cannot start without one, so the group that holds them is the
    // one a reader needs first.
    const groups = buildWorkflowPalette({
      nodeTypes: [
        entry("z", { category: { en: "Integrations", nl: "Integraties" } }),
        entry("y", { category: { en: "Flow", nl: "Stroom" } }),
        entry("x", { category: { en: "Triggers", nl: "Triggers" } }),
      ],
    });
    expect(groups.map((group) => group.key)).toEqual(["triggers", "flow", "integrations"]);
  });

  test("the alphabet is the reader's, not English's", () => {
    // A consequence of headings being localized, and the intended one: the list
    // is sorted by what is on screen. `Stroom` sorts after `Integraties` in
    // Dutch where `Flow` sorts before `Integrations` in English. Only the hoist
    // is locale-independent, because it is matched on the key.
    const groups = buildWorkflowPalette({
      locale: "nl",
      nodeTypes: [
        entry("z", { category: { en: "Integrations", nl: "Integraties" } }),
        entry("y", { category: { en: "Flow", nl: "Stroom" } }),
        entry("x", { category: { en: "Triggers", nl: "Triggers" } }),
      ],
    });
    expect(groups.map((group) => group.key)).toEqual(["triggers", "integrations", "flow"]);
    expect(groups.map((group) => group.label)).toEqual(["Triggers", "Integraties", "Stroom"]);
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
