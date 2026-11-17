// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import { captureTemplateBlocks } from "./content/capture.js";
import { inclusionCopyContent, readInclusionCopy, sourceRecord } from "./content/inclusion-copy.js";
import type { CompiledContentBlockRegistry, ContentBlock, ContentResolvers, ContentTemplateVersion } from "./content/types.js";
import type { TemplateVersionRow } from "./document-blocks.js";
import { applyTemplateVersion, planFollow, type ApplyContext, type FollowBlock, type FollowTemplateBlock } from "./document-follow.js";

const template = (id: string, templateBlockId: string, key: string, diverged = false): FollowBlock => ({ id, origin: "template", templateBlockId, diverged, key });
const local = (id: string, key = "local"): FollowBlock => ({ id, origin: "local", templateBlockId: null, diverged: false, key });
const next = (templateBlockId: string, key: string, locked = false): FollowTemplateBlock => ({ templateBlockId, key, locked });
const previous = new Map([["t1", "one"], ["t2", "two"], ["t3", "three"]]);

describe("the follow-template plan", () => {
  test("re-seeds untouched blocks, keeps edited ones diverged, drops removed ones, inserts new ones", () => {
    const plan = planFollow(
      [template("a", "t1", "one"), template("b", "t2", "two-edited"), template("c", "t3", "three")],
      previous,
      [next("t1", "one-v2"), next("t2", "two-v2"), next("t4", "four")],
    );
    expect(plan.reseed).toEqual([{ id: "a", templateBlockId: "t1" }]);
    expect(plan.diverge).toEqual(["b"]);
    expect(plan.remove).toEqual(["c"]);
    expect(plan.insert).toEqual(["t4"]);
    expect(plan.order).toEqual([{ kind: "existing", id: "a" }, { kind: "existing", id: "b" }, { kind: "insert", templateBlockId: "t4" }]);
  });
  test("local blocks and edited orphans trail the template block that preceded them", () => {
    const plan = planFollow(
      [local("l0"), template("a", "t1", "one"), local("l1"), template("b", "t2", "two-edited"), template("c", "t3", "three-edited"), local("l2")],
      previous,
      [next("t3", "three"), next("t1", "one")],
    );
    // t2 vanished but was edited: it stays, diverged, right after its former predecessor t1, as does l1.
    expect(plan.diverge).toEqual(["b", "c"]);
    expect(plan.remove).toEqual([]);
    expect(plan.order.map((slot) => (slot.kind === "existing" ? slot.id : `+${slot.templateBlockId}`))).toEqual(["l0", "c", "l2", "a", "l1", "b"]);
  });
  test("a block already flagged diverged is never re-seeded, even when its content still matches", () => {
    const plan = planFollow([template("a", "t1", "one", true)], previous, [next("t1", "one")]);
    expect(plan.reseed).toEqual([]);
    expect(plan.diverge).toEqual(["a"]);
  });
  test("a template block unknown to the tracked snapshot counts as edited", () => {
    const plan = planFollow([template("a", "t9", "nine")], previous, []);
    expect(plan.diverge).toEqual(["a"]);
    expect(plan.order).toEqual([{ kind: "existing", id: "a" }]);
  });
  test("a second row claiming the same template block is a local block; the first keeps the slot", () => {
    const plan = planFollow([template("a", "t1", "one"), template("dup", "t1", "one")], previous, [next("t1", "one-v2")]);
    expect(plan.reseed).toEqual([{ id: "a", templateBlockId: "t1" }]);
    expect(plan.remove).toEqual([]);
    expect(plan.order).toEqual([{ kind: "existing", id: "a" }, { kind: "existing", id: "dup" }]);
  });
  test("new source locks conflict instead of discarding local edits", () => {
    expect(()=>planFollow([template("a","t1","one-edited")],previous,[next("t1","one-v2",true)])).toThrow();
  });
  test("a locally removed optional block stays removed; a new mandatory block conflicts",()=>{
    expect(planFollow([],previous,[next("t1","one-v2")]).insert).toEqual([]);
    expect(()=>planFollow([],previous,[next("t1","one-v2",true)])).toThrow();
  });
  test("the lock lives on the new snapshot block: a dropped block keeps its local edit", () => {
    expect(planFollow([template("a", "t1", "one-edited")], previous, []).diverge).toEqual(["a"]);
    expect(planFollow([template("a", "t1", "one")], previous, []).remove).toEqual(["a"]);
  });
  test("an empty new variant removes every untouched template block and keeps local ones", () => {
    const plan = planFollow([template("a", "t1", "one"), local("l1")], previous, []);
    expect(plan.remove).toEqual(["a"]);
    expect(plan.order).toEqual([{ kind: "existing", id: "l1" }]);
  });
});

