// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { ModuleOperationContext, RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import { blockHash, readInclusionCopy } from "./content/inclusion-copy.js";
import type { JsonObject } from "./content/json.js";
import type { ContentBlock } from "./content/types.js";
import { composeTemplate } from "./inclusion-prepare.js";
import { assertBlockInclusionRemoval, prepareBlockInclusionWrite, retainedInclusionProvenance, type InclusionActor } from "./inclusion-write.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenant = id(1), template = id(2), variant = id(3), hostVariant = id(4), documentVariant = id(5), deal = id(6);
const v1 = id(11), v2 = id(12), v3 = id(13), greeting = id(21), terms = id(22), closing = id(23), added = id(24), chip = id(8);
const carrier = {
  entityName: "Block", fieldKey: "values", definitionField: "definitionKey", schema: "erp", table: "blocks", definitionColumn: "definition_key", valuesColumn: "values",
  definitions: {
    TextColumns: {entityName:"TextColumns",schemaVersion:1,definitionHash:"c".repeat(64),references:[],fields:[{key:"left",baseType:"object",osfType:"object",cardinality:"collection"},{key:"right",baseType:"object",osfType:"object",cardinality:"collection"}],valueSchema:{type:"object"}},
    TextBlock: {
      entityName: "TextBlock", schemaVersion: 1, definitionHash: "a".repeat(64), references: [],
      fields: [{ key: "markdown", osfType: "markdown", baseType: "string", required: true, variables: "template" }], valueSchema: { type: "object" },
    },
    TemplateBlock: {
      entityName: "TemplateBlock", schemaVersion: 1, definitionHash: "b".repeat(64), valueSchema: { type: "object" },
      fields: [
        { key: "version", osfType: "TemplateVersion", baseType: "string", required: true, relationship: { target: "TemplateVersion" } },
        { key: "parameters", osfType: "object", baseType: "object", variables: "both", valueFieldsFrom: { reference: "version", headEntity: "Template", snapshotColumn: "parameters" } },
        { key: "content", osfType: "object", baseType: "object" },
      ],
      references: [{ fieldKey: "version", targetEntity: "TemplateVersion", column: "template_version_id", parameterColumn: "template_version_parameter", schema: "erp", table: "template_versions", required: true }],
    },
  },
} as unknown as RuntimeEntityValueCarrier;

type Source = { id: string; markdown: string; locked?: boolean };
/** The stored form of a copy, as the prepare read returns it. */
type PreparedContent = JsonObject & { source: JsonObject[]; blocks: JsonObject[] };
const snapshot = (blocks: readonly Source[]) => ({ schemaVersion: 1, entity: "Template", head: { table: "templates",
  row: { id: template, tenant_id: tenant, parameters: [{ key: "name", osfType: "string" }] },
  children: { template_variants: [{ table: "template_variants", row: { id: variant, tenant_id: tenant, template_id: template, channel: "document", locale: "en" },
    children: { blocks: blocks.map((block, index) => ({ table: "blocks", children: {}, row: { id: block.id, tenant_id: tenant, variant_id: variant, variant_id_position: index, definition_key: "TextBlock", definition_version: 1, values: { markdown: block.markdown }, locked: block.locked === true } })) } }] } } });

/** The session that writes, its platform services and the transaction the row is stored in. */
function fixture(options: { host?: "template" | "document"; credential?: string } = {}) {
  const versions: Record<string, readonly Source[]> = {
    [v1]: [{ id: greeting, markdown: "Dear {{local.name}}" }, { id: terms, markdown: "Terms", locked: true }, { id: closing, markdown: "Regards" }],
    [v2]: [{ id: greeting, markdown: "Dear {{local.name}}" }, { id: terms, markdown: "Terms", locked: true }, { id: closing, markdown: "Kind regards" }],
  };
  const log = { reads: [] as string[], authorized: [] as string[], statements: [] as string[], actors: 0 };
  const denied = new Set<string>();
  const data = { brand: "Acme" };
  /** Saved block rows, for a read that names one. */
  const saved = new Map<string, Record<string, unknown>>();
  const session = { tenantId: tenant, userId: id(9), credential: options.credential ?? "bearer", roles: ["Documents.Manage"], groups: [], scope: "tenant" };
  const trx = { async executeQuery(query: { sql: string; parameters: unknown[] }) {
    log.statements.push(query.sql.trim().split(/\s+/).slice(0, 4).join(" "));
    if (query.sql.includes("from erp.template_variants")) return { rows: [{ channel: "document", locale: "en", parameters: [{ key: "client", osfType: "string" }] }] };
    if (query.sql.includes("from erp.document_variants")) return { rows: [{ channel: "document", locale: "en", template_version_id: null, parameters: {} }] };
    if (query.sql.includes("from erp.template_versions")) return { rows: versions[String(query.parameters[1])] ? [{ id: query.parameters[1] }] : [] };
    if (query.sql.includes("from erp.chips")) return { rows: [{ id: chip }] };
    if (query.sql.includes("from erp.blocks b")) { const found = query.parameters[0] === tenant ? saved.get(String(query.parameters[1])) : undefined; return { rows: found ? [{ row: found }] : [] }; }
    return { rows: [] };
  } };
  const context = { transport: "operation", session, platform: {
    records: {
      async assertAccess(_session: unknown, request: { entityName: string; id: string }) { log.authorized.push(`${request.entityName}:${request.id}`); if (denied.has(request.id)) throw new Error("FORBIDDEN"); },
      projectStoredFields: (_session: unknown, request: { fields: Record<string, unknown> }) => request.fields,
    },
    schemas: {
      entityValues: { get: () => carrier, collection: () => ({ targetEntity: "Block", allowedDefinitions: ["TextBlock", "TemplateBlock", "TextColumns"] }) },
      fields: {
        object: (fields: readonly { key: string }[]) => ({ type: "object", properties: Object.fromEntries(fields.map((field) => [field.key, { type: "string" }])) }),
        validateObject: () => ({ valid: true }),
      },
      json: { validate: () => ({ valid: true }) },
    },
    db: { withSession: (_session: unknown, work: (transaction: unknown) => unknown) => work(trx) },
    operations: {
      list: async () => ["TemplateVersion", "Chip"].map((entityName) => ({ id: `${entityName}.get`, entityName, intent: "get", effects: { data: "read", external: "none" } })),
      get: async () => undefined,
      async execute(_session: unknown, request: { input: { id: string } }) {
        log.reads.push(request.input.id);
        if (request.input.id === chip) return { data: { id: chip, tenantId: tenant, updatedAt: "2026-01-01T00:00:00Z", key: "brand", definition: { key: "value", osfType: "multilineText", required: true }, value: data.brand }, operations: [] };
        const blocks = versions[request.input.id];
        return { data: blocks ? { id: request.input.id, tenantId: tenant, updatedAt: "2026-01-01T00:00:00Z", template, versionNumber: 1, snapshot: snapshot(blocks) } : null, operations: [] };
      },
    },
  } } as unknown as ModuleOperationContext;
  const actor: InclusionActor = (work) => { log.actors++; return work(context); };
  const owner = options.host === "template" ? { variant_id: hostVariant, document_variant_id: null } : { variant_id: null, document_variant_id: documentVariant };
  const row = (version: string, values: Record<string, unknown>) => ({ id: id(30), tenant_id: tenant, ...owner, document_variant_id_position: 0, origin: "local", diverged: false, locked: false, definition_key: "TemplateBlock", definition_version: 1, template_version_id: version, template_version_parameter: null, values });
  const write = (before: Record<string, unknown> | undefined, after: Record<string, unknown>, withActor = true) => prepareBlockInclusionWrite(trx, tenant, carrier, before, after, withActor ? { actor } : {});
  const host = options.host === "template" ? { entity: "TemplateVariant", id: hostVariant } : { entity: "DocumentVariant", id: documentVariant };
  /** TemplateBlock.materialize as a caller reaches it: the version, inputs and draft it is about to save. */
  const prepare = async (version: string, values: Record<string, unknown>, locator: { blockId?: string; path?: string[]; host?: unknown; baseline?: unknown } = {}) =>
    ((await composeTemplate({ definitionKey: "TemplateBlock", referenceField: "version", parametersField: "parameters", values, references: { version: { entity: "TemplateVersion", id: version } }, host, ...locator }, context)) as { value: { kind: string; referenceField: string; version: unknown; parameters: Record<string, unknown>; content: PreparedContent; baseline: { version: unknown; parameters: Record<string, unknown>; content: PreparedContent } } }).value;
  const writes = () => log.statements.filter((statement) => /^(insert|update|delete)\b/i.test(statement) || statement.includes("set_config"));
  return { versions, log, denied, data, saved, session, row, write, prepare, writes };
}
const markdown = (content: unknown) => readInclusionCopy(content).blocks.map((block) => block.values.markdown);
const edit = (content: unknown, blockId: string, text: string) => {
  const draft = structuredClone(content) as { blocks: { id: string; values: Record<string, unknown> }[] };
  draft.blocks.find((block) => block.id === blockId)!.values = { markdown: text };
  return draft;
};

