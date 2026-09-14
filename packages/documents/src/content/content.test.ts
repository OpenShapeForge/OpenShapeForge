// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  canonicalJson,
  CONTENT_LIMITS,
  defineContentTemplateVersion,
  hashCanonicalJson,
  materializeTemplateContent,
  resolveTemplateParameters,
  TemplateContentError,
  validateContentRegistry,
  type CompiledContentBlockRegistry,
  type ContentBlock,
  type ContentResolvers,
  type ContentTemplateVersion,
  type JsonObject,
  type MaterializeTemplateContentInput,
} from "./index.js";

const tenantId = "tenant-example";
const metadata: CompiledContentBlockRegistry = {
  TextSection: {
    entityName: "TextSection",
    schemaVersion: 3,
    fields: { body: { semanticType: "richText", valueType: "string", required: true } },
    renderers: { document: "richText", email: "emailText", whatsapp: "plainText" },
  },
  RecordSummary: {
    entityName: "RecordSummary",
    schemaVersion: 3,
    fields: {
      heading: { valueType: "string", required: true },
      record: {
        semanticType: "ExampleRecord",
        valueType: "string",
        cardinality: { min: 1, max: 1 },
        relationship: { target: "ExampleRecord" },
      },
    },
    renderers: { document: "recordSummary" },
  },
  TemplateSlot: {
    entityName: "TemplateSlot",
    schemaVersion: 3,
    fields: {
      version: { valueType: "string", required: true, relationship: { target: "TemplateVersion" } },
      parameters: { valueType: "object" },
    },
    renderers: {},
    composition: { templateVersionField: "version", parametersField: "parameters" },
  },
};

function text(
  id = "text",
  body = "Hello {{local.name}} from {{global.brand.name}}.",
): ContentBlock {
  return { id, definitionKey: "TextSection", schemaVersion: 3, values: { body }, references: {} };
}

function include(id: string, templateId: string, parameters: JsonObject = {}): ContentBlock {
  return {
    id,
    definitionKey: "TemplateSlot",
    schemaVersion: 3,
    values: { parameters },
    references: { version: { entity: "TemplateVersion", id: templateId } },
  };
}

function version(id: string, blocks: readonly ContentBlock[]): ContentTemplateVersion {
  return {
    id,
    tenantId,
    templateId: `${id}-template`,
    versionNumber: 1,
    parameters: { name: { valueType: "string", defaultValue: "Reader" } },
    variants: ["document", "email", "whatsapp"].map((channel) => ({
      id: `${id}-${channel}`,
      channel,
      locale: "en",
      blocks,
    })),
  };
}

function fixture(blocks: readonly ContentBlock[] = [text()]) {
  const versions: Record<string, ContentTemplateVersion> = { root: version("root", blocks) };
  const registry: Record<string, CompiledContentBlockRegistry[string]> = structuredClone(metadata);
  const calls = { global: 0, entity: 0, template: 0 };
  const resolvers: ContentResolvers = {
    resolveTemplateVersion(id, context) {
      calls.template++;
      expect(context.tenantId).toBe(tenantId);
      return versions[id] ?? null;
    },
    resolveGlobalVariable(key, context) {
      calls.global++;
      expect(key).toBe("brand.name");
      expect(context.tenantId).toBe(tenantId);
      return { tenantId, sourceId: "brand", sourceVersionId: "brand-v1", value: "Example" };
    },
    resolveEntity(reference, context) {
      calls.entity++;
      expect(context.tenantId).toBe(tenantId);
      return {
        tenantId,
        entity: reference.entity,
        id: reference.id,
        versionId: "record-v1",
        value: { title: "Example record" },
      };
    },
  };
  const request: MaterializeTemplateContentInput = {
    tenantId,
    templateVersionId: "root",
    channel: "document",
    locale: "en",
  };
  return {
    versions,
    registry,
    resolvers,
    request,
    calls,
    run: () => materializeTemplateContent(request, registry, resolvers),
  };
}

async function rejectsCode(work: Promise<unknown>, code: TemplateContentError["code"]) {
  try {
    await work;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateContentError);
    expect((error as TemplateContentError).code).toBe(code);
  }
}

