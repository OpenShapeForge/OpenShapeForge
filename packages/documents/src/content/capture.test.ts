// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { captureInclusionContent, captureTemplateBlocks, type CaptureHost } from "./capture.js";
import { blockHash, inclusionCopyContent, readInclusionCopy } from "./inclusion-copy.js";
import { materializeDocumentContent, materializeTemplateContent } from "./materialize.js";
import type { CompiledContentBlockRegistry, ContentBlock, ContentResolvers, ContentTemplateVersion, JsonObject, TemplateParameter } from "./index.js";
import { contentVariableCatalogue } from "./variables.js";

const tenantId = "tenant-example";
const registry: CompiledContentBlockRegistry = {
  // A plain text field that binds text, a Markdown body, a heading bound whole, and a typed block naming one record.
  Line: { entityName: "Line", schemaVersion: 1, fields: { text: { baseType: "string", required: true, variables: "template" } }, renderers: { document: "line" } },
  Prose: { entityName: "Prose", schemaVersion: 1, fields: { markdown: { osfType: "markdown", baseType: "string", required: true, variables: "template" } }, renderers: { document: "prose" } },
  Heading: { entityName: "Heading", schemaVersion: 1, fields: { title: { baseType: "string", required: true, variables: "both" } }, renderers: { document: "heading" } },
  DealSummary: {
    entityName: "DealSummary", schemaVersion: 1, renderers: { document: "dealSummary" },
    fields: { caption: { baseType: "string" }, deal: { osfType: "Deal", baseType: "string", cardinality: { min: 1, max: 1 }, variables: "whole", relationship: { target: "Deal" } } },
  },
  TemplateSlot: {
    entityName: "TemplateSlot", schemaVersion: 1, renderers: {},
    fields: { version: { baseType: "string", required: true, relationship: { target: "TemplateVersion" } }, parameters: { baseType: "object", variables: "both" }, content: { baseType: "object" } },
    composition: { templateVersionField: "version", parametersField: "parameters" },
  },
};
const dealParameter: TemplateParameter = { baseType: "string", required: true, relationship: { target: "Deal" } };
const block = (id: string, definitionKey: string, values: JsonObject, extra: Partial<ContentBlock> = {}): ContentBlock => ({ id, definitionKey, schemaVersion: 1, values, references: {}, ...extra });

function version(id: string, parameters: Record<string, TemplateParameter>, blocks: readonly ContentBlock[], page?: JsonObject): ContentTemplateVersion {
  return { id, tenantId, templateId: `${id}-template`, versionNumber: 1, parameters, variants: [{ id: `${id}-document`, channel: "document", locale: "en", blocks, ...(page ? { page } : {}) }] };
}

/** A letter that names the customer of a deal, a title, the deal itself as a typed block, and a page number. */
const letter = () => version("letter", { deal: dealParameter, title: { baseType: "string", defaultValue: "Proposal" } }, [
  block("intro", "Line", { text: "We will assess {{local.deal.customer.name}}" }),
  block("title", "Heading", { title: "{{local.title}}" }),
  block("summary", "DealSummary", { caption: "Deal" }, { references: { deal: { parameter: "deal" } } }),
  block("terms", "Prose", { markdown: "Terms for {{local.deal.customer.name}} apply." }, { locked: true }),
  block("folio", "Line", { text: "Page {{page.number}}" }, { region: "footer" }),
], { format: "a4" });

function fixture(names: Record<string, string> = { "deal-1": "Acme BV" }) {
  const versions: Record<string, ContentTemplateVersion> = { letter: letter() };
  const calls = { template: [] as string[], path: [] as string[], entity: [] as string[] };
  const denied = new Set<string>();
  const resolvers: ContentResolvers = {
    resolveTemplateVersion(id) { calls.template.push(id); return versions[id] ?? null; },
    resolveGlobalVariable: () => null,
    resolveEntity(reference) {
      calls.entity.push(reference.id);
      return denied.has(reference.id) ? null : { tenantId, entity: reference.entity, id: reference.id, versionId: "v1", value: { name: names[reference.id] ?? "" } };
    },
    resolveVariablePath(root, path) {
      calls.path.push(`${root.id}:${path}`);
      if (denied.has(root.id)) throw new Error("FORBIDDEN");
      return { root, path, shape: { baseType: "string", nullable: true }, value: names[root.id] ?? null, sources: [{ entity: root.entity, id: root.id, versionId: "v1" }] };
    },
  };
  const capture = (parameters: JsonObject, host: CaptureHost, templateVersionId = "letter") => captureInclusionContent(
    { tenantId, channel: "document", locale: "en", templateVersionId, parameters, parameterVariables: "both", host }, registry, resolvers);
  return { versions, calls, denied, names, resolvers, capture };
}
/** A document supplies every value it has; a template names its variables without values. */
const documentHost: CaptureHost = { catalogue: contentVariableCatalogue({}), parameters: {} };
const templateHost = (parameters: Record<string, TemplateParameter>): CaptureHost => ({ catalogue: contentVariableCatalogue(parameters) });
const texts = (blocks: readonly ContentBlock[]) => Object.fromEntries(blocks.map((entry) => [entry.id, entry.values.text ?? entry.values.title ?? entry.values.markdown ?? null]));