describe("linking a template version to a document", () => {
  const carrier = { entityName: "Block", valuesColumn: "values", definitionColumn: "definition_key", definitions: {
    Line: { entityName: "Line", schemaVersion: 1, fields: [{ key: "text" }], references: [] },
    DealSummary: { entityName: "DealSummary", schemaVersion: 1, fields: [{ key: "deal" }], references: [{ fieldKey: "deal", targetEntity: "Deal", column: "deal_id", parameterColumn: "deal_parameter" }] },
    Slot: { entityName: "Slot", schemaVersion: 1, fields: [{ key: "parameters", valueFieldsFrom: { reference: "version", headEntity: "Template" } }], references: [{ fieldKey: "version", targetEntity: "TemplateVersion", column: "version_id" }] },
  } } as unknown as RuntimeEntityValueCarrier;
  const registry: CompiledContentBlockRegistry = {
    Line: { entityName: "Line", schemaVersion: 1, fields: { text: { baseType: "string", required: true, variables: "template" } }, renderers: { document: "line" } },
    DealSummary: { entityName: "DealSummary", schemaVersion: 1, fields: { deal: { baseType: "string", cardinality: { min: 1, max: 1 }, variables: "whole", relationship: { target: "Deal" } } }, renderers: { document: "deal" } },
    Slot: { entityName: "Slot", schemaVersion: 1, renderers: {}, composition: { templateVersionField: "version", parametersField: "parameters" },
      fields: { version: { baseType: "string", required: true, relationship: { target: "TemplateVersion" } }, parameters: { baseType: "object", variables: "both" }, content: { baseType: "object" } } },
  };
  const columns = new Map(Object.entries({ id: "uuid", values: "jsonb", definition_key: "text", definition_version: "integer", locked: "boolean", deal_id: "uuid", deal_parameter: "text", version_id: "uuid", document_variant_id: "uuid", origin: "text", template_block_id: "uuid", diverged: "boolean" }));
  type Authored = { id: string; definition_key: string; values: Record<string, unknown>; deal_parameter?: string; version_id?: string; locked?: boolean };
  const row = (block: Authored, position: number) => ({ deal_id: null, deal_parameter: null, version_id: null, locked: false, definition_version: 1, ...block, variant_id: "tv", variant_id_position: position });
  const versionRow = (id: string, blocks: readonly Authored[]): TemplateVersionRow => ({ id, template_id: "t", version_number: 1, status: "published", snapshot: { schemaVersion: 1, entity: "Template", head: { table: "templates", row: { id: "t" }, children: {
    template_variants: [{ table: "template_variants", row: { id: "tv", channel: "document", locale: "en" }, children: { blocks: blocks.map((block, index) => ({ table: "blocks", row: row(block, index), children: {} })) } }] } } } as unknown as TemplateVersionRow["snapshot"] });

  /** A document's variants and blocks in memory, answering the statements the follow rule issues. */
  function store() {
    const blocks: Record<string, unknown>[] = [];
    const variants: Record<string, unknown>[] = [];
    const document: Record<string, unknown> = {};
    const quoted = (sql: string) => [...sql.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
    const value = (name: string, raw: unknown) => columns.get(name) === "jsonb" && typeof raw === "string" ? JSON.parse(raw) : raw;
    const trx = { async executeQuery(query: { sql: string; parameters: unknown[] }) {
      const { sql, parameters } = query;
      if (sql.includes("insert into erp.document_variants")) { const variant = { id: "dv", document_id: parameters[0], channel: parameters[1], locale: parameters[2] }; variants.push(variant); return { rows: [variant] }; }
      if (sql.includes("from erp.document_variants")) return { rows: variants };
      if (sql.includes("insert into erp.blocks")) {
        const id = `row-${blocks.length + 1}`;
        blocks.push({ id, document_variant_id: parameters[0], document_variant_id_position: parameters[1], origin: "template", template_block_id: parameters[2], diverged: false, ...Object.fromEntries(quoted(sql).map((name, index) => [name, value(name, parameters[index + 3])])) });
        return { rows: [{ id }] };
      }
      if (sql.includes("from erp.blocks b")) return { rows: [...blocks].sort((a, b) => Number(a.document_variant_id_position) - Number(b.document_variant_id_position)).map((entry) => ({ row: structuredClone(entry) })) };
      if (sql.includes("set diverged = true")) { for (const id of String(parameters[0]).split(",")) blocks.find((entry) => entry.id === id)!.diverged = true; return { rows: [] }; }
      if (sql.startsWith("update erp.blocks set")) { Object.assign(blocks.find((entry) => entry.id === parameters[0])!, Object.fromEntries(quoted(sql).map((name, index) => [name, value(name, parameters[index + 1])])), { diverged: false }); return { rows: [] }; }
      if (sql.startsWith("delete from erp.blocks")) { for (const id of String(parameters[1]).split(",")) blocks.splice(blocks.findIndex((entry) => entry.id === id), 1); return { rows: [] }; }
      if (sql.includes("update erp.blocks b set document_variant_id_position")) { String(parameters[1]).split(",").forEach((id, index) => { blocks.find((entry) => entry.id === id)!.document_variant_id_position = index; }); return { rows: [] }; }
      if (sql.includes("update erp.documents")) { Object.assign(document, { template_version_id: parameters[1], follow_error: parameters[2] }); return { rows: [] }; }
      return { rows: [] };
    } };
    return { trx, blocks, document };
  }

  /** Links `next` with the document's values, capturing through the engine as Document.linkTemplate does. */
  async function link(target: ReturnType<typeof store>, tracked: TemplateVersionRow | undefined, next: TemplateVersionRow, authored: readonly Authored[], values: { deal: string; names: Record<string, string> }) {
    const resolvers: ContentResolvers = {
      resolveTemplateVersion: () => null, resolveGlobalVariable: () => null,
      resolveEntity: (reference) => ({ tenantId: "tenant", entity: reference.entity, id: reference.id, versionId: "v", value: {} }),
      resolveVariablePath: (root, path) => ({ root, path, shape: { baseType: "string" }, value: values.names[root.id] ?? null, sources: [] }),
    };
    const version: ContentTemplateVersion = { id: next.id, tenantId: "tenant", templateId: "t", versionNumber: 1, parameters: { deal: { baseType: "string", required: true, relationship: { target: "Deal" } } },
      variants: [{ id: "tv", channel: "document", locale: "en", blocks: authored.map((block): ContentBlock => ({ id: block.id, definitionKey: block.definition_key, schemaVersion: 1, values: block.values as ContentBlock["values"], ...(block.locked ? { locked: true as const } : {}),
        references: block.deal_parameter ? { deal: { parameter: block.deal_parameter } } : block.version_id ? { version: { entity: "TemplateVersion", id: block.version_id } } : {} })) }] };
    const apply: ApplyContext = { trx: target.trx, carrier, columns, permitted: new Set(["Line", "DealSummary", "Slot"]), tracked: new Map(tracked ? [[tracked.id, tracked]] : []),
      capture: (variant) => captureTemplateBlocks({ tenantId: "tenant", channel: variant.channel, locale: variant.locale, version, variantId: variant.id, parameters: { deal: values.deal } }, registry, resolvers) };
    return applyTemplateVersion(apply, { id: "document", template_version_id: tracked?.id ?? null }, next);
  }
  const shown = (target: ReturnType<typeof store>) => [...target.blocks].sort((a, b) => Number(a.document_variant_id_position) - Number(b.document_variant_id_position)).map((entry) => (entry.values as { text?: string }).text ?? entry.definition_key);

  test("seeds resolved text and concrete references, and later refreshes only what was not changed here", async () => {
    const authored: Authored[] = [
      { id: "greeting", definition_key: "Line", values: { text: "Dear {{local.deal.customer.name}}" } },
      { id: "summary", definition_key: "DealSummary", values: {}, deal_parameter: "deal" },
      { id: "closing", definition_key: "Line", values: { text: "On behalf of {{local.deal.customer.name}}" } },
    ];
    const v1 = versionRow("v1", authored);
    const target = store();
    await link(target, undefined, v1, authored, { deal: "deal-1", names: { "deal-1": "Acme BV" } });
    // The document holds the name, not a variable, and the typed block names the record itself.
    expect(shown(target)).toEqual(["Dear Acme BV", "DealSummary", "On behalf of Acme BV"]);
    expect(target.blocks[1]).toMatchObject({ deal_id: "deal-1", deal_parameter: null, origin: "template", template_block_id: "summary" });
    expect(target.document).toMatchObject({ template_version_id: "v1", follow_error: null });
    // A canonical write marked the first block as changed here; the record was renamed since.
    Object.assign(target.blocks[0]!, { values: { text: "Dear Acme, welcome" }, diverged: true });
    await link(target, v1, v1, authored, { deal: "deal-1", names: { "deal-1": "Acme Holding" } });
    expect(shown(target)).toEqual(["Dear Acme, welcome", "DealSummary", "On behalf of Acme Holding"]);
    expect(target.blocks.map((entry) => entry.diverged)).toEqual([true, false, false]);
    expect(target.blocks).toHaveLength(3);
  });

  test("updates an inclusion the document holds from its own source record, and refuses the link on a real conflict", async () => {
    const inner = async (texts: Record<string, string>, locked: readonly string[] = []) => {
      const blocks = Object.entries(texts).map(([id, text]): ContentBlock => ({ id, definitionKey: "Line", schemaVersion: 1, values: { text }, references: {}, ...(locked.includes(id) ? { locked: true as const } : {}) }));
      return inclusionCopyContent({ source: await sourceRecord(blocks), blocks });
    };
    const slot = async (texts: Record<string, string>, locked?: readonly string[]): Promise<Authored[]> => [{ id: "slot", definition_key: "Slot", version_id: "inner-v1", values: { parameters: {}, content: await inner(texts, locked) } }];
    const first = await slot({ a: "A", b: "B" }, ["b"]);
    const v1 = versionRow("v1", first);
    const target = store();
    await link(target, undefined, v1, first, { deal: "deal-1", names: {} });
    const copy = () => readInclusionCopy((target.blocks[0]!.values as { content: unknown }).content);
    expect(copy().blocks.map((block) => block.values.text)).toEqual(["A", "B"]);
    // A local change inside the copy, as a canonical write stores it.
    const edited = structuredClone(target.blocks[0]!.values) as { content: { blocks: { values: { text: string } }[] } };
    edited.content.blocks[0]!.values.text = "A mine";
    Object.assign(target.blocks[0]!, { values: edited, diverged: true });
    const second = await slot({ a: "A", b: "B2", c: "C" }, ["b"]);
    await link(target, v1, versionRow("v2", second), second, { deal: "deal-1", names: {} });
    expect(copy().blocks.map((block) => block.values.text)).toEqual(["A mine", "B2", "C"]);
    expect(copy().source.filter((entry) => entry.locked).map((entry) => entry.id)).toEqual(["b"]);
    expect(target.blocks[0]!.diverged).toBe(true);
    const before = JSON.stringify(target.blocks);
    const clash = await slot({ a: "A theirs", b: "B2", c: "C" }, ["b"]);
    await expect(link(target, versionRow("v2", second), versionRow("v3", clash), clash, { deal: "deal-1", names: {} })).rejects.toThrow("The existing inclusion has been kept.");
    expect(JSON.stringify(target.blocks)).toBe(before);
    expect(target.document.template_version_id).toBe("v2");
    // Nor can a version take the protected block away: by dropping it from the inclusion, or by dropping the inclusion.
    const emptied = await slot({ a: "A", c: "C" });
    await expect(link(target, versionRow("v2", second), versionRow("v4", emptied), emptied, { deal: "deal-1", names: {} })).rejects.toThrow("protected here");
    const gone: Authored[] = [{ id: "plain", definition_key: "Line", values: { text: "Plain" } }];
    target.blocks[0]!.diverged = false;
    await expect(link(target, versionRow("v2", second), versionRow("v5", gone), gone, { deal: "deal-1", names: {} })).rejects.toThrow("protected here");
    expect(copy().blocks.map((block) => block.values.text)).toEqual(["A mine", "B2", "C"]);
  });
});

describe("publishing a template", () => {
  test("registers the image freeze only: no follower moves a document to the new version", async () => {
    const versioning = await import("@openshapeforge/versioning/followers");
    const runtime = await import("./runtime.js");
    const { freezeTemplateImages } = await import("./images.js");
    await runtime.default.init();
    try {
      expect(versioning.publishFollowers("Template")).toEqual([freezeTemplateImages]);
    } finally {
      await runtime.default.close();
    }
    expect(versioning.publishFollowers("Template")).toEqual([]);
    expect(Object.keys(await import("./document-follow.js"))).not.toContain("followTemplatePublish");
  });
});
