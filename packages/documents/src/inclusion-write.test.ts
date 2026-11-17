// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { ModuleOperationContext, RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import { blockHash, readInclusionCopy } from "./content/inclusion-copy.js";
import type { JsonObject } from "./content/json.js";
import type { ContentBlock } from "./content/types.js";
import { composeTemplate } from "./inclusion-prepare.js";
import { assertBlockInclusionRemoval, prepareBlockInclusionWrite, type InclusionActor } from "./inclusion-write.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenant = id(1), template = id(2), variant = id(3), hostVariant = id(4), documentVariant = id(5), deal = id(6);
const v1 = id(11), v2 = id(12), v3 = id(13), greeting = id(21), terms = id(22), closing = id(23), added = id(24), chip = id(8);
const carrier = {
  entityName: "Block", fieldKey: "values", definitionField: "definitionKey", schema: "erp", table: "blocks", definitionColumn: "definition_key", valuesColumn: "values",
  definitions: {
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
      entityValues: { get: () => carrier, collection: () => ({ targetEntity: "Block", allowedDefinitions: ["TextBlock", "TemplateBlock"] }) },
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
  const prepare = async (version: string, values: Record<string, unknown>, locator: { blockId?: string; path?: string[]; host?: unknown } = {}) =>
    ((await composeTemplate({ definitionKey: "TemplateBlock", referenceField: "version", parametersField: "parameters", values, references: { version: { entity: "TemplateVersion", id: version } }, host, ...locator }, context)) as { value: { kind: string; referenceField: string; version: unknown; parameters: Record<string, unknown>; content: PreparedContent } }).value;
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
    await expect(f.prepare(v2, values, { blockId: before.id, path: ["absent", "deeper"] })).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });
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
    // A draft is checked against the stored record before anything is merged, and a prepared copy is not prepared again.
    await expect(f.prepare(v2, { parameters: { name: "Ada" }, content: edit(values.content, terms, "Other terms") }, { blockId: before.id })).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    await expect(f.prepare(v2, { parameters: { name: "Ada" }, content: prepared.content }, { blockId: before.id })).rejects.toMatchObject({ operationError: { code: "INVALID_STATE", message: expect.stringContaining("already prepared") } });
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