describe("capturing an inclusion into a document", () => {
  test("resolves a record path once, under the capturing resolvers, into ordinary text", async () => {
    const f = fixture();
    const { copy, parameters, authored } = await f.capture({ deal: "deal-1" }, documentHost);
    expect(texts(copy.blocks)).toEqual({ intro: "We will assess Acme BV", title: "Proposal", summary: null, terms: "Terms for Acme BV apply.", folio: "Page {{page.number}}" });
    expect(parameters).toEqual({ deal: "deal-1" });
    // The typed block keeps its definition and a concrete reference; it is not flattened into text.
    expect(copy.blocks[2]).toMatchObject({ definitionKey: "DealSummary", values: { caption: "Deal" }, references: { deal: { entity: "Deal", id: "deal-1" } } });
    expect(copy.page).toEqual({ format: "a4" });
    expect(copy.blocks[4]!.region).toBe("footer");
    // One read per record and path, however often the text names it.
    expect(f.calls.path).toEqual(["deal-1:customer.name"]);
    expect(f.calls.entity).toEqual(["deal-1"]);
    // The source record is the server's: source order, the hash of each block as resolved, and the source's lock.
    expect(copy.source.map((entry) => entry.id)).toEqual(["intro", "title", "summary", "terms", "folio"]);
    for (const [index, entry] of copy.source.entries()) expect(entry.hash).toBe(await blockHash(copy.blocks[index]!));
    expect(copy.source.filter((entry) => entry.locked).map((entry) => entry.id)).toEqual(["terms"]);
    expect(copy.source.some((entry) => entry.deferred)).toBe(false);
    expect(authored[0]!.values.text).toBe("We will assess {{local.deal.customer.name}}");
  });

  test("a later change of the record or the source leaves the captured copy as it is", async () => {
    const f = fixture();
    const first = await f.capture({ deal: "deal-1" }, documentHost);
    f.names["deal-1"] = "Renamed BV";
    f.versions.letter = version("letter", { deal: dealParameter }, [block("intro", "Line", { text: "Changed source" })]);
    const host = documentWith(inclusion("slot", first));
    f.calls.template.length = 0; f.calls.path.length = 0;
    const read = await materializeDocumentContent(host, registry, f.resolvers);
    expect(read.blocks[0]!.values.text).toBe("We will assess Acme BV");
    // Reading the copy opens neither the source template nor the record its text was resolved from.
    expect(f.calls.template).toEqual([]);
    expect(f.calls.path).toEqual([]);
  });

  test("a value that reads like a variable is captured as text and never bound again", async () => {
    const f = fixture({ "deal-1": "{{local.title}} {{chips.secret}}" });
    const captured = await f.capture({ deal: "deal-1", title: "{{page.number}}" }, { ...documentHost });
    expect(captured.copy.blocks[0]!.values.text).toBe("We will assess {{local.title}} {{chips.secret}}");
    // A Markdown destination escapes the value, so it cannot become syntax there either.
    expect(captured.copy.blocks[3]!.values.markdown).toBe("Terms for \\{\\{local\\.title\\}\\} \\{\\{chips\\.secret\\}\\} apply.");
    const read = await materializeDocumentContent(documentWith(inclusion("slot", captured)), registry, { ...f.resolvers, resolveGlobalVariable: () => { throw new Error("A captured value was bound again."); } });
    expect(read.blocks[0]!.values.text).toBe("We will assess {{local.title}} {{chips.secret}}");
    expect(read.blocks[4]!.values.text).toBe("Page {{page.number}}");
  });

  test("a typed block is executed on every read, under the reader, from its concrete reference", async () => {
    const f = fixture();
    const host = documentWith(inclusion("slot", await f.capture({ deal: "deal-1" }, documentHost)));
    f.calls.entity.length = 0;
    const executed: unknown[] = [];
    const materializeBlock: NonNullable<ContentResolvers["materializeBlock"]> = async (input) => {
      if (input.definitionKey === "DealSummary") executed.push((input.references.deal as { value: JsonObject }).value);
      return { operationId: `${input.definitionKey}.materialize`, result: { kind: "block", value: input.values } };
    };
    const read = await materializeDocumentContent(host, registry, { ...f.resolvers, materializeBlock });
    expect(read.blocks[2]!.references.deal).toMatchObject({ entity: "Deal", id: "deal-1", value: { name: "Acme BV" } });
    expect(executed).toEqual([{ name: "Acme BV" }]);
    // Independence of the text does not carry over to the record: a reader who may not open it is refused.
    f.denied.add("deal-1");
    await expect(materializeDocumentContent(host, registry, { ...f.resolvers, materializeBlock })).rejects.toMatchObject({ code: "DEPENDENCY_UNRESOLVED" });
    expect(f.calls.entity).toEqual(["deal-1", "deal-1"]);
  });

  test("a missing, unknown or unreadable input refuses the whole capture", async () => {
    const f = fixture();
    await expect(f.capture({}, documentHost)).rejects.toMatchObject({ code: "MISSING_VARIABLE" });
    await expect(f.capture({ deal: "deal-1", other: "x" }, documentHost)).rejects.toMatchObject({ code: "INVALID_VALUE" });
    // A document has no variable to leave an input to.
    await expect(f.capture({ deal: "{{local.opportunity}}" }, documentHost)).rejects.toMatchObject({ code: "MISSING_VARIABLE" });
    f.denied.add("deal-1");
    await expect(f.capture({ deal: "deal-1" }, documentHost)).rejects.toThrow("FORBIDDEN");
    await expect(f.capture({ deal: "deal-1" }, documentHost, "absent")).rejects.toMatchObject({ code: "DEPENDENCY_UNRESOLVED" });
    f.versions.foreign = { ...letter(), id: "foreign", tenantId: "other-tenant" };
    await expect(f.capture({ deal: "deal-1" }, documentHost, "foreign")).rejects.toMatchObject({ code: "DEPENDENCY_INVALID" });
  });

  test("a source that still holds a reference-only inclusion is refused by name; a plain older version is captured", async () => {
    const f = fixture();
    f.versions.plain = version("plain", {}, [block("only", "Line", { text: "Plain" })]);
    expect((await f.capture({}, documentHost, "plain")).copy.blocks[0]!.values.text).toBe("Plain");
    f.versions.sparse = version("sparse", {}, [block("slot", "TemplateSlot", { parameters: {}, content: { blocks: [{ id: "only" }] } }, { references: { version: { entity: "TemplateVersion", id: "plain" } } })]);
    await expect(f.capture({}, documentHost, "sparse")).rejects.toMatchObject({ code: "DEPENDENCY_INVALID", message: expect.stringContaining("republish the template") });
  });
});