describe("canonical content snapshots", () => {
  test("canonicalization sorts objects but preserves collection order", async () => {
    expect(canonicalJson({ z: 1, a: [2, 1] })).toBe('{"a":[2,1],"z":1}');
    expect(await hashCanonicalJson({ b: true, a: 1 })).toBe(
      await hashCanonicalJson({ a: 1, b: true }),
    );
    expect(await hashCanonicalJson([1, 2])).not.toBe(await hashCanonicalJson([2, 1]));
  });

  test.each([
    NaN,
    Infinity,
    undefined,
    new Date(),
    new Map(),
    [undefined],
    new Array(2),
    { value: undefined },
  ])("rejects non-JSON input %#", (value) => {
    expect(() => canonicalJson(value)).toThrow(TemplateContentError);
  });

  test("rejects cyclic JSON and limits deeply nested JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("cyclic");
    let value: unknown = {};
    for (let index = 0; index < CONTENT_LIMITS.jsonDepth + 1; index++) value = { value };
    expect(() => canonicalJson(value)).toThrow("budget");
  });

  test("creates byte-identical, deeply frozen independent snapshots", async () => {
    const f = fixture();
    const first = await f.run();
    const second = await f.run();
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.blocks[0]!.values.body).toBe("Hello Reader from Example.");
    expect(Object.isFrozen(first.blocks[0]!.values)).toBe(true);
    expect(Object.isFrozen(first.templates[0]!.version.variants)).toBe(true);
    f.versions.root = version("root", [text("replacement", "Changed")]);
    const refreshed = await f.run();
    expect(refreshed.blocks[0]!.values.body).toBe("Changed");
    expect(first.blocks[0]!.values.body).toBe("Hello Reader from Example.");
    expect(refreshed.compositionHash).not.toBe(first.compositionHash);
  });

  test("uses collection order and changes the hash after a reorder", async () => {
    const f = fixture([text("one", "First"), text("two", "Second")]);
    const first = await f.run();
    f.versions.root = version("root", [text("two", "Second"), text("one", "First")]);
    const second = await f.run();
    expect(second.blocks.map((block) => block.id)).toEqual(["two", "one"]);
    expect(first.compositionHash).not.toBe(second.compositionHash);
  });

  test("captures only the selected channel source and strips extra resolver metadata", async () => {
    const f = fixture();
    f.versions.root = {
      ...f.versions.root!,
      variants: f.versions.root!.variants.map((variant) =>
        variant.channel === "email"
          ? { ...variant, blocks: [text("unselected", "Unselected channel content")] }
          : variant,
      ),
    };
    const snapshot = await materializeTemplateContent(f.request, f.registry, {
      ...f.resolvers,
      resolveGlobalVariable: () => ({
        tenantId,
        sourceId: "brand",
        sourceVersionId: "v1",
        value: "Example",
        transportMetadata: "Not content",
      }),
    });
    expect(snapshot.templates[0]!.version.variants.map((variant) => variant.channel)).toEqual([
      "document",
    ]);
    expect(canonicalJson(snapshot)).not.toContain("Unselected channel content");
    expect(canonicalJson(snapshot)).not.toContain("transportMetadata");
  });
});

