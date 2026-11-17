// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { childNodes, findChild, fingerprintSnapshot, orderedChildren, parseSnapshot, rowId } from "./snapshot.js";

const block = (id: string, position: number) => ({ table: "blocks", row: { id, variant_id_position: position, values: { text: id } }, children: {} });
const snapshot = {
  schemaVersion: 1, entity: "Template",
  head: {
    table: "templates", row: { id: "t1", parameters: [{ key: "name", osfType: "string" }] },
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

// The literals below were produced by the serializer and hash as `publish()`
// carried them privately before they moved here. They are the stored format of
// every existing version row: a change that needs them edited changes every
// published content hash.
describe("published snapshot fingerprint", () => {
  const fingerprinted = {
    schemaVersion: 1 as const, entity: "Template",
    head: {
      table: "templates",
      row: { id: "t1", zeta: null, "é": "accent", e: 1.5, f: true, Beta: "upper", alpha: "lower", "naam ø": "Ünïcode ☃ \"quoted\"", parameters: [{ key: "name", osfType: "string" }, { osfType: "number", key: "amount" }] },
      children: { template_variants: [{ table: "template_variants", row: { id: "v-nl", locale: "nl" }, children: { blocks: [block("b2", 1), block("b1", 0)] } }] },
      extensions: { tenant_code: "x" }, extensionDefinitions: [{ key: "tenant_code", version: 2 }],
    },
  };
  const canonical = '{"entity":"Template","head":{"children":{"template_variants":[{"children":{"blocks":[{"children":{},"row":{"id":"b2","values":{"text":"b2"},"variant_id_position":1},"table":"blocks"},{"children":{},"row":{"id":"b1","values":{"text":"b1"},"variant_id_position":0},"table":"blocks"}]},"row":{"id":"v-nl","locale":"nl"},"table":"template_variants"}]},"extensionDefinitions":[{"key":"tenant_code","version":2}],"extensions":{"tenant_code":"x"},"row":{"alpha":"lower","Beta":"upper","e":1.5,"é":"accent","f":true,"id":"t1","naam ø":"Ünïcode ☃ \\"quoted\\"","parameters":[{"key":"name","osfType":"string"},{"key":"amount","osfType":"number"}],"zeta":null},"table":"templates"},"schemaVersion":1}';
  const contentHash = "edcf1e8a735eb24423c273c5b61f15eeacbb2ceb7a8b1fc581b25958df685dde";

  test("returns the exact canonical text and hash publish() stores", () => {
    expect(fingerprintSnapshot(fingerprinted)).toEqual({ canonical, contentHash });
    expect(JSON.parse(canonical)).toEqual(fingerprinted);
  });
  test("orders keys by localeCompare, not by code unit", () => {
    // Code-unit order would put "Beta" before "alpha" and "é" after "zeta".
    const keys = Object.keys(JSON.parse(fingerprintSnapshot(fingerprinted).canonical).head.row);
    expect(keys).toEqual(["alpha", "Beta", "e", "é", "f", "id", "naam ø", "parameters", "zeta"]);
  });
  test("does not depend on the order objects were built in", () => {
    const { head } = fingerprinted;
    const rebuilt = {
      head: {
        extensionDefinitions: [{ version: 2, key: "tenant_code" }], extensions: head.extensions,
        children: { template_variants: [{ children: { blocks: [{ children: {}, row: { values: { text: "b2" }, variant_id_position: 1, id: "b2" }, table: "blocks" }, block("b1", 0)] }, row: { locale: "nl", id: "v-nl" }, table: "template_variants" }] },
        row: Object.fromEntries(Object.entries(head.row).reverse()), table: "templates",
      },
      entity: "Template", schemaVersion: 1 as const,
    };
    expect(fingerprintSnapshot(rebuilt)).toEqual({ canonical, contentHash });
  });
  test("keeps array order, so reordered children are different content", () => {
    const variant = fingerprinted.head.children.template_variants[0]!;
    const reordered = { ...fingerprinted, head: { ...fingerprinted.head, children: { template_variants: [{ ...variant, children: { blocks: [...variant.children.blocks].reverse() } }] } } };
    const result = fingerprintSnapshot(reordered);
    expect(result.contentHash).not.toBe(contentHash);
    expect(result.canonical.indexOf('"id":"b1"')).toBeLessThan(result.canonical.indexOf('"id":"b2"'));
    const parameters = { ...fingerprinted, head: { ...fingerprinted.head, row: { ...fingerprinted.head.row, parameters: [...fingerprinted.head.row.parameters].reverse() } } };
    expect(fingerprintSnapshot(parameters).contentHash).not.toBe(contentHash);
  });
  test("fingerprints what it is given and leaves the input alone", () => {
    const withBookkeeping = { ...fingerprinted, head: { ...fingerprinted.head, row: { ...fingerprinted.head.row, updated_at: "2026-01-01T00:00:00Z" } } };
    const before = JSON.stringify(withBookkeeping);
    const result = fingerprintSnapshot(withBookkeeping);
    expect(result.canonical).toContain('"updated_at":"2026-01-01T00:00:00Z"');
    expect(result.contentHash).not.toBe(contentHash);
    expect(JSON.stringify(withBookkeeping)).toBe(before);
    // Head keys outside the typed shape are content too: dropping them changes the hash.
    const { extensions: _extensions, extensionDefinitions: _definitions, ...bare } = fingerprinted.head;
    expect(fingerprintSnapshot({ ...fingerprinted, head: bare }).contentHash).not.toBe(contentHash);
  });
});