describe("inserting an inclusion", () => {
  test("captures the source as the writing session and stores a complete copy with the server's record", async () => {
    const f = fixture();
    const values = await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } }));
    const copy = readInclusionCopy(values!.content);
    expect(markdown(values!.content)).toEqual(["Dear Ada", "Terms", "Regards"]);
    expect(copy.source.map((entry) => [entry.id, entry.locked ?? false])).toEqual([[greeting, false], [terms, true], [closing, false]]);
    for (const [index, entry] of copy.source.entries()) expect(entry.hash).toBe(await blockHash(copy.blocks[index]!));
    expect(values!.parameters).toEqual({ name: "Ada" });
    // The source was read through its canonical Operation and its template's record access, in this session.
    expect(f.log.reads).toEqual([v1]);
    expect(f.log.authorized).toEqual([`TemplateVersion:${v1}`, `Template:${template}`]);
    expect(f.log.actors).toBe(1);
  });

  test("a host template keeps a binding to its own variable pending and records which blocks hold it", async () => {
    const f = fixture({ host: "template" });
    const values = await f.write(undefined, f.row(v1, { parameters: { name: "{{local.client}}" } }));
    expect(markdown(values!.content)).toEqual(["Dear {{local.client}}", "Terms", "Regards"]);
    expect(readInclusionCopy(values!.content).source.map((entry) => entry.deferred ?? false)).toEqual([true, false, false]);
    await expect(f.write(undefined, f.row(v1, { parameters: { name: "{{local.unknown}}" } }))).rejects.toMatchObject({ operationError: { code: "MISSING_VARIABLE" } });
  });

  test("a baseline the caller sends with the insertion is never adopted", async () => {
    const f = fixture();
    const forged = { source: [{ id: greeting, hash: "0".repeat(64) }], blocks: [
      { id: greeting, definitionKey: "TextBlock", schemaVersion: 1, values: { markdown: "My greeting" } },
      { id: terms, definitionKey: "TextBlock", schemaVersion: 1, values: { markdown: "No terms" } },
    ] };
    const values = await f.write(undefined, f.row(v1, { parameters: { name: "Ada" }, content: forged }));
    const copy = readInclusionCopy(values!.content);
    // The record is the server's capture; the caller's blocks are local content over it, and the protected block is the source's.
    expect(copy.source.map((entry) => entry.id)).toEqual([greeting, terms, closing]);
    expect(copy.source[0]!.hash).not.toBe("0".repeat(64));
    expect(markdown(values!.content)).toEqual(["My greeting", "Terms"]);
    expect(copy.blocks[1]!.locked).toBe(true);
  });

  test("refuses without the writing session, for a source it may not read, another tenant's row and a version left to a variable", async () => {
    const f = fixture();
    const next = f.row(v1, { parameters: { name: "Ada" } });
    await expect(f.write(undefined, next, false)).rejects.toMatchObject({ operationError: { code: "OPERATION_UNAVAILABLE" } });
    f.denied.add(template);
    await expect(f.write(undefined, next)).rejects.toThrow("FORBIDDEN");
    f.denied.clear();
    await expect(f.write(undefined, f.row(id(99), { parameters: {} }))).rejects.toMatchObject({ operationError: { code: "DEPENDENCY_UNRESOLVED" } });
    await expect(prepareBlockInclusionWrite({ executeQuery: async () => ({ rows: [] }) }, id(77), carrier, undefined, next, { actor: (work) => work({ session: f.session, platform: {} } as unknown as ModuleOperationContext) })).rejects.toMatchObject({ operationError: { code: "FORBIDDEN" } });
    await expect(f.write(undefined, { ...next, template_version_id: null, template_version_parameter: "source" })).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    // No refusal above stored anything: the hook only returns values, and the transaction that called it rolls back.
    expect(f.log.statements.some((statement) => /^(insert|update|delete)/.test(statement))).toBe(false);
  });
});