describe("capturing into a template that supplies the input later", () => {
  const host = templateHost({ opportunity: dealParameter, client: { baseType: "string" } });

  test("a concrete input resolves what depends on it; an input bound to a host variable stays pending in the host's scope", async () => {
    const f = fixture();
    const { copy, parameters } = await f.capture({ deal: "{{local.opportunity}}", title: "Offer" }, host);
    expect(texts(copy.blocks)).toMatchObject({ intro: "We will assess {{local.opportunity.customer.name}}", title: "Offer", terms: "Terms for {{local.opportunity.customer.name}} apply." });
    expect(copy.blocks[2]!.references).toEqual({ deal: { parameter: "opportunity" } });
    expect(parameters).toEqual({ deal: "{{local.opportunity}}", title: "Offer" });
    expect(copy.source.filter((entry) => entry.deferred).map((entry) => entry.id)).toEqual(["intro", "summary", "terms"]);
    // Nothing of a record nobody named yet was read.
    expect(f.calls.path).toEqual([]);
    expect(f.calls.entity).toEqual([]);
  });

  test("text of the host handed on as an input is spliced where the included template prints it", async () => {
    const f = fixture();
    const { copy } = await f.capture({ deal: "deal-1", title: "Offer for {{local.client}}" }, host);
    expect(texts(copy.blocks)).toMatchObject({ intro: "We will assess Acme BV", title: "Offer for {{local.client}}" });
    expect(copy.source.filter((entry) => entry.deferred).map((entry) => entry.id)).toEqual(["title"]);
  });

  test("refuses a variable the host does not have, and a pending block that would also hold a brace-shaped value", async () => {
    const f = fixture({ "deal-1": "{{odd}}" });
    await expect(f.capture({ deal: "{{local.absent}}" }, host)).rejects.toMatchObject({ code: "MISSING_VARIABLE" });
    f.versions.mixed = version("mixed", { deal: dealParameter, title: { baseType: "string" } }, [block("both", "Line", { text: "{{local.title}} for {{local.deal.customer.name}}" })]);
    await expect(f.capture({ deal: "deal-1", title: "{{local.client}}" }, host, "mixed")).rejects.toMatchObject({ code: "INVALID_VALUE", message: expect.stringContaining("still to be supplied") });
    // The same value alone, with nothing pending beside it, is ordinary captured text.
    expect((await f.capture({ deal: "deal-1", title: "Fixed" }, host, "mixed")).copy.blocks[0]!.values.text).toBe("Fixed for {{odd}}");
  });

  test("a document made from that template resolves the remaining scope once, without opening the included source", async () => {
    const f = fixture();
    const captured = await f.capture({ deal: "{{local.opportunity}}", title: "Offer" }, host);
    const proposal = version("proposal", { opportunity: dealParameter }, [
      block("opening", "Line", { text: "Dear {{local.opportunity.customer.name}}" }),
      inclusion("slot", captured),
    ]);
    f.calls.template.length = 0;
    const blocks = await captureTemplateBlocks({ tenantId, channel: "document", locale: "en", version: proposal, variantId: "proposal-document", parameters: { opportunity: "deal-1" } }, registry, f.resolvers);
    expect(blocks[0]!.values.text).toBe("Dear Acme BV");
    const copy = readInclusionCopy(blocks[1]!.values.content);
    expect(texts(copy.blocks)).toMatchObject({ intro: "We will assess Acme BV", title: "Offer", terms: "Terms for Acme BV apply." });
    expect(copy.blocks[2]!.references).toEqual({ deal: { entity: "Deal", id: "deal-1" } });
    expect(blocks[1]!.values.parameters).toEqual({ deal: "deal-1", title: "Offer" });
    // The document's copy has its own source record: nothing pending, the locks kept, the hashes of what it holds now.
    expect(copy.source.some((entry) => entry.deferred)).toBe(false);
    expect(copy.source.filter((entry) => entry.locked).map((entry) => entry.id)).toEqual(["terms"]);
    for (const [index, entry] of copy.source.entries()) expect(entry.hash).toBe(await blockHash(copy.blocks[index]!));
    expect(f.calls.template).toEqual([]);
    // Missing the input, the document gets nothing rather than a half-filled copy.
    await expect(captureTemplateBlocks({ tenantId, channel: "document", locale: "en", version: proposal, variantId: "proposal-document", parameters: {} }, registry, f.resolvers)).rejects.toMatchObject({ code: "MISSING_VARIABLE" });
  });
});