describe("template variants and local/global variables", () => {
  test.each(["document", "email", "whatsapp"])(
    "selects exact %s/locale variant and compiled renderer",
    async (channel) => {
      const f = fixture();
      const snapshot = await materializeTemplateContent(
        { ...f.request, channel },
        f.registry,
        f.resolvers,
      );
      expect(snapshot.templates[0]!.variantId).toBe(`root-${channel}`);
      expect(snapshot.blocks[0]!.renderer).toBe(metadata.TextSection!.renderers[channel]!);
    },
  );

  test("does not silently fall back to a different channel or locale", async () => {
    const f = fixture();
    await rejectsCode(
      materializeTemplateContent({ ...f.request, channel: "sms" }, f.registry, f.resolvers),
      "UNSUPPORTED_CHANNEL",
    );
    await rejectsCode(
      materializeTemplateContent({ ...f.request, locale: "nl" }, f.registry, f.resolvers),
      "UNSUPPORTED_LOCALE",
    );
  });

  test("rejects duplicate channels/locales, variant ids and block ids", () => {
    const base = version("root", [text()]);
    expect(() =>
      defineContentTemplateVersion({ ...base, variants: [base.variants[0]!, base.variants[0]!] }),
    ).toThrow("unique");
    expect(() => defineContentTemplateVersion(version("root", [text(), text()]))).toThrow("unique");
    expect(() => defineContentTemplateVersion({ ...base, variants: [] })).toThrow("at least one");
  });

  test("validates defaults, required parameters, unknown parameters and enum values", () => {
    const definitions = {
      count: { valueType: "integer" as const, required: true },
      tone: { valueType: "string" as const, enum: ["formal"], defaultValue: "formal" },
    };
    expect(resolveTemplateParameters(definitions, { count: 2 })).toEqual({
      count: 2,
      tone: "formal",
    });
    expect(() => resolveTemplateParameters(definitions, {})).toThrow("required");
    expect(() => resolveTemplateParameters(definitions, { count: "2" })).toThrow("integer");
    expect(() => resolveTemplateParameters(definitions, { count: 2, extra: true })).toThrow(
      "unsupported",
    );
    expect(() => resolveTemplateParameters(definitions, { count: 2, tone: "casual" })).toThrow(
      "allowed",
    );
  });

  test("preserves typed whole-token values and validates cardinality after substitution", async () => {
    const f = fixture([
      {
        id: "stats",
        definitionKey: "Numbers",
        schemaVersion: 3,
        values: { amount: "{{local.amount}}", counts: "{{local.counts}}" },
        references: {},
      },
    ]);
    f.registry.Numbers = {
      entityName: "Numbers",
      schemaVersion: 3,
      fields: {
        amount: { valueType: "number" },
        counts: { valueType: "integer", cardinality: { min: 1, max: 3 } },
      },
      renderers: { document: "numbers" },
    };
    f.versions.root = {
      ...f.versions.root!,
      parameters: {
        amount: { valueType: "number", defaultValue: 2.5 },
        counts: { valueType: "integer", cardinality: "collection", defaultValue: [2, 1] },
      },
    };
    const snapshot = await f.run();
    expect(snapshot.blocks[0]!.values).toEqual({ amount: 2.5, counts: [2, 1] });
    await rejectsCode(
      materializeTemplateContent(
        { ...f.request, parameters: { counts: [] } },
        f.registry,
        f.resolvers,
      ),
      "INVALID_VALUE",
    );
  });

  test("rejects missing variables and caches each resolved global once", async () => {
    const f = fixture([text("one"), text("two")]);
    await f.run();
    expect(f.calls.global).toBe(1);
    await rejectsCode(
      materializeTemplateContent(f.request, f.registry, {
        ...f.resolvers,
        resolveGlobalVariable: () => null,
      }),
      "MISSING_VARIABLE",
    );
    f.versions.root = version("root", [text("missing", "{{local.notProvided}}")]);
    await rejectsCode(f.run(), "MISSING_VARIABLE");
  });

  test("resolved values are data, not recursively evaluated template expressions", async () => {
    const f = fixture([text("raw", "{{local.name}}")]);
    const snapshot = await materializeTemplateContent(
      { ...f.request, parameters: { name: "{{global.secret}}" } },
      f.registry,
      f.resolvers,
    );
    expect(snapshot.blocks[0]!.values.body).toBe("{{global.secret}}");
    expect(f.calls.global).toBe(0);
  });

  test.each(["{{name}}", "{{local.name", "{{global.x()}}"])(
    "rejects invalid variable syntax %s",
    async (body) => {
      await rejectsCode(fixture([text("syntax", body)]).run(), "INVALID_VALUE");
    },
  );

  test("rejects object substitution in inline text", async () => {
    const f = fixture();
    await rejectsCode(
      materializeTemplateContent(f.request, f.registry, {
        ...f.resolvers,
        resolveGlobalVariable: () => ({
          tenantId,
          sourceId: "brand",
          sourceVersionId: "v1",
          value: { name: "Example" },
        }),
      }),
      "INVALID_VALUE",
    );
  });

  test("rejects cross-tenant globals and requires their exact source version", async () => {
    const f = fixture();
    await rejectsCode(
      materializeTemplateContent(f.request, f.registry, {
        ...f.resolvers,
        resolveGlobalVariable: () => ({
          tenantId: "other-tenant",
          sourceId: "brand",
          sourceVersionId: "v1",
          value: "Other",
        }),
      }),
      "DEPENDENCY_INVALID",
    );
    await rejectsCode(
      materializeTemplateContent(f.request, f.registry, {
        ...f.resolvers,
        resolveGlobalVariable: () => ({
          tenantId,
          sourceId: "brand",
          sourceVersionId: "",
          value: "Other",
        }),
      }),
      "INVALID_VALUE",
    );
  });
});