describe("editing a stored copy", () => {
  async function stored() {
    const f = fixture();
    const values = await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } }));
    f.log.reads.length = 0; f.log.actors = 0;
    return { f, values: values!, before: f.row(v1, values!) };
  }

  test("an ordinary edit reads no template and keeps the stored record", async () => {
    const { f, values, before } = await stored();
    const next = await f.write(before, f.row(v1, { parameters: values.parameters, content: edit(values.content, greeting, "Dear Ada, welcome") }), false);
    expect(markdown(next!.content)).toEqual(["Dear Ada, welcome", "Terms", "Regards"]);
    expect(next!.content).toMatchObject({ source: (values.content as { source: unknown }).source });
    // A write that leaves the content out keeps the copy; it is never dropped.
    expect((await f.write(before, f.row(v1, { parameters: values.parameters }), false))!.content).toEqual(values.content);
    expect(f.log.reads).toEqual([]);
    expect(f.log.actors).toBe(0);
  });

  test("a direct write cannot change protected content, forge the record or lower a lock", async () => {
    const { f, values, before } = await stored();
    const content = values.content as { source: Record<string, unknown>[]; blocks: Record<string, unknown>[] };
    const attempts: unknown[] = [
      edit(content, terms, "Other terms"),
      { ...content, blocks: content.blocks.filter((block) => block.id !== terms) },
      { ...content, source: content.source.map((entry) => ({ id: entry.id, hash: entry.hash })) },
      { ...content, source: [] },
      { ...content, page: { format: "a4" } },
      { ...content, blocks: content.blocks.map((block) => ({ ...block, locked: false })) },
      { blocks: [] },
    ];
    // A record that differs from the stored one is weighed against a fresh capture, never adopted; without the
    // session to capture with it is refused outright.
    for (const attempt of attempts)
      await expect(f.write(before, f.row(v1, { parameters: values.parameters, content: attempt }))).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    await expect(f.write(before, f.row(v1, { parameters: values.parameters, content: attempts[2] }), false)).rejects.toMatchObject({ operationError: { code: "OPERATION_UNAVAILABLE" } });
    // The row cannot stop being an inclusion under the same id, which would leave the protected block nowhere.
    await expect(f.write(before, { ...before, definition_key: "TextBlock", template_version_id: null, values: { markdown: "Replacement" } }, false)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("enclosing block") } });
    // Nor can the row be moved out of its placement, removed, or turned into another block while it holds protected content.
    await expect(f.write(before, { ...f.row(v1, values), document_variant_id: id(55) }, false)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    await expect(assertBlockInclusionRemoval(carrier, before)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
  });

  test("an inclusion nested in the copy is protected through its enclosing block, and one without protected content can go", async () => {
    const { f, values, before } = await stored();
    const content = values.content as { source: unknown[]; blocks: Record<string, unknown>[] };
    const nested = { id: added, definitionKey: "TemplateBlock", schemaVersion: 1, values: { parameters: { name: "Grace" } }, references: { version: { entity: "TemplateVersion", id: v1 } } };
    const withNested = await f.write(before, f.row(v1, { parameters: values.parameters, content: { ...content, blocks: [...content.blocks, nested] } }));
    const inner = readInclusionCopy(withNested!.content).blocks.at(-1)!;
    // The nested inclusion was captured by the server like any other, in the same write.
    expect(markdown(inner.values.content)).toEqual(["Dear Grace", "Terms", "Regards"]);
    const holding = f.row(v1, withNested!);
    const without = { ...(withNested!.content as object), blocks: (withNested!.content as { blocks: ContentBlock[] }).blocks.filter((block) => block.id !== added) };
    await expect(f.write(holding, f.row(v1, { parameters: values.parameters, content: without }), false)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("enclosing block") } });
    await expect(assertBlockInclusionRemoval(carrier, holding)).rejects.toBeDefined();
    f.versions[v2] = [{ id: greeting, markdown: "Plain" }];
    const free = await f.write(undefined, f.row(v2, { parameters: {} }));
    await assertBlockInclusionRemoval(carrier, f.row(v2, free!));
  });
});

describe("changing the version or an input", () => {
  async function stored() {
    const f = fixture();
    const values = await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } }));
    return { f, values: values!, before: f.row(v1, values!) };
  }

  test("captures the new source and keeps a local edit beside the changes it adopts", async () => {
    const { f, values, before } = await stored();
    const mine = edit(values.content, greeting, "Dear Ada, welcome");
    const next = await f.write(before, f.row(v2, { parameters: { name: "Ada" }, content: mine }));
    expect(markdown(next!.content)).toEqual(["Dear Ada, welcome", "Terms", "Kind regards"]);
    // The stored draft is used when the caller sends none, and a changed input refreshes untouched text.
    const renamed = await f.write(before, f.row(v1, { parameters: { name: "Grace" } }));
    expect(markdown(renamed!.content)).toEqual(["Dear Grace", "Terms", "Regards"]);
    expect(renamed!.parameters).toEqual({ name: "Grace" });
    const kept = await f.write(f.row(v1, { parameters: values.parameters, content: mine }), f.row(v1, { parameters: { name: "Grace" } }));
    expect(markdown(kept!.content)).toEqual(["Dear Ada, welcome", "Terms", "Regards"]);
  });

  test("a block both sides changed refuses the write as a whole, and trying again changes nothing", async () => {
    const { f, values, before } = await stored();
    const mine = f.row(v1, { parameters: values.parameters, content: edit(values.content, closing, "Cheers") });
    const snapshotBefore = JSON.stringify(mine);
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(f.write(mine, f.row(v2, { parameters: { name: "Ada" } }))).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("The existing inclusion has been kept.") } });
    expect(JSON.stringify(mine)).toBe(snapshotBefore);
    // The draft sent with an update is checked against the stored baseline before anything is merged.
    await expect(f.write(before, f.row(v2, { parameters: { name: "Ada" }, content: edit(values.content, terms, "Other terms") }))).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
  });
});

describe("document blocks", () => {
  const text = { id: id(40), tenant_id: tenant, document_variant_id: documentVariant, variant_id: null, origin: "template", template_block_id: id(41), diverged: false, locked: false, definition_key: "TextBlock", definition_version: 1, values: { markdown: "Seeded" } };

  test("a canonical write that changes a seeded block marks it as a local change, once", async () => {
    const f = fixture();
    expect(await f.write(text, { ...text, values: { markdown: "Edited" } }, false)).toBeUndefined();
    expect(f.log.statements.filter((statement) => statement.startsWith("update erp.blocks set diverged"))).toHaveLength(1);
    await f.write(text, { ...text }, false);
    await f.write({ ...text, diverged: true }, { ...text, diverged: true, values: { markdown: "Again" } }, false);
    await f.write({ ...text, origin: "local" }, { ...text, origin: "local", values: { markdown: "Local" } }, false);
    expect(f.log.statements.filter((statement) => statement.startsWith("update erp.blocks set diverged"))).toHaveLength(1);
  });

  test("a source-locked block cannot be changed, unlocked or removed through a generic write", async () => {
    const f = fixture();
    const locked = { ...text, locked: true };
    await expect(f.write(locked, { ...locked, values: { markdown: "Changed" } }, false)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    await expect(f.write(locked, { ...locked, locked: false }, false)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    await expect(assertBlockInclusionRemoval(carrier, locked)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    await f.write(locked, { ...locked }, false);
    await assertBlockInclusionRemoval(carrier, text);
  });
});

describe("protection through a source update at the write boundary", () => {
  test("a version that no longer offers a protected block cannot replace the stored one, directly or nested", async () => {
    const f = fixture();
    const values = (await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } })))!;
    const before = f.row(v1, values);
    f.versions[v3] = [{ id: greeting, markdown: "Dear {{local.name}}" }, { id: closing, markdown: "Regards" }];
    await expect(f.write(before, f.row(v3, { parameters: { name: "Ada" } }))).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("protected here") } });
    await expect(f.prepare(v3, { parameters: { name: "Ada" } }, { blockId: before.id })).rejects.toBeDefined();
    // The same through an enclosing copy: the nested inclusion holds the protected block.
    const content = values.content as { blocks: Record<string, unknown>[] };
    const nested = { id: added, definitionKey: "TemplateBlock", schemaVersion: 1, values: { parameters: { name: "Grace" } }, references: { version: { entity: "TemplateVersion", id: v1 } } };
    const holding = f.row(v1, (await f.write(before, f.row(v1, { parameters: values.parameters, content: { ...content, blocks: [...content.blocks, nested] } })))!);
    const blocks = (holding.values.content as { blocks: Record<string, unknown>[] }).blocks;
    const repointed = blocks.map((block) => block.id === added ? { ...block, references: { version: { entity: "TemplateVersion", id: v3 } } } : block);
    await expect(f.write(holding, f.row(v1, { parameters: values.parameters, content: { ...(holding.values.content as object), blocks: repointed } }))).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    // And a nested inclusion cannot become a text block under its own id.
    const disguised = blocks.map((block) => block.id === added ? { id: added, definitionKey: "TextBlock", schemaVersion: 1, values: { markdown: "Gone" } } : block);
    await expect(f.write(holding, f.row(v1, { parameters: values.parameters, content: { ...(holding.values.content as object), blocks: disguised } }), false)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("enclosing block") } });
  });
});

