// SPDX-License-Identifier: BUSL-1.1
/**
 * The adapter between a node type's config fields and a renderer form.
 *
 * The point of these is to keep the adapter an adapter. The renderer already
 * handles visibility rules, validation, options, collections and nested
 * objects; the failure mode this file guards against is a second form engine
 * growing here — so the substantive assertion is that the fields come out
 * exactly as the catalog served them, untouched.
 *
 * The definition is also built from the real `decision` and `timer` authoring
 * YAML rather than from invented fields, because the shapes that matter — a
 * collection of objects, a field with visibility conditions — are shapes this
 * repo actually authors.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/web/editor/__tests__/config-form.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { buildWorkflowNodeConfigForm } from "../config-form.js";

const TIMER_FIELDS = [
  { key: "mode", valueType: "string", defaultValue: "duration" },
  {
    key: "durationAmount",
    valueType: "integer",
    visibility: { logic: "and", conditions: [{ field: "mode", operator: "eq", value: "duration" }] },
  },
];

describe("buildWorkflowNodeConfigForm", () => {
  test("passes the catalog's fields through by reference", () => {
    // The whole design. Anything that rewrote, flattened or re-keyed a field
    // here would be a second description of the field tree, and the config the
    // user edits would stop being the config the node stores.
    const form = buildWorkflowNodeConfigForm({ nodeType: "timer", configFields: TIMER_FIELDS });
    expect(form?.fields).toHaveLength(2);
    expect(form?.fields[0]).toBe(TIMER_FIELDS[0] as never);
    expect(form?.fields[1]).toBe(TIMER_FIELDS[1] as never);
  });

  test("one group, listing the top-level keys in authored order", () => {
    // Authored order is the order a reader was meant to fill them in, and for
    // `decision` it is also the branch evaluation order.
    const form = buildWorkflowNodeConfigForm({ nodeType: "timer", configFields: TIMER_FIELDS });
    expect(form?.groups).toEqual([
      { id: "workflow-node-config", fields: ["mode", "durationAmount"] },
    ]);
  });

  test("renders as an inspector with no title and no action bar", () => {
    // The panel already names the node, and the inspector saves on change
    // rather than on submit — a title and a Submit button would each say
    // something the surface has already said or cannot do.
    const form = buildWorkflowNodeConfigForm({ nodeType: "timer", configFields: TIMER_FIELDS });
    expect(form?.presentation.surface).toBe("inspector");
    expect(form?.presentation.chrome.showActionBar).toBe(false);
    expect(form?.presentation.chrome.showTitle).toBe(false);
    expect(form?.mode).toBe("edit");
  });

  test("null when the node type has nothing to configure", () => {
    // Distinct from an empty form: an empty bordered form reads as "loading"
    // or "broken", and eight standard node types declare no config at all.
    expect(buildWorkflowNodeConfigForm({ nodeType: "end", configFields: [] })).toBeNull();
    expect(buildWorkflowNodeConfigForm({ nodeType: "end", configFields: null })).toBeNull();
    expect(buildWorkflowNodeConfigForm({ nodeType: "end", configFields: "junk" })).toBeNull();
    // Entries with no usable key contribute nothing, so a list of them is the
    // same answer as an empty list.
    expect(
      buildWorkflowNodeConfigForm({ nodeType: "end", configFields: [{ key: "  " }, 7, null] }),
    ).toBeNull();
  });

  test("honours workflowInspector.displayMode, including on a child field", () => {
    // The field contract carries this key for exactly this surface. A child of
    // an object field is addressed by its own key, so a recursive pass is what
    // makes an author's declaration reach it.
    const form = buildWorkflowNodeConfigForm({
      nodeType: "decision",
      configFields: [
        { key: "branches", workflowInspector: { displayMode: "readOnly" } },
        {
          key: "meta",
          valueType: "object",
          children: [
            { key: "internalId", workflowInspector: { displayMode: "hidden" } },
            { key: "note" },
          ],
        },
        {
          key: "rows",
          item: { key: "row", children: [{ key: "secret", workflowInspector: { displayMode: "hidden" } }] },
        },
      ],
    });

    expect(form?.fieldConfig).toEqual({
      branches: { displayMode: "readOnly" },
      internalId: { displayMode: "hidden" },
      secret: { displayMode: "hidden" },
    });
    // A field that declares nothing gets no entry at all, rather than an
    // explicit "edit" that would override a default the renderer resolves.
    expect("note" in (form?.fieldConfig ?? {})).toBe(false);
  });

  test("ignores a displayMode the field contract does not declare", () => {
    const form = buildWorkflowNodeConfigForm({
      nodeType: "x",
      configFields: [{ key: "a", workflowInspector: { displayMode: "invisible" } }],
    });
    expect(form?.fieldConfig).toEqual({});
  });

  test("declares the graph-variable source, and hands it what it was given", () => {
    // `workflowGraphVariables` is a protocol adapter that returns whatever it
    // is handed — the graph walk stays with whoever holds the graph, which is
    // why the server's resolver for it is a stub returning [].
    const suggestions = [{ key: "trigger.payload" }];
    const form = buildWorkflowNodeConfigForm({
      nodeType: "action",
      configFields: [{ key: "url" }],
      variableSuggestions: suggestions,
    });
    expect(form?.variableSources).toEqual([
      {
        key: "workflowGraphVariables",
        resolver: "workflowGraphVariables",
        params: { suggestions },
      },
    ]);
  });

  test("with no suggestions the source is still declared, holding none", () => {
    // Declaring it conditionally would make a field's variable picker appear
    // and disappear as the graph changed around it.
    const form = buildWorkflowNodeConfigForm({ nodeType: "action", configFields: [{ key: "url" }] });
    expect(form?.variableSources[0]?.params.suggestions).toEqual([]);
  });

  test("the definition id names the node type, so two panels are distinguishable", () => {
    expect(
      buildWorkflowNodeConfigForm({ nodeType: "decision", configFields: [{ key: "a" }] })?.id,
    ).toBe("workflow-node-config-decision");
  });
});