describe("what is data and what is a variable in a copy", () => {
  const host = templateHost({ opportunity: dealParameter, client: { baseType: "string" } });
  /** A Markdown paragraph and a plain line that each print the customer; the paragraph also prints the title. */
  const mixed = () => version("mixed", { deal: dealParameter, title: { baseType: "string" } }, [
    block("paragraph", "Prose", { markdown: "For {{local.deal.customer.name}}, by {{local.title}}" }),
    block("line", "Line", { text: "{{local.deal.customer.name}}" }),
  ]);
  const hostTemplate = (...blocks: ContentBlock[]) => version("host", { client: { baseType: "string" } }, blocks);
  const read = (f: ReturnType<typeof fixture>, parameters: JsonObject) => materializeTemplateContent({ tenantId, templateVersionId: "host", channel: "document", locale: "en", parameters }, registry, f.resolvers);

  test("Markdown keeps a captured value that reads like a variable next to one that is still pending", async () => {
    const f = fixture({ "deal-1": "{{local.client}} & co" });
    f.versions.mixed = mixed();
    const captured = await f.capture({ deal: "deal-1", title: "{{local.client}}" }, host, "mixed");
    // Not refused: the value is escaped, which Markdown prints as the same text and the variable grammar never matches.
    expect(captured.copy.blocks[0]!.values.markdown).toBe("For \\{\\{local\\.client\\}\\} \\& co, by {{local.client}}");
    expect(captured.copy.blocks[1]!.values.text).toBe("{{local.client}} & co");
    expect(captured.copy.source.map((entry) => entry.deferred ?? false)).toEqual([true, false]);
    f.versions.host = hostTemplate(inclusion("slot", captured, "mixed"));
    const content = await read(f, { client: "Hedy" });
    // Only the pending variable is filled. The customer's name stays the customer's name, in both fields.
    expect(content.blocks[0]!.values.markdown).toBe("For \\{\\{local\\.client\\}\\} \\& co, by Hedy");
    expect(content.blocks[1]!.values.text).toBe("{{local.client}} & co");
  });

  test("a variable the template's author writes into copied Markdown works; captured values around it stay data", async () => {
    const f = fixture({ "deal-1": "{{local.client}}" });
    const captured = await f.capture({ deal: "deal-1" }, host);
    expect(captured.copy.source.some((entry) => entry.deferred)).toBe(false);
    // The author edits the copied terms and the copied plain line, and adds a paragraph of their own.
    const edited = captured.copy.blocks.map((entry) => entry.id === "terms" ? { ...entry, locked: undefined, values: { markdown: `${entry.values.markdown} Signed, {{local.client}}.` } }
      : entry.id === "intro" ? { ...entry, values: { text: `${entry.values.text} — {{local.client}}` } } : entry).map(({ locked: _locked, ...entry }) => entry as ContentBlock);
    const copy = { ...captured.copy, blocks: [...edited, block("own", "Line", { text: "Added for {{local.client}}" })] };
    f.versions.host = hostTemplate(inclusion("slot", { copy, parameters: captured.parameters }));
    const content = await read(f, { client: "Hedy" });
    const values = Object.fromEntries(content.blocks.map((entry) => [entry.id, entry.values.markdown ?? entry.values.text]));
    // Markdown: the new variable is bound, the captured name before it is still text.
    expect(values.terms).toBe("Terms for \\{\\{local\\.client\\}\\} apply. Signed, Hedy.");
    // The author's own block is the template's content like any other.
    expect(values.own).toBe("Added for Hedy");
    // A plain field has no spelling for a brace that is data, so a captured plain field stays data as a whole:
    // a variable typed into it later is text. That is the one place authoring a variable needs a block of its own.
    expect(values.intro).toBe("We will assess {{local.client}} — {{local.client}}");
  });

  test("a document holds no variable: text typed into a copy is text, whoever typed it", async () => {
    const f = fixture();
    const captured = await f.capture({ deal: "deal-1" }, documentHost);
    const blocks = [
      ...captured.copy.blocks.map((entry) => entry.id === "intro" ? { ...entry, values: { text: "We assess {{Acme}} — see {{local.title}}" } } : entry),
      block("typed", "Prose", { markdown: "A new paragraph about {{braces}} and {{chips.brand}}" }),
      block("typed-line", "Line", { text: "{{local.deal.customer.name}}" }),
    ];
    const strict = { ...f.resolvers, resolveGlobalVariable: () => { throw new Error("Text of a document was bound."); }, resolveVariablePath: () => { throw new Error("Text of a document was bound."); } };
    const content = await materializeDocumentContent(documentWith(inclusion("slot", { copy: { ...captured.copy, blocks }, parameters: captured.parameters })), registry, strict);
    const values = Object.fromEntries(content.blocks.map((entry) => [entry.id, entry.values.markdown ?? entry.values.text]));
    expect(values).toMatchObject({ intro: "We assess {{Acme}} — see {{local.title}}", typed: "A new paragraph about {{braces}} and {{chips.brand}}", "typed-line": "{{local.deal.customer.name}}", folio: "Page {{page.number}}" });
    // The same copy under a document linked to a template is read the same way.
    f.versions.host = hostTemplate(inclusion("slot", { copy: { ...captured.copy, blocks }, parameters: captured.parameters }));
    const linked = await materializeTemplateContent({ document: true, tenantId, templateVersionId: "host", channel: "document", locale: "en", parameters: { client: "Hedy" } }, registry, strict);
    expect(linked.blocks.find((entry) => entry.id === "typed")!.values.markdown).toBe("A new paragraph about {{braces}} and {{chips.brand}}");
  });

  test("a Markdown value bound whole keeps its formatting; only its brace pairs are escaped", async () => {
    const f = fixture();
    f.versions.whole = version("whole", { note: { osfType: "markdown", baseType: "string" } }, [block("paragraph", "Prose", { markdown: "{{local.note}}" })]);
    const both = { ...registry, Prose: { ...registry.Prose!, fields: { markdown: { ...registry.Prose!.fields.markdown!, variables: "both" as const } } } };
    // The input is given without a variable mode, so it is a literal: Markdown that happens to hold a brace pair.
    const captured = await captureInclusionContent({ tenantId, channel: "document", locale: "en", templateVersionId: "whole", parameters: { note: "**Note** on {{not.a.variable}}" }, host: documentHost }, both, f.resolvers);
    expect(captured.copy.blocks[0]!.values.markdown).toBe("**Note** on \\{\\{not.a.variable\\}\\}");
  });
});