describe("preparing an inclusion before it is saved", () => {
  async function stored() {
    const f = fixture();
    const values = (await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } })))!;
    const before = f.row(v1, values);
    f.saved.set(before.id, before);
    f.log.statements.length = 0; f.log.reads.length = 0; f.log.authorized.length = 0;
    return { f, values, before };
  }

  test("prepares a new, unsaved inclusion as the write would store it, and writes nothing", async () => {
    const f = fixture();
    const prepared = await f.prepare(v1, { parameters: { name: "Ada" } });
    expect(prepared).toMatchObject({ kind: "template", referenceField: "version", version: { entity: "TemplateVersion", id: v1 }, parameters: { name: "Ada" } });
    expect(markdown(prepared.content)).toEqual(["Dear Ada", "Terms", "Regards"]);
    // The right to change the host was checked first, then the source was read as this session.
    expect(f.log.authorized).toEqual([`DocumentVariant:${documentVariant}`, `TemplateVersion:${v1}`, `Template:${template}`]);
    expect(f.writes()).toEqual([]);
    // Saving what was prepared stores exactly it: the write captures again and finds the same record.
    const values = await f.write(undefined, f.row(v1, { parameters: prepared.parameters, content: prepared.content }));
    expect(values!.content).toEqual(prepared.content);
  });

  test("refuses a host the session may not change, another host's or tenant's block and a path that leads nowhere", async () => {
    const { f, values, before } = await stored();
    f.denied.add(documentVariant);
    await expect(f.prepare(v2, { parameters: { name: "Ada" } }, { blockId: before.id })).rejects.toThrow("FORBIDDEN");
    // Refused before anything of the block or the source was read.
    expect(f.log.reads).toEqual([]);
    expect(f.log.statements).toEqual([]);
    f.denied.clear();
    f.saved.set(id(60), { ...before, id: id(60), document_variant_id: id(61) });
    await expect(f.prepare(v2, values, { blockId: id(60) })).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });
    await expect(f.prepare(v2, values, { blockId: id(62) })).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });
    await expect(f.prepare(v2, values, { blockId: before.id, path: [greeting] })).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });
    await expect(f.prepare(v2, values, { blockId: before.id, path: [greeting, "deeper"] })).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });
    await expect(f.prepare(v2, values, { path: [added] })).rejects.toMatchObject({ operationError: { code: "VALIDATION" } });
    for (const host of [{ entity: "Document", id: documentVariant }, { entity: "DocumentVariant", id: "not-a-uuid" }, { entity: "DocumentVariant", id: documentVariant, tenantId: id(77) }])
      await expect(f.prepare(v2, values, { blockId: before.id, host })).rejects.toMatchObject({ operationError: { code: expect.stringMatching(/VALIDATION/) } });
    await expect(f.prepare(v2, values, { blockId: before.id, path: Array.from({ length: 9 }, () => "step") })).rejects.toMatchObject({ operationError: { code: "VALIDATION" } });
    expect(f.writes()).toEqual([]);
  });

  test("merges the saved copy and the caller's current draft into the next copy without touching the saved one", async () => {
    const { f, values, before } = await stored();
    const snapshot = JSON.stringify(before);
    const mine = edit(values.content, greeting, "Dear Ada, welcome");
    const prepared = await f.prepare(v2, { parameters: { name: "Ada" }, content: mine }, { blockId: before.id });
    expect(markdown(prepared.content)).toEqual(["Dear Ada, welcome", "Terms", "Kind regards"]);
    expect(prepared.content.source).not.toEqual((values.content as { source: unknown }).source);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(f.writes()).toEqual([]);
    // A conflict refuses the read; the caller still holds its draft and the saved copy is as it was.
    const clash = edit(values.content, closing, "Cheers");
    await expect(f.prepare(v2, { parameters: { name: "Ada" }, content: clash }, { blockId: before.id })).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("The existing inclusion has been kept.") } });
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(f.writes()).toEqual([]);
    // A draft is checked against the stored record before anything is merged; a prepared copy needs the baseline it was prepared from.
    await expect(f.prepare(v2, { parameters: { name: "Ada" }, content: edit(values.content, terms, "Other terms") }, { blockId: before.id })).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    await expect(f.prepare(v2, { parameters: { name: "Ada" }, content: prepared.content }, { blockId: before.id })).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("Send the baseline") } });
  });

  test("prepares an inclusion nested in the saved copy, existing or newly added, by its path", async () => {
    const { f, values, before } = await stored();
    const content = values.content as { blocks: Record<string, unknown>[] };
    const nested = { id: added, definitionKey: "TemplateBlock", schemaVersion: 1, values: { parameters: { name: "Grace" } }, references: { version: { entity: "TemplateVersion", id: v1 } } };
    // Not stored yet: the last step of the path names the inclusion the draft adds.
    const fresh = await f.prepare(v1, { parameters: { name: "Grace" } }, { blockId: before.id, path: [added] });
    expect(markdown(fresh.content)).toEqual(["Dear Grace", "Terms", "Regards"]);
    const holding = f.row(v1, (await f.write(before, f.row(v1, { parameters: values.parameters, content: { ...content, blocks: [...content.blocks, nested] } })))!);
    f.saved.set(holding.id, holding);
    const inner = readInclusionCopy(holding.values.content).blocks.at(-1)!;
    const mine = edit(inner.values.content, closing, "Bye");
    f.log.statements.length = 0;
    const prepared = await f.prepare(v1, { parameters: { name: "Hedy" }, content: mine }, { blockId: holding.id, path: [added] });
    // The nested inclusion's own draft is kept, its untouched text follows the new input.
    expect(markdown(prepared.content)).toEqual(["Dear Hedy", "Terms", "Bye"]);
    expect(f.writes()).toEqual([]);
    // Saving the root with the prepared nested copy in place: the write verifies the nested record by capturing it again.
    const blocks = (holding.values.content as { blocks: Record<string, unknown>[] }).blocks.map((block) => block.id === added ? { ...block, values: { parameters: prepared.parameters, content: prepared.content } } : block);
    const saved = await f.write(holding, f.row(v1, { parameters: values.parameters, content: { ...(holding.values.content as object), blocks } }));
    expect(markdown(readInclusionCopy(saved!.content).blocks.at(-1)!.values.content)).toEqual(["Dear Hedy", "Terms", "Bye"]);
  });
});

