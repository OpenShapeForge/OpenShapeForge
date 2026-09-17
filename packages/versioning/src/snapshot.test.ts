// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { childNodes, findChild, orderedChildren, parseSnapshot, rowId } from "./snapshot.js";

const block = (id: string, position: number) => ({ table: "blocks", row: { id, variant_id_position: position, values: { text: id } }, children: {} });
const snapshot = {
  schemaVersion: 1, entity: "Template",
  head: {
    table: "templates", row: { id: "t1", parameters: [{ key: "name", valueType: "string" }] },
    children: {
      template_variants: [
        { table: "template_variants", row: { id: "v-nl", channel: "document", locale: "nl" }, children: { blocks: [block("b2", 1), block("b1", 0), block("b3", 2)] } },
        { table: "template_variants", row: { id: "v-en", channel: "document", locale: "en" }, children: {} },
      ],
    },
  },
};

describe("published snapshot helpers", () => {
  test("parses a stored snapshot, also from its JSON text", () => {
    const parsed = parseSnapshot(JSON.stringify(snapshot));
    expect(parsed.entity).toBe("Template");
    expect(childNodes(parsed.head, "template_variants")).toHaveLength(2);
    expect(childNodes(parsed.head, "missing")).toEqual([]);
  });
  test("refuses shapes publish() never writes", () => {
    expect(() => parseSnapshot({ schemaVersion: 2, entity: "Template", head: snapshot.head })).toThrow("schemaVersion 1");
    expect(() => parseSnapshot({ schemaVersion: 1, entity: "Template", head: { table: "templates", row: {}, children: { blocks: {} } } })).toThrow("head.blocks");
    expect(() => parseSnapshot({ schemaVersion: 1, entity: "Template", head: { table: "templates", row: {} } })).toThrow("head is malformed");
  });
  test("selects a variant by column values and orders its blocks by position", () => {
    const parsed = parseSnapshot(snapshot);
    const variant = findChild(parsed.head, "template_variants", { channel: "document", locale: "nl" })!;
    expect(rowId(variant)).toBe("v-nl");
    expect(orderedChildren(variant, "blocks").map(rowId)).toEqual(["b1", "b2", "b3"]);
    expect(orderedChildren(variant, "blocks", "variant_id_position").map(rowId)).toEqual(["b1", "b2", "b3"]);
    expect(findChild(parsed.head, "template_variants", { channel: "email", locale: "nl" })).toBeUndefined();
    expect(orderedChildren(findChild(parsed.head, "template_variants", { locale: "en" })!, "blocks")).toEqual([]);
  });
  test("falls back to id order without a position column", () => {
    const node = { table: "x", row: { id: "p" }, children: { items: [{ table: "items", row: { id: "b" }, children: {} }, { table: "items", row: { id: "a" }, children: {} }] } };
    expect(orderedChildren(node, "items").map(rowId)).toEqual(["a", "b"]);
    expect(() => rowId({ table: "items", row: {}, children: {} })).toThrow("no id");
  });
});
