// SPDX-License-Identifier: BUSL-1.1
/**
 * Declaring a definition's process variables, and seeding them.
 *
 * Two properties carry most of this file, and both are about what a save
 * writes rather than about what a screen shows:
 *
 * 1. **An operation that changes nothing returns the value it was given.**
 *    `graph-history.ts` treats reference inequality as "something happened", so
 *    a no-op that allocated would cost an undo entry and mark a draft dirty.
 * 2. **An operation that changes one entry spreads the stored one.** A
 *    declaration carries `semanticType`, `hints` and `authoring` that this
 *    editor does not model and `runtime/field-definitions.ts` does read.
 *
 * The engine's own rules are the third theme: the declared set is closed, order
 * is seeding order, and a key is a runtime path segment. Each is asserted
 * against what `initializeProcessVariables` in `runtime/command-runtime.ts`
 * actually does.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/editor/__tests__/process-variables.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import {
  addProcessVariable,
  checkProcessVariableKey,
  describeProcessVariables,
  EMPTY_PROCESS_VARIABLE_SET,
  moveProcessVariable,
  processVariableKeys,
  readProcessVariableSet,
  removeProcessVariable,
  setProcessVariableField,
  setProcessVariableStartValue,
  type ProcessVariableSet,
} from "../process-variables.js";

function set(
  fields: unknown[],
  initializers: unknown[] = [],
): ProcessVariableSet {
  return { fields, initializers };
}

describe("reading a stored document", () => {
  test("both lists come back by reference, so handing them back writes nothing", () => {
    const fields = [{ key: "total" }];
    const initializers = [{ targetKey: "total", value: 0 }];
    const result = readProcessVariableSet({ processVariables: fields, processVariableInitializers: initializers });
    expect(result.fields).toBe(fields);
    expect(result.initializers).toBe(initializers);
  });

  test("a document with neither key yields one shared value", () => {
    // Shared rather than fresh, so a read that happens twice compares equal to
    // itself — which is what `toStoredGraph` decides on.
    expect(readProcessVariableSet({ nodes: [], edges: [] })).toBe(EMPTY_PROCESS_VARIABLE_SET);
    expect(readProcessVariableSet(null)).toBe(EMPTY_PROCESS_VARIABLE_SET);
  });

  test("a value of the wrong type reads as empty rather than throwing", () => {
    const result = readProcessVariableSet({ processVariables: "nonsense" });
    expect(result.fields).toEqual([]);
    // A malformed row still has to be openable, so its owner can fix it.
    expect(result.initializers).toEqual([]);
  });

  test("keys skip what the engine skips", () => {
    // `normalizeProcessFields` drops an entry with no usable key, so a screen
    // that counted them would disagree with what a run declares.
    expect(
      processVariableKeys(set([{ key: " total " }, { key: "" }, null, "nope", { valueType: "string" }])),
    ).toEqual(["total"]);
  });
});

describe("a key is a runtime path segment", () => {
  test("blank is refused", () => {
    expect(checkProcessVariableKey({ key: "  " })).toEqual({ ok: false, refusal: "EMPTY" });
  });

  test("a dot is refused, because `field-definitions.ts` refuses one outright", () => {
    expect(checkProcessVariableKey({ key: "a.b" })).toEqual({ ok: false, refusal: "ILLEGAL" });
  });

  test("brackets and braces are refused, because `parseRuntimePath` splits on them", () => {
    expect(checkProcessVariableKey({ key: "a[0]" }).ok).toBe(false);
    expect(checkProcessVariableKey({ key: "{{a}}" }).ok).toBe(false);
    expect(checkProcessVariableKey({ key: "a b" }).ok).toBe(false);
  });

  test("letters, digits, underscore and dash are allowed", () => {
    expect(checkProcessVariableKey({ key: "relation-id_2" })).toEqual({
      ok: true,
      key: "relation-id_2",
    });
  });

  test("a key that only differs by surrounding space is a duplicate", () => {
    // The engine trims, so these are one variable to a run.
    expect(checkProcessVariableKey({ key: " total ", taken: ["total"] })).toEqual({
      ok: false,
      refusal: "DUPLICATE",
    });
  });
});

describe("adding", () => {
  test("a declaration is appended, so it can read every earlier one", () => {
    // Order is seeding order: `initializeProcessVariables` walks the list
    // against a bag it is filling, so a later default may read an earlier
    // variable. Inserting anywhere else would change what a run starts with.
    const result = addProcessVariable(set([{ key: "a" }]), { key: "b" });
    expect(processVariableKeys(result.set)).toEqual(["a", "b"]);
  });

  test("a blank label is left absent rather than written as an empty map", () => {
    const result = addProcessVariable(EMPTY_PROCESS_VARIABLE_SET, { key: "total", label: "  " });
    expect(result.set.fields).toEqual([{ key: "total", valueType: "string" }]);
  });

  test("a label is written as a locale map, which is what a field is", () => {
    const result = addProcessVariable(EMPTY_PROCESS_VARIABLE_SET, {
      key: "total",
      valueType: "number",
      label: "Total",
      locale: "nl",
    });
    expect(result.set.fields).toEqual([
      { key: "total", valueType: "number", label: { nl: "Total" } },
    ]);
  });

  test("a refused key changes nothing and says why", () => {
    const before = set([{ key: "total" }]);
    const result = addProcessVariable(before, { key: "total" });
    expect(result.refused).toBe("DUPLICATE");
    expect(result.set).toBe(before);
  });
});

describe("editing one declaration", () => {
  const stored = {
    key: "total",
    valueType: "number",
    semanticType: "amount",
    hints: { sourceHint: "x" },
    label: { nl: "Totaal", en: "Total" },
  };

  test("the stored entry is spread, so keys this editor does not model survive", () => {
    const result = setProcessVariableField(set([stored]), {
      key: "total",
      property: "label",
      value: "Grand total",
    });
    expect(result.fields[0]).toEqual({
      ...stored,
      label: { nl: "Totaal", en: "Grand total" },
    });
  });

  test("editing one locale leaves the others alone", () => {
    const result = setProcessVariableField(set([stored]), {
      key: "total",
      property: "label",
      value: "Somme",
      locale: "fr",
    });
    expect((result.fields[0] as { label: unknown }).label).toEqual({
      nl: "Totaal",
      en: "Total",
      fr: "Somme",
    });
  });

  test("clearing the last locale removes the map rather than leaving an empty one", () => {
    const one = set([{ key: "total", label: { en: "Total" } }]);
    const result = setProcessVariableField(one, { key: "total", property: "label", value: "" });
    expect(result.fields[0]).toEqual({ key: "total" });
  });

  test("assigning the value it already holds returns the set it was given", () => {
    const before = set([stored]);
    expect(
      setProcessVariableField(before, { key: "total", property: "label", value: "Total" }),
    ).toBe(before);
    expect(
      setProcessVariableField(before, { key: "total", property: "valueType", value: "number" }),
    ).toBe(before);
  });

  test("a valueType outside the field contract falls back to string", () => {
    // The declaration doubles as a field definition, so a type nothing can
    // render is a field the inspector cannot draw.
    const before = set([{ key: "a", valueType: "string" }]);
    const result = setProcessVariableField(before, {
      key: "a",
      property: "valueType",
      value: "wormhole",
    });
    // …and since that is the value it already held, nothing was an edit.
    expect(result).toBe(before);
  });

  test("a key the set does not declare changes nothing", () => {
    const before = set([stored]);
    expect(setProcessVariableField(before, { key: "nope", property: "label", value: "x" })).toBe(
      before,
    );
  });
});

describe("start values", () => {
  test("a value is stored as an initializer targeting the declaration", () => {
    const result = setProcessVariableStartValue(set([{ key: "total" }]), {
      key: "total",
      value: "{{input.amount}}",
    });
    expect(result.initializers).toEqual([{ targetKey: "total", value: "{{input.amount}}" }]);
  });

  test("a placeholder is stored verbatim, because the engine resolves it", () => {
    // `initializeProcessVariables` runs an initializer through the same
    // placeholder resolution the runtime uses, so escaping it here would store
    // a literal nobody can undo.
    const result = setProcessVariableStartValue(set([{ key: "a" }]), {
      key: "a",
      value: "{{process.b}} and {{input.c}}",
    });
    expect((result.initializers[0] as { value: string }).value).toBe(
      "{{process.b}} and {{input.c}}",
    );
  });

  test("blank removes the initializer rather than storing an empty string", () => {
    // Two different runs: no initializer leaves the declaration's own
    // `value ?? defaultValue` standing, an empty one overwrites it with "".
    const before = set([{ key: "a" }], [{ targetKey: "a", value: "x" }]);
    expect(setProcessVariableStartValue(before, { key: "a", value: "" }).initializers).toEqual([]);
  });

  test("an existing initializer is spread rather than rebuilt", () => {
    const before = set([{ key: "a" }], [{ targetKey: "a", value: "x", note: "keep me" }]);
    const result = setProcessVariableStartValue(before, { key: "a", value: "y" });
    expect(result.initializers).toEqual([{ targetKey: "a", value: "y", note: "keep me" }]);
  });

  test("an initializer that is not text is left alone", () => {
    // Flattening `0` into a text box would rewrite it on the first keystroke
    // and on every save after that.
    const before = set([{ key: "a" }], [{ targetKey: "a", value: 0 }]);
    expect(setProcessVariableStartValue(before, { key: "a", value: "1" })).toBe(before);
  });

  test("nothing is written for a key the definition does not declare", () => {
    // The engine drops those, so writing one puts a line in the document that
    // can never do anything.
    const before = set([{ key: "a" }]);
    expect(setProcessVariableStartValue(before, { key: "b", value: "x" })).toBe(before);
  });

  test("setting the value it already has returns the set it was given", () => {
    const before = set([{ key: "a" }], [{ targetKey: "a", value: "x" }]);
    expect(setProcessVariableStartValue(before, { key: "a", value: "x" })).toBe(before);
  });
});

describe("removing", () => {
  test("the initializer goes with the declaration", () => {
    const result = removeProcessVariable(
      set([{ key: "a" }, { key: "b" }], [{ targetKey: "a", value: 1 }, { targetKey: "b", value: 2 }]),
      "a",
    );
    expect(processVariableKeys(result)).toEqual(["b"]);
    expect(result.initializers).toEqual([{ targetKey: "b", value: 2 }]);
  });

  test("removing a key the set does not declare returns the set it was given", () => {
    const before = set([{ key: "a" }]);
    expect(removeProcessVariable(before, "b")).toBe(before);
  });
});

describe("ordering", () => {
  test("moving a declaration changes seeding order, which is a real edit", () => {
    const result = moveProcessVariable(set([{ key: "a" }, { key: "b" }, { key: "c" }]), {
      key: "c",
      direction: "up",
    });
    expect(processVariableKeys(result)).toEqual(["a", "c", "b"]);
  });

  test("an unusable entry keeps its slot, and the declarations move past it", () => {
    // It is not a row anybody can see, so swapping with it would look like
    // nothing happened.
    const result = moveProcessVariable(set([{ key: "a" }, "junk", { key: "b" }]), {
      key: "b",
      direction: "up",
    });
    expect(result.fields).toEqual([{ key: "b" }, "junk", { key: "a" }]);
  });

  test("at either end nothing happens, so the button costs no undo entry", () => {
    const before = set([{ key: "a" }, { key: "b" }]);
    expect(moveProcessVariable(before, { key: "a", direction: "up" })).toBe(before);
    expect(moveProcessVariable(before, { key: "b", direction: "down" })).toBe(before);
    expect(moveProcessVariable(before, { key: "nope", direction: "up" })).toBe(before);
  });
});

describe("what a screen shows", () => {
  test("entries the engine skips are left out of the view and not out of the document", () => {
    const source = set([{ key: "a" }, "junk", { key: "b" }]);
    expect(describeProcessVariables(source).map((view) => view.key)).toEqual(["a", "b"]);
    expect(source.fields).toHaveLength(3);
  });

  test("a duplicate key is one row, because a run has one variable", () => {
    // Seeding walks the list in order and the last write to a key wins, so two
    // rows would edit one value.
    expect(
      describeProcessVariables(set([{ key: "a", label: { en: "First" } }, { key: "a" }])).map(
        (view) => view.label,
      ),
    ).toEqual(["First"]);
  });

  test("a label falls back through the requested locale, English, then any", () => {
    const views = describeProcessVariables(
      set([
        { key: "a", label: { nl: "Totaal", en: "Total" } },
        { key: "b", label: { de: "Kanal" } },
        { key: "c" },
      ]),
      { locale: "fr" },
    );
    expect(views.map((view) => view.label)).toEqual(["Total", "Kanal", "c"]);
  });

  test("a non-text initializer is reported as opaque rather than as an empty box", () => {
    const views = describeProcessVariables(
      set([{ key: "a" }, { key: "b" }], [{ targetKey: "a", value: { nested: true } }]),
    );
    expect(views[0]).toMatchObject({ startValue: "", startValueIsOpaque: true });
    expect(views[1]).toMatchObject({ startValue: "", startValueIsOpaque: false });
  });

  test("the last initializer for a key wins, as the engine assigns in order", () => {
    const views = describeProcessVariables(
      set([{ key: "a" }], [{ targetKey: "a", value: "first" }, { targetKey: "a", value: "second" }]),
    );
    expect(views[0]?.startValue).toBe("second");
  });
});