describe("saving a prepared copy", () => {
  async function prepared() {
    const f = fixture();
    const values = (await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } })))!;
    const before = f.row(v1, values);
    f.saved.set(before.id, before);
    const next = await f.prepare(v2, { parameters: { name: "Ada" }, content: edit(values.content, greeting, "Dear Ada, welcome") }, { blockId: before.id });
    return { f, values, before, next };
  }

  test("stores the prepared copy, also when it was edited after it was prepared, with the record the server captured", async () => {
    const { f, before, next } = await prepared();
    const saved = await f.write(before, f.row(v2, { parameters: next.parameters, content: next.content }));
    expect(saved!.content).toEqual(next.content);
    // It was verified by capturing the new source again, not merged a second time.
    expect(markdown(saved!.content)).toEqual(["Dear Ada, welcome", "Terms", "Kind regards"]);
    const further = await f.write(before, f.row(v2, { parameters: next.parameters, content: edit(next.content, closing, "Until soon") }));
    expect(markdown(further!.content)).toEqual(["Dear Ada, welcome", "Terms", "Until soon"]);
    expect((further!.content as { source: unknown }).source).toEqual(next.content.source);
  });

  test("never adopts a hash, lock or page setting from the proposal, and keeps what the stored copy protects", async () => {
    const { f, before, next } = await prepared();
    const save = (content: unknown) => f.write(before, f.row(v2, { parameters: next.parameters, content }));
    const refused = { operationError: { code: "INVALID_STATE" } };
    const unlocked = next.content.source.map((entry) => ({ id: entry.id, hash: entry.hash }));
    // A lock dropped from the record, with the protected block rewritten to match.
    await expect(save({ ...edit(next.content, terms, "Other terms"), source: unlocked })).rejects.toMatchObject(refused);
    // A hash rewritten so an edited locked block would pass as captured.
    const forged = await blockHash({ id: terms, definitionKey: "TextBlock", schemaVersion: 1, values: { markdown: "Other terms" }, references: {} });
    await expect(save({ ...edit(next.content, terms, "Other terms"), source: next.content.source.map((entry) => entry.id === terms ? { ...entry, hash: forged } : entry) })).rejects.toMatchObject(refused);
    await expect(save({ ...next.content, page: { format: "a3" } })).rejects.toMatchObject(refused);
    // The record is right, but the protected block was changed or left out.
    await expect(save(edit(next.content, terms, "Other terms"))).rejects.toMatchObject(refused);
    await expect(save({ ...next.content, blocks: next.content.blocks.filter((block) => block.id !== terms) })).rejects.toMatchObject(refused);
    // A proposal for a source that changed since it was prepared is not what would be stored any more.
    f.versions[v2] = [{ id: greeting, markdown: "Hello {{local.name}}" }, { id: terms, markdown: "Terms", locked: true }, { id: closing, markdown: "Kind regards" }];
    await expect(save(next.content)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("Prepare it again") } });
  });
});