describe("compiled entity block definitions and typed relationships", () => {
  const summary: ContentBlock = {
    id: "summary",
    definitionKey: "RecordSummary",
    schemaVersion: 3,
    values: { heading: "Record" },
    references: { record: { entity: "ExampleRecord", id: "record-1", versionId: "record-v1" } },
  };

  test("keeps embedded values and resolved entity references separate", async () => {
    const f = fixture([summary, { ...summary, id: "summary-again" }]);
    const snapshot = await f.run();
    expect(snapshot.blocks[0]!.values).toEqual({ heading: "Record" });
    expect(snapshot.blocks[0]!.references.record).toEqual({
      tenantId,
      entity: "ExampleRecord",
      id: "record-1",
      versionId: "record-v1",
      value: { title: "Example record" },
    });
    expect(f.calls.entity).toBe(1);
    expect(snapshot.definitions.RecordSummary).toEqual(metadata.RecordSummary);
  });

  test("does not treat an id inside JSON as a relationship", async () => {
    const f = fixture([
      { ...summary, values: { heading: "Record", record: "record-1" }, references: {} },
    ]);
    await rejectsCode(f.run(), "DEPENDENCY_UNRESOLVED");
    f.versions.root = version("root", [
      { ...summary, values: { heading: "Record", record: "record-1" } },
    ]);
    await rejectsCode(f.run(), "INVALID_VALUE");
  });

  test("rejects unknown blocks, definition version mismatch and collection disallowed blocks", async () => {
    const f = fixture();
    await rejectsCode(materializeTemplateContent(f.request, {}, f.resolvers), "BLOCK_UNKNOWN");
    f.versions.root = version("root", [{ ...text(), schemaVersion: 2 }]);
    await rejectsCode(f.run(), "BLOCK_SCHEMA_UNSUPPORTED");
    f.versions.root = {
      ...version("root", [text()]),
      variants: [
        {
          id: "restricted",
          channel: "document",
          locale: "en",
          blocks: [text()],
          allowedDefinitions: ["RecordSummary"],
        },
      ],
    };
    await rejectsCode(f.run(), "BLOCK_NOT_ALLOWED");
  });

  test("rejects blocks without a renderer for the requested channel", async () => {
    const f = fixture([summary]);
    await rejectsCode(
      materializeTemplateContent({ ...f.request, channel: "email" }, f.registry, f.resolvers),
      "UNSUPPORTED_CHANNEL",
    );
  });

  test("rejects a reference of a different entity type", async () => {
    await rejectsCode(
      fixture([
        { ...summary, references: { record: { entity: "OtherRecord", id: "record-1" } } },
      ]).run(),
      "DEPENDENCY_INVALID",
    );
  });

  test.each(["tenantId", "entity", "id", "versionId"] as const)(
    "rejects resolver mismatches for %s",
    async (key) => {
      const f = fixture([summary]);
      await rejectsCode(
        materializeTemplateContent(f.request, f.registry, {
          ...f.resolvers,
          resolveEntity: () => ({
            tenantId,
            entity: "ExampleRecord",
            id: "record-1",
            versionId: "record-v1",
            value: {},
            [key]: "unexpected",
          }),
        }),
        "DEPENDENCY_INVALID",
      );
    },
  );

  test("rejects missing references even when the id exists in storage input", async () => {
    const f = fixture([summary]);
    await rejectsCode(
      materializeTemplateContent(f.request, f.registry, {
        ...f.resolvers,
        resolveEntity: () => null,
      }),
      "DEPENDENCY_UNRESOLVED",
    );
  });

  test("validates ordered reference collections and rejects duplicate entity ids", async () => {
    const f = fixture([
      {
        ...summary,
        references: {
          record: [
            { entity: "ExampleRecord", id: "two" },
            { entity: "ExampleRecord", id: "one" },
          ],
        },
      },
    ]);
    f.registry.RecordSummary = {
      ...metadata.RecordSummary!,
      fields: {
        ...metadata.RecordSummary!.fields,
        record: { ...metadata.RecordSummary!.fields.record!, cardinality: { min: 1, max: 2 } },
      },
    };
    const snapshot = await f.run();
    expect(snapshot.blocks[0]!.references.record).toEqual([
      {
        tenantId,
        entity: "ExampleRecord",
        id: "two",
        versionId: "record-v1",
        value: { title: "Example record" },
      },
      {
        tenantId,
        entity: "ExampleRecord",
        id: "one",
        versionId: "record-v1",
        value: { title: "Example record" },
      },
    ]);
    f.versions.root = version("root", [
      {
        ...summary,
        references: {
          record: [
            { entity: "ExampleRecord", id: "one" },
            { entity: "ExampleRecord", id: "one" },
          ],
        },
      },
    ]);
    await rejectsCode(f.run(), "DUPLICATE");
  });

  test("validates metadata rather than registering custom block code", () => {
    expect(validateContentRegistry(metadata)).toEqual(metadata);
    expect(() =>
      validateContentRegistry({ Invalid: { ...metadata.TemplateSlot!, fields: {} } }),
    ).toThrow("typed template-version relationship");
  });

  test("hands resolved immutable values to the host canonical field validator", async () => {
    const f = fixture();
    const validations: unknown[] = [];
    await materializeTemplateContent(f.request, f.registry, {
      ...f.resolvers,
      validateParameters(version, values) {
        expect(Object.isFrozen(values)).toBe(true);
        validations.push([version.id, values]);
      },
      validateBlockValues(definitionKey, values) {
        expect(Object.isFrozen(values)).toBe(true);
        validations.push([definitionKey, values]);
      },
    });
    expect(validations).toEqual([
      ["root", { name: "Reader" }],
      ["TextSection", { body: "Hello Reader from Example." }],
    ]);
    const refusal = new Error("Canonical field validation refused the value");
    await expect(
      materializeTemplateContent(f.request, f.registry, {
        ...f.resolvers,
        validateBlockValues() {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
  });

  test("validates nested object metadata and single/collection cardinality defaults", () => {
    const shape = { amount: { valueType: "integer" as const, cardinality: { min: 1 } } };
    expect(resolveTemplateParameters(shape, { amount: 2 })).toEqual({ amount: 2 });
    expect(() => resolveTemplateParameters(shape, { amount: [2] })).toThrow("integer");
    const nested = {
      person: {
        valueType: "object" as const,
        fields: { age: { valueType: "integer" as const, required: true } },
      },
    };
    expect(() => resolveTemplateParameters(nested, { person: { age: "2" } })).toThrow("integer");
    expect(() => resolveTemplateParameters(nested, { person: { age: 2, other: true } })).toThrow(
      "unsupported",
    );
    expect(() =>
      resolveTemplateParameters({ date: { valueType: "date" } }, { date: "2026-02-30" }),
    ).toThrow("date");
  });

  test("rejects prototype keys absent from the compiled metadata or parameter values", async () => {
    const f = fixture([{ ...text(), definitionKey: "constructor" }]);
    await rejectsCode(f.run(), "BLOCK_UNKNOWN");
    f.versions.root = version("root", [text("prototype", "{{local.constructor}}")]);
    await rejectsCode(f.run(), "MISSING_VARIABLE");
  });
});

describe("template composition", () => {
  test("expands nested templates in order and pins local/global values and source versions", async () => {
    const f = fixture([
      text("before", "Before"),
      include("nested", "child", { name: "{{local.name}}" }),
      text("after", "After"),
    ]);
    f.versions.child = version("child", [text("child-text")]);
    const snapshot = await materializeTemplateContent(
      { ...f.request, parameters: { name: "Example reader" } },
      f.registry,
      f.resolvers,
    );
    expect(snapshot.blocks.map((block) => block.path)).toEqual([
      ["before"],
      ["nested", "child-text"],
      ["after"],
    ]);
    expect(snapshot.blocks[1]!.values.body).toBe("Hello Example reader from Example.");
    expect(snapshot.templates.map((template) => template.version.id)).toEqual(["root", "child"]);
    expect(snapshot.templates[1]!.parameters).toEqual({ name: "Example reader" });
    expect(snapshot.globals["brand.name"]!.sourceVersionId).toBe("brand-v1");
    expect(snapshot.compositions[0]!.values.parameters).toEqual({ name: "Example reader" });
  });

  test("permits repeated inclusion with different local parameters and collision-free paths", async () => {
    const f = fixture([
      include("left", "child", { name: "Left" }),
      include("right", "child", { name: "Right" }),
    ]);
    f.versions.child = version("child", [text("child-text")]);
    const snapshot = await f.run();
    expect(snapshot.blocks.map((block) => block.values.body)).toEqual([
      "Hello Left from Example.",
      "Hello Right from Example.",
    ]);
    expect(snapshot.blocks.map((block) => block.path)).toEqual([
      ["left", "child-text"],
      ["right", "child-text"],
    ]);
    expect(f.calls.template).toBe(2);
    expect(f.calls.global).toBe(1);
  });

  test("rejects direct and indirect cycles", async () => {
    const direct = fixture([include("self", "root")]);
    await rejectsCode(direct.run(), "TEMPLATE_CYCLE");
    const indirect = fixture([include("nested", "child")]);
    indirect.versions.child = version("child", [include("back", "root")]);
    await rejectsCode(indirect.run(), "TEMPLATE_CYCLE");
  });

  test("requires the nested template to support the same channel/locale", async () => {
    const f = fixture([include("nested", "child")]);
    f.versions.child = {
      ...version("child", [text()]),
      variants: [{ id: "child-email", channel: "email", locale: "en", blocks: [text()] }],
    };
    await rejectsCode(f.run(), "UNSUPPORTED_CHANNEL");
  });

  test("rejects missing or cross-tenant template versions", async () => {
    const f = fixture([include("nested", "child")]);
    await rejectsCode(f.run(), "DEPENDENCY_UNRESOLVED");
    f.versions.child = { ...version("child", []), tenantId: "other-tenant" };
    await rejectsCode(f.run(), "DEPENDENCY_INVALID");
  });

  test("bounds aggregate expansion and nesting depth", async () => {
    const f = fixture([include("first", "child"), include("second", "child")]);
    f.versions.child = version(
      "child",
      Array.from({ length: CONTENT_LIMITS.blocks / 2 }, (_, index) =>
        text(`item-${index}`, "Plain"),
      ),
    );
    await rejectsCode(f.run(), "CONTENT_LIMIT_EXCEEDED");
    const deep = fixture([include("next", "depth-0")]);
    for (let index = 0; index < CONTENT_LIMITS.templateDepth; index++)
      deep.versions[`depth-${index}`] = version(`depth-${index}`, [
        include("next", `depth-${index + 1}`),
      ]);
    await rejectsCode(deep.run(), "CONTENT_LIMIT_EXCEEDED");
  });

  test("bounds variable amplification before concatenating oversized text", async () => {
    const f = fixture([text("large", "{{global.brand.name}}{{global.brand.name}}")]);
    await rejectsCode(
      materializeTemplateContent(f.request, f.registry, {
        ...f.resolvers,
        resolveGlobalVariable: () => ({
          tenantId,
          sourceId: "brand",
          sourceVersionId: "v1",
          value: "a".repeat(CONTENT_LIMITS.stringCharacters / 2 + 1),
        }),
      }),
      "CONTENT_LIMIT_EXCEEDED",
    );
  });
});