function inclusion(id: string, captured: { copy: Parameters<typeof inclusionCopyContent>[0]; parameters: JsonObject }, source = "letter"): ContentBlock {
  return block(id, "TemplateSlot", { parameters: captured.parameters, content: inclusionCopyContent(captured.copy) }, { references: { version: { entity: "TemplateVersion", id: source } } });
}
function documentWith(...blocks: ContentBlock[]) {
  return { tenantId, documentId: "document-1", channel: "document", locale: "en", variants: [{ id: "variant-1", channel: "document", locale: "en", blocks }] };
}

describe("ordinary blocks nested in columns", () => {
  const columnRegistry: CompiledContentBlockRegistry = {...registry,TextColumns:{entityName:"TextColumns",schemaVersion:1,renderers:{document:"columns"},fields:{left:{baseType:"object",cardinality:"collection"},right:{baseType:"object",cardinality:"collection"}}}};
  test("never reinterprets captured plain values when another column child stays pending", async () => {
    const f=fixture();
    f.versions.columns=version("columns",{plain:{baseType:"string"},pending:{baseType:"string"}},[block("row","TextColumns",{left:[block("plain","Line",{text:"{{local.plain}}"}),block("pending","Line",{text:"{{local.pending}}"})] as never})]);
    await expect(captureInclusionContent({tenantId,channel:"document",locale:"en",templateVersionId:"columns",parameters:{plain:"{{unknown.value}}",pending:"{{local.later}}"},parameterVariables:"both",host:templateHost({later:{baseType:"string"}})},columnRegistry,f.resolvers)).rejects.toBeDefined();
  });
  test("captures variables inside each child and materializes the typed children under the reader", async () => {
    const f=fixture();
    f.versions.columns=version("columns",{},[block("row","TextColumns",{left:[block("prose","Prose",{markdown:"Hello"}),block("typed","DealSummary",{caption:"Scope"},{references:{deal:{entity:"Deal",id:"deal-1"}}})] as never})]);
    const result=await captureInclusionContent({tenantId,channel:"document",locale:"en",templateVersionId:"columns",parameters:{},host:documentHost},columnRegistry,f.resolvers);
    expect((result.copy.blocks[0]!.values.left as unknown as ContentBlock[])[1]!.references.deal).toEqual({entity:"Deal",id:"deal-1"});
    const content=await materializeDocumentContent({tenantId,channel:"document",locale:"en",documentId:"doc",variants:[{id:"v",channel:"document",locale:"en",blocks:result.copy.blocks}]},columnRegistry,f.resolvers);
    expect(content.blocks[0]!.columns!.left!.map(item=>item.definitionKey)).toEqual(["Prose","DealSummary"]);
    expect(f.calls.entity).toContain("deal-1");
  });
});

test("a proposal lock protects the container and inherited blocks, with editable exceptions and immutable source locks", async () => {
  const f = fixture();
  const source = await f.capture({ deal: "deal-1" }, documentHost);
  const enclosing = inclusion("slot", {
    ...source,
    copy: {
      ...source.copy,
      blocks: source.copy.blocks.map(child =>
        child.id === "intro" || child.id === "terms" ? { ...child, lockOverride: false } : child),
    },
  });
  const proposal = version("proposal", {}, [{ ...enclosing, lockOverride: true }]);
  const [captured] = await captureTemplateBlocks({
    tenantId, channel: "document", locale: "en", version: proposal,
    variantId: "proposal-document", parameters: {},
  }, registry, f.resolvers);
  expect(captured).toMatchObject({ locked: true, editableChildren: true });
  const copy = readInclusionCopy(captured!.values.content);
  expect(copy.blocks.map(child => [child.id, child.locked])).toEqual([
    ["intro", undefined], ["title", true], ["summary", true], ["terms", true], ["folio", true],
  ]);
  expect(copy.blocks.every(child => child.lockOverride === undefined)).toBe(true);
});