describe("preparing again a draft that was prepared before", () => {
  const ps = id(25), deeper = id(26), v4 = id(14), v5 = id(15);
  const stale = { operationError: { code: "INVALID_STATE", message: expect.stringContaining("earlier preparation no longer matches") } };
  const note = (blockId: string, text: string) => ({ id: blockId, definitionKey: "TextBlock", schemaVersion: 1, values: { markdown: text }, references: {} });
  /** A saved inclusion of v1, prepared for v2 with a local edit, and v3: v2 with one more block. */
  async function prepared() {
    const f = fixture();
    f.versions[v3] = [...f.versions[v2]!, { id: ps, markdown: "PS for {{local.name}}" }];
    const values = (await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } })))!;
    const before = f.row(v1, values);
    f.saved.set(before.id, before);
    const second = await f.prepare(v2, { parameters: { name: "Ada" }, content: edit(values.content, greeting, "Dear Ada, welcome") }, { blockId: before.id });
    f.log.statements.length = 0; f.log.authorized.length = 0; f.log.reads.length = 0;
    return { f, values, before, second };
  }

  test("answers every preparation with the capture alone as baseline, apart from the merged content", async () => {
    const { f, second } = await prepared();
    expect(second.baseline).toMatchObject({ version: { entity: "TemplateVersion", id: v2 }, parameters: { name: "Ada" } });
    expect(markdown(second.baseline.content)).toEqual(["Dear Ada", "Terms", "Kind regards"]);
    expect(markdown(second.content)).toEqual(["Dear Ada, welcome", "Terms", "Kind regards"]);
    expect(second.baseline.content.source).toEqual(second.content.source);
    // A new, unsaved inclusion: the baseline is what was captured, the content what would be stored.
    const fresh = await f.prepare(v1, { parameters: { name: "Ada" } });
    expect(fresh.baseline).toEqual({ version: { entity: "TemplateVersion", id: v1 }, parameters: fresh.parameters, content: fresh.content });
  });

  test("keeps what was typed after the earlier preparation when another version is chosen, and saves it", async () => {
    const { f, before, second } = await prepared();
    const snapshot = JSON.stringify(before);
    // Typed after v2 was previewed: an edit and a block of the caller's own.
    const typed = edit(second.content, closing, "Until soon");
    const mine = { ...typed, blocks: [...typed.blocks, note(added, "My own note")] };
    const third = await f.prepare(v3, { parameters: second.parameters, content: mine }, { blockId: before.id, baseline: second.baseline });
    expect(markdown(third.content)).toEqual(["Dear Ada, welcome", "Terms", "Until soon", "My own note", "PS for Ada"]);
    expect(markdown(third.baseline.content)).toEqual(["Dear Ada", "Terms", "Kind regards", "PS for Ada"]);
    // The host first; then the earlier source is read again as this session, before the next one.
    expect(f.log.authorized[0]).toBe(`DocumentVariant:${documentVariant}`);
    expect(f.log.authorized.indexOf(`TemplateVersion:${v2}`)).toBe(1);
    expect(f.log.authorized.indexOf(`TemplateVersion:${v3}`)).toBeGreaterThan(1);
    expect(f.writes()).toEqual([]);
    expect(JSON.stringify(before)).toBe(snapshot);
    // Save is the ordinary write: it captures v3 again and stores the proposal, the edits of both rounds included.
    const saved = await f.write(before, f.row(v3, { parameters: third.parameters, content: third.content }));
    expect(saved!.content).toEqual(third.content);
    expect(markdown(saved!.content)).toEqual(["Dear Ada, welcome", "Terms", "Until soon", "My own note", "PS for Ada"]);
    // Without the baseline the same request is refused; it never falls back to the saved copy and drops the draft.
    await expect(f.prepare(v3, { parameters: second.parameters, content: mine }, { blockId: before.id })).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("Send the baseline") } });
  });

  test("carries a draft through repeated changes of the inputs, each from the baseline before it", async () => {
    const { f, values, before } = await prepared();
    const first = await f.prepare(v1, { parameters: { name: "Grace" }, content: values.content }, { blockId: before.id });
    expect(markdown(first.content)).toEqual(["Dear Grace", "Terms", "Regards"]);
    const second = await f.prepare(v1, { parameters: { name: "Hedy" }, content: edit(first.content, closing, "Bye") }, { blockId: before.id, baseline: first.baseline });
    expect(markdown(second.content)).toEqual(["Dear Hedy", "Terms", "Bye"]);
    const mine = { ...second.content, blocks: [note(added, "Before all"), ...second.content.blocks] };
    const third = await f.prepare(v1, { parameters: { name: "Joan" }, content: mine }, { blockId: before.id, baseline: second.baseline });
    expect(markdown(third.content)).toEqual(["Before all", "Dear Joan", "Terms", "Bye"]);
    expect(f.writes()).toEqual([]);
    const saved = await f.write(before, f.row(v1, { parameters: third.parameters, content: third.content }));
    expect(markdown(saved!.content)).toEqual(["Before all", "Dear Joan", "Terms", "Bye"]);
    // A conflict still refuses as a whole: the next source changes the text that was edited after the last preparation.
    await expect(f.prepare(v2, { parameters: third.parameters, content: edit(third.content, closing, "Cheers") }, { blockId: before.id, baseline: third.baseline }))
      .rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("The existing inclusion has been kept.") } });
  });

  test("a new, unsaved inclusion is prepared again from its earlier baseline, and an inclusion nested in it as well", async () => {
    const f = fixture();
    const first = await f.prepare(v1, { parameters: { name: "Ada" } });
    const second = await f.prepare(v2, { parameters: first.parameters, content: edit(first.content, greeting, "Dear Ada, welcome") }, { baseline: first.baseline });
    expect(markdown(second.content)).toEqual(["Dear Ada, welcome", "Terms", "Kind regards"]);
    // Its locks are those of the capture: a draft that rewrites protected text is refused, not repaired.
    await expect(f.prepare(v2, { parameters: first.parameters, content: edit(first.content, terms, "Other terms") }, { baseline: first.baseline })).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    // An inclusion the draft holds inside this unsaved one: prepared on its own, twice, with an edit in between.
    const inner = await f.prepare(v1, { parameters: { name: "Grace" } });
    const again = await f.prepare(v2, { parameters: inner.parameters, content: edit(inner.content, greeting, "Dear Grace, hello") }, { baseline: inner.baseline });
    expect(markdown(again.content)).toEqual(["Dear Grace, hello", "Terms", "Kind regards"]);
    expect(f.writes()).toEqual([]);
    // Saving the root inserts both: each copy is captured again and holds what was typed.
    const nested = { id: added, definitionKey: "TemplateBlock", schemaVersion: 1, values: { parameters: again.parameters, content: again.content }, references: { version: { entity: "TemplateVersion", id: v2 } } };
    const saved = await f.write(undefined, f.row(v2, { parameters: second.parameters, content: { ...second.content, blocks: [...second.content.blocks, nested] } }));
    const copy = readInclusionCopy(saved!.content);
    expect(copy.blocks.slice(0, 3).map((block) => block.values.markdown)).toEqual(["Dear Ada, welcome", "Terms", "Kind regards"]);
    const child = readInclusionCopy(copy.blocks.at(-1)!.values.content);
    expect(child.blocks.map((block) => block.values.markdown)).toEqual(["Dear Grace, hello", "Terms", "Kind regards"]);
    expect(child.source.find((entry) => entry.id === terms)).toMatchObject({ locked: true });
  });

  test("reaches an inclusion below one that only the prepared draft holds, by its path", async () => {
    const { f, before } = await prepared();
    // Neither step is stored: the first preparation is that of a new inclusion.
    const first = await f.prepare(v1, { parameters: { name: "Grace" } }, { blockId: before.id, path: [added, deeper] });
    expect(markdown(first.content)).toEqual(["Dear Grace", "Terms", "Regards"]);
    const next = await f.prepare(v2, { parameters: first.parameters, content: edit(first.content, greeting, "Dear Grace, hello") }, { blockId: before.id, path: [added, deeper], baseline: first.baseline });
    expect(markdown(next.content)).toEqual(["Dear Grace, hello", "Terms", "Kind regards"]);
    // A step that is stored but is no inclusion stays a path that leads nowhere.
    await expect(f.prepare(v2, { parameters: first.parameters }, { blockId: before.id, path: [greeting, deeper], baseline: first.baseline })).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });
    expect(f.writes()).toEqual([]);
  });

  test("takes nothing of the baseline on the caller's word: content, hash, lock and page are those of a new capture", async () => {
    const { f, before, second } = await prepared();
    const snapshot = JSON.stringify(before);
    const again = (baseline: unknown, content: unknown = second.content) => f.prepare(v3, { parameters: second.parameters, content }, { blockId: before.id, baseline });
    const base = second.baseline;
    // Text of the baseline rewritten, so a local change would pass as the source's own.
    await expect(again({ ...base, content: edit(base.content, closing, "Cheers") })).rejects.toMatchObject(stale);
    // A lock dropped from the record, in the baseline and in the draft alike, with the protected block rewritten.
    const unlock = (content: PreparedContent) => {
      const rewritten = edit(content, terms, "Other terms") as unknown as { blocks: Record<string, unknown>[] };
      return { ...rewritten, source: content.source.map((entry) => ({ id: entry.id, hash: entry.hash })), blocks: rewritten.blocks.map(({ locked: _locked, ...block }) => block) };
    };
    await expect(again({ ...base, content: unlock(base.content) }, unlock(second.content))).rejects.toMatchObject(stale);
    // A hash rewritten to match rewritten protected text.
    const forged = await blockHash({ id: terms, definitionKey: "TextBlock", schemaVersion: 1, values: { markdown: "Other terms" }, references: {} });
    const rehash = (content: PreparedContent) => ({ ...edit(content, terms, "Other terms"), source: content.source.map((entry) => entry.id === terms ? { ...entry, hash: forged } : entry) });
    await expect(again({ ...base, content: rehash(base.content) }, rehash(second.content))).rejects.toMatchObject(stale);
    await expect(again({ ...base, content: { ...base.content, page: { format: "a3" } } })).rejects.toMatchObject(stale);
    // Another version or other inputs than the content was captured with.
    await expect(again({ ...base, version: { entity: "TemplateVersion", id: v1 } })).rejects.toMatchObject(stale);
    await expect(again({ ...base, parameters: { name: "Mallory" } })).rejects.toMatchObject(stale);
    // A true baseline, and a draft that rewrites or drops what it protects.
    await expect(again(base, edit(second.content, terms, "Other terms"))).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    await expect(again(base, { ...second.content, blocks: second.content.blocks.filter((block) => block.id !== terms) })).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    for (const baseline of [{ ...base, extra: true }, { ...base, version: { entity: "Template", id: template } }, { ...base, version: { entity: "TemplateVersion", id: "not-a-uuid" } }, { version: base.version, parameters: base.parameters }, "v2"])
      await expect(again(baseline)).rejects.toMatchObject({ operationError: { code: expect.stringMatching(/VALIDATION|DEPENDENCY_INVALID/) } });
    expect(f.writes()).toEqual([]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test("a true baseline of another source does not release what the saved copy protects", async () => {
    const { f, before } = await prepared();
    // Captured for real, as a new inclusion, from versions that do not hold the protected block of the saved copy.
    f.versions[v4] = [{ id: greeting, markdown: "Dear {{local.name}}" }, { id: closing, markdown: "Regards" }];
    f.versions[v5] = [{ id: greeting, markdown: "Dear {{local.name}}" }, { id: closing, markdown: "Bye" }];
    const loose = await f.prepare(v4, { parameters: { name: "Ada" } });
    expect(markdown(loose.content)).toEqual(["Dear Ada", "Regards"]);
    const protectedHere = { operationError: { code: "INVALID_STATE", message: expect.stringContaining("protected here") } };
    await expect(f.prepare(v5, { parameters: { name: "Ada" }, content: loose.content }, { blockId: before.id, baseline: loose.baseline })).rejects.toMatchObject(protectedHere);
    // Nor does a next source that drops it, from a baseline that still held it.
    const second = await f.prepare(v2, { parameters: { name: "Ada" } }, { blockId: before.id });
    await expect(f.prepare(v5, { parameters: { name: "Ada" }, content: second.content }, { blockId: before.id, baseline: second.baseline })).rejects.toMatchObject(protectedHere);
    expect(f.writes()).toEqual([]);
  });

  test("refuses another tenant's or host's block, a host the session may not change and a baseline source it may not read", async () => {
    const { f, before, second } = await prepared();
    const again = (locator: Record<string, unknown>) => f.prepare(v3, { parameters: second.parameters, content: second.content }, { blockId: before.id, baseline: second.baseline, ...locator });
    f.saved.set(id(60), { ...before, id: id(60), document_variant_id: id(61) });
    await expect(again({ blockId: id(60) })).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });
    // Another tenant's block is not found by this tenant's read.
    await expect(again({ blockId: id(62) })).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });
    await expect(again({ host: { entity: "DocumentVariant", id: id(61) } })).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });
    // Nothing of a source was read for a block that is not the caller's to prepare.
    expect(f.log.reads).toEqual([]);
    f.denied.add(documentVariant);
    await expect(again({})).rejects.toThrow("FORBIDDEN");
    expect(f.log.reads).toEqual([]);
    f.denied.clear();
    // The earlier source is read as this session; holding its baseline does not stand in for the right to read it.
    f.denied.add(v2);
    await expect(again({})).rejects.toThrow("FORBIDDEN");
    expect(f.log.authorized).not.toContain(`TemplateVersion:${v3}`);
    f.denied.clear();
    // A version that does not exist for this tenant.
    await expect(again({ baseline: { ...second.baseline, version: { entity: "TemplateVersion", id: id(99) } } })).rejects.toBeDefined();
    expect(f.writes()).toEqual([]);
  });

  test("refuses when a record the earlier preparation named has changed since, and writes nothing", async () => {
    const f = fixture();
    f.versions[v3] = [{ id: greeting, markdown: "Dear {{local.name}} of {{chips.brand}}" }, { id: terms, markdown: "Terms", locked: true }, { id: closing, markdown: "Regards" }];
    f.versions[v4] = [...f.versions[v3]!, { id: ps, markdown: "PS" }];
    const values = (await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } })))!;
    const before = f.row(v1, values);
    f.saved.set(before.id, before);
    const snapshot = JSON.stringify(before);
    const second = await f.prepare(v3, { parameters: { name: "Ada" }, content: values.content }, { blockId: before.id });
    expect(markdown(second.content)).toEqual(["Dear Ada of Acme", "Terms", "Regards"]);
    const mine = edit(second.content, closing, "Until soon");
    f.data.brand = "Globex";
    f.log.statements.length = 0;
    await expect(f.prepare(v4, { parameters: second.parameters, content: mine }, { blockId: before.id, baseline: second.baseline })).rejects.toMatchObject(stale);
    expect(f.writes()).toEqual([]);
    expect(JSON.stringify(before)).toBe(snapshot);
    // With the record as it was prepared, the same draft goes through unchanged.
    f.data.brand = "Acme";
    const third = await f.prepare(v4, { parameters: second.parameters, content: mine }, { blockId: before.id, baseline: second.baseline });
    expect(markdown(third.content)).toEqual(["Dear Ada of Acme", "Terms", "Until soon", "PS"]);
  });
});

describe("refreshing an inclusion whose version and inputs stay the same", () => {
  test("ordinary reads and edits never capture again; a prepared copy is the deliberate refresh", async () => {
    const f = fixture();
    f.versions[v3] = [{ id: greeting, markdown: "Dear {{local.name}} of {{chips.brand}}" }, { id: terms, markdown: "Terms", locked: true }, { id: closing, markdown: "Regards" }];
    const values = (await f.write(undefined, f.row(v3, { parameters: { name: "Ada" } })))!;
    const before = f.row(v3, values);
    f.saved.set(before.id, before);
    expect(markdown(values.content)).toEqual(["Dear Ada of Acme", "Terms", "Regards"]);
    f.data.brand = "Globex";
    f.log.reads.length = 0;
    // An edit with the same version and inputs keeps the stored record and text: the renamed value does not leak in.
    const edited = await f.write(before, f.row(v3, { parameters: values.parameters, content: edit(values.content, closing, "Bye") }), false);
    expect(markdown(edited!.content)).toEqual(["Dear Ada of Acme", "Terms", "Bye"]);
    expect(f.log.reads).toEqual([]);
    // Preparing with the same version and inputs captures again and keeps the local edit.
    const refreshed = await f.prepare(v3, { parameters: values.parameters, content: edit(values.content, closing, "Bye") }, { blockId: before.id });
    expect(markdown(refreshed.content)).toEqual(["Dear Ada of Globex", "Terms", "Bye"]);
    expect(f.writes()).toEqual([]);
    // Saving it is accepted because its record is what a capture yields now, and only then.
    const saved = await f.write(before, f.row(v3, { parameters: refreshed.parameters, content: refreshed.content }));
    expect(saved!.content).toEqual(refreshed.content);
    f.data.brand = "Initech";
    await expect(f.write(before, f.row(v3, { parameters: refreshed.parameters, content: refreshed.content }))).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("Prepare it again") } });
  });
});

describe("the session that captures", () => {
  test("an application or service session captures under its own authorization, and is refused where that ends", async () => {
    // The host hands the hook whatever verified tenant session is writing; nothing here is specific to a person.
    const f = fixture({ credential: "service" });
    const values = await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } }));
    expect(markdown(values!.content)).toEqual(["Dear Ada", "Terms", "Regards"]);
    expect(f.log.authorized).toEqual([`TemplateVersion:${v1}`, `Template:${template}`]);
    f.denied.add(v1);
    await expect(f.write(undefined, f.row(v1, { parameters: { name: "Ada" } }))).rejects.toThrow("FORBIDDEN");
    // No session at all is not a session with every right: the capture is unavailable.
    await expect(f.write(undefined, f.row(v1, { parameters: { name: "Ada" } }), false)).rejects.toMatchObject({ operationError: { code: "OPERATION_UNAVAILABLE" } });
  });
});

describe("retained provenance of a stored inclusion", () => {
  const provenance = { referenceField: "version", parametersField: "parameters" };

  test("only an update that repeats the stored version, inputs and source record keeps the source as provenance", async () => {
    const f = fixture();
    const values = (await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } })))!;
    const before = f.row(v1, values);
    const content = values.content as PreparedContent;
    expect(retainedInclusionProvenance(carrier, before, f.row(v1, { ...values, content: edit(content, greeting, "Hello Ada") }))).toEqual(provenance);
    expect(retainedInclusionProvenance(carrier, before, f.row(v1, { parameters: values.parameters }))).toEqual(provenance);
    // It is the same decision the write takes: such an update is settled without the acting session.
    await f.write(before, f.row(v1, { ...values, content: edit(content, greeting, "Hello Ada") }), false);

    // An insertion, another version, other inputs, a version left to a variable and a prepared record all read the source.
    expect(retainedInclusionProvenance(carrier, undefined, before)).toBeUndefined();
    expect(retainedInclusionProvenance(carrier, before, f.row(v2, values))).toBeUndefined();
    expect(retainedInclusionProvenance(carrier, before, f.row(v1, { ...values, parameters: { name: "Grace" } }))).toBeUndefined();
    expect(retainedInclusionProvenance(carrier, before, { ...f.row(v1, values), template_version_parameter: "chosen" })).toBeUndefined();
    const prepared = { ...content, source: content.source.map((entry) => entry.id === greeting ? { ...entry, hash: "0".repeat(64) } : entry) };
    expect(retainedInclusionProvenance(carrier, before, f.row(v1, { ...values, content: prepared }))).toBeUndefined();
    expect(retainedInclusionProvenance(carrier, before, f.row(v1, { ...values, content: { ...content, source: [] } }))).toBeUndefined();
  });

  test("the stored row decides: a row without a copy, another kind of block or another carrier retains nothing", async () => {
    const f = fixture();
    const values = (await f.write(undefined, f.row(v1, { parameters: { name: "Ada" } })))!;
    // A caller-supplied copy over a row that stores none.
    expect(retainedInclusionProvenance(carrier, f.row(v1, { parameters: values.parameters }), f.row(v1, values))).toBeUndefined();
    expect(retainedInclusionProvenance(carrier, { ...f.row(v1, values), definition_key: "TextBlock" }, f.row(v1, values))).toBeUndefined();
    expect(retainedInclusionProvenance(carrier, { ...f.row(v1, values), definition_key: "TextBlock" }, { ...f.row(v1, values), definition_key: "TextBlock" })).toBeUndefined();
    expect(retainedInclusionProvenance({ ...carrier, entityName: "Note" }, f.row(v1, values), f.row(v1, values))).toBeUndefined();
  });
});

describe("column writes use the canonical child contract",()=>{
 const child:ContentBlock={id:"supplier",definitionKey:"TextBlock",schemaVersion:1,values:{markdown:"Supplier"},references:{}};
 test("validates nested definitions, identities, references and page boundaries before storing",async()=>{
  const f=fixture();const row=(children:any[])=>({...f.row(v1,{}),definition_key:"TextColumns",values:{left:children}});
  expect(await f.write(undefined,row([child]))).toEqual({left:[child]});
  for(const children of [[child,child],[{...child,definitionKey:"Unknown"}],[{...child,definitionKey:"PageBreak"}],[{...child,references:{invented:{entity:"Deal",id:deal}}}]])await expect(f.write(undefined,row(children))).rejects.toBeDefined();
 });
 test("cannot remove or change a locked child through the enclosing columns",async()=>{
  const f=fixture();const before={...f.row(v1,{}),definition_key:"TextColumns",values:{left:[{...child,locked:true}]}};
  await expect(f.write(before,{...before,values:{left:[]}})).rejects.toBeDefined();
  await expect(f.write(before,{...before,values:{left:[{...child,locked:true,values:{markdown:"Changed"}}]}})).rejects.toBeDefined();
  await expect(assertBlockInclusionRemoval(carrier,before)).rejects.toBeDefined();
 });
});

test("a template maker may edit and set the locks of their own nested source blocks",async()=>{
 const f=fixture({host:"template"});const child={id:"supplier",definitionKey:"TextBlock",schemaVersion:1,values:{markdown:"Supplier"},references:{},locked:true};
 const row={...f.row(v1,{}),definition_key:"TextColumns",values:{left:[child]}};
 expect(await f.write(undefined,row)).toEqual(row.values);
 const changed={...row,values:{left:[{...child,values:{markdown:"Edited source"}}]}};
 expect(await f.write(row,changed)).toEqual(changed.values);
});

test("a locked columns row lets the document edit its open child and protects its structure", async () => {
  const f = fixture();
  const body: ContentBlock = { id: "body", definitionKey: "TextBlock", schemaVersion: 1, values: { markdown: "Body" }, references: {} };
  const terms: ContentBlock = { ...body, id: "terms", values: { markdown: "Terms" }, locked: true };
  const row = {
    ...f.row(v1, {}), locked: true, editable_children: true,
    definition_key: "TextColumns", values: { left: [body, terms], leftWidth: 200 },
  };
  const edited = { ...row, values: { ...row.values, left: [{ ...body, values: { markdown: "Edited" } }, terms] } };
  expect(await f.write(row, edited)).toEqual(edited.values);
  await expect(f.write(row, { ...edited, values: { ...edited.values, leftWidth: 220 } })).rejects.toBeDefined();
  await expect(f.write(row, { ...edited, values: { ...edited.values, left: [body, { ...terms, values: body.values }] } })).rejects.toBeDefined();
  await expect(f.write(row, { ...row, values: { ...row.values, left: [{ ...body, lockOverride: false }, terms] } })).rejects.toBeDefined();
  await expect(assertBlockInclusionRemoval(carrier, row)).rejects.toBeDefined();
});
