// SPDX-License-Identifier: BUSL-1.1
/**
 * The schemas in config/schemas were never validated against anything (#182),
 * so both halves of the contract could drift silently — and had. These tests
 * pin both halves:
 *
 *   - the registry loads and every schema compiles (a dangling $ref used to be
 *     undetectable, because nothing ever compiled them);
 *   - a violation is rejected, with the offending path named;
 *   - schema and compiler agree, in the direction that matters: the schema must
 *     never reject a shape the compiler accepts, or authoring that works is
 *     refused by its own documentation.
 */
import { describe, expect, it } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConnector } from "./compiler/connector.js";
import { loadConnector, validateConnectorContentIdentifiers } from "./connector-loader.js";
import {
  SCHEMA_BY_KIND,
  UNSCHEMAD_KINDS,
  authoringValidator,
  createAuthoringValidator,
} from "./schema-validation.js";
import type { ConnectorDefinition } from "./types/connector.js";
import fieldDefinitionSchema from "../../config/schemas/field-definition.schema.json" with {
  type: "json",
};
import coreEntitySchema from "../../config/schemas/core-entity.schema.json" with { type: "json" };
import workflowInspectorSchema from "../../config/schemas/workflow-inspector.schema.json" with {
  type: "json",
};

const validator = authoringValidator();

/**
 * Overrides are deliberately loosely typed: several tests supply shapes the
 * TypeScript types forbid on purpose (a `backoff` outside the union, a missing
 * `implementation`), because the point is what the SCHEMA does with them.
 */
function connectorDefinition(
  overrides: Record<string, unknown> = {},
): ConnectorDefinition {
  return {
    schemaVersion: 1,
    kind: "connector",
    connector: "ObjectStore",
    title: "Object storage",
    capabilities: ["operations"],
    implementation: {
      package: "@openshapeforge/connector-object-store",
      contractVersion: 1,
      provenance: "firstParty",
      license: { spdx: "LicenseRef-BatterAI-Commercial" },
    },
    operations: [
      {
        key: "listObjects",
        kind: "query",
        authorization: { roles: { invoke: ["Connectors.All.Read"] } },
        input: [{ key: "prefix", osfType: "string" }],
        output: { cardinality: "many", fields: [{ key: "key", osfType: "string" }] },
      },
    ],
    ...overrides,
  } as ConnectorDefinition;
}

/** Writes a connector YAML-as-JSON (valid YAML) and loads it through the loader. */
function loadFromDisk(definition: unknown, slug = "object-store") {
  const dir = mkdtempSync(join(tmpdir(), "osf-schema-"));
  const path = join(dir, `${slug}.yaml`);
  writeFileSync(path, JSON.stringify(definition, null, 2));
  return () => loadConnector(path, slug, `connectors/${slug}.yaml`);
}

describe("the schema registry", () => {
  it("loads every schema, so a dangling $ref cannot hide", () => {
    // The failure this replaces: compiled-entity-contract.schema.json referenced
    // canonical-field.schema.json, a file that does not exist, and nothing
    // noticed because nothing ever compiled the schema.
    expect(validator.schemaFiles.length).toBeGreaterThan(0);
    expect(validator.schemaFiles).toContain("core-entity.schema.json");
    expect(validator.schemaFiles).toContain("connector.schema.json");
    expect(validator.schemaFiles).toContain("field-definition.schema.json");
    expect(validator.schemaFiles).toContain("settings-definition.schema.json");
    expect(validator.schemaFiles).toContain("settings-provider.schema.json");
  });

  it("maps every kind to a schema or to a documented reason for having none", () => {
    const overlap = Object.keys(SCHEMA_BY_KIND).filter((kind) => kind in UNSCHEMAD_KINDS);
    expect(overlap).toEqual([]);
    for (const reason of Object.values(UNSCHEMAD_KINDS)) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("rejects a fieldDefinition semantic value with a second authored shape", () => {
    const ajv = new Ajv2020.default({ strict: false });
    ajv.addSchema(workflowInspectorSchema);
    ajv.addSchema(fieldDefinitionSchema);
    const canonical = ajv.getSchema(fieldDefinitionSchema.$id)!;

    const semanticField = {
      key: "definition",
      osfType: "fieldDefinition",
    };
    expect(canonical(semanticField)).toBe(true);

    for (const ambiguous of [
      { ...semanticField, children: [{ key: "extra", osfType: "string" }] },
      { ...semanticField, item: { key: "extra", osfType: "string" } },
    ]) {
      expect(canonical(ambiguous)).toBe(false);
    }

    expect(
      canonical({
        key: "ordinaryObject",
        osfType: "object",
        children: [{ key: "extra", osfType: "string" }],
      }),
    ).toBe(true);
  });

  it("refuses a kind that is in neither list, rather than skipping it", () => {
    expect(() => validator.validate({ kind: "somethingNew" }, "test.yaml")).toThrow(
      /maps to no schema/,
    );
  });

  it("refuses a document with no kind", () => {
    expect(() => validator.validate({ title: "x" }, "test.yaml")).toThrow(/no `kind`/);
  });

  it("validates the closed typed settings and provider authoring shapes", () => {
    expect(
      validator.validate(
        {
          schemaVersion: 1,
          kind: "settingsDefinition",
          namespace: "storage.artifacts",
          settings: [
            { key: "enabled", type: "boolean", default: false },
            {
              key: "maximumBytes",
              type: "integer",
              default: 1_000,
              minimum: 1,
              maximum: 10_000,
            },
            {
              key: "allowedMediaTypes",
              type: "stringSet",
              default: ["application/pdf"],
              allowed: ["application/pdf", "image/png"],
            },
            {
              key: "provider",
              type: "provider",
              capability: "artifact-storage",
              allowedProviders: ["filesystem"],
              enabledBy: "enabled",
            },
          ],
        },
        "settings/artifacts.yaml",
      ),
    ).toBe("settings-definition.schema.json");
    expect(
      validator.validate(
        {
          schemaVersion: 1,
          kind: "settingsProvider",
          provider: "filesystem",
          capabilities: ["artifact-storage"],
        },
        "settings/filesystem.yaml",
      ),
    ).toBe("settings-provider.schema.json");
    expect(() =>
      validator.validate(
        {
          schemaVersion: 1,
          kind: "settingsDefinition",
          namespace: "storage.artifacts",
          settings: [{ key: "token", type: "secret", default: "not-allowed" }],
        },
        "settings/secret.yaml",
      ),
    ).toThrow(/settings\/0/);
    expect(() =>
      validator.validate(
        {
          schemaVersion: 1,
          kind: "settingsProvider",
          provider: "filesystem",
          capabilities: ["artifact-storage"],
          endpoint: "https://dynamic.example.test",
        },
        "settings/provider.yaml",
      ),
    ).toThrow(/additional properties/);
  });

  it("reports a schema directory whose refs do not resolve", () => {
    const dir = mkdtempSync(join(tmpdir(), "osf-broken-"));
    writeFileSync(
      join(dir, "broken.schema.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://example.test/broken.schema.json",
        type: "object",
        properties: { kind: { const: "broken" }, x: { $ref: "no-such-file.schema.json" } },
      }),
    );
    expect(() => createAuthoringValidator(dir)).toThrow(/do not compile/);
  });
});

describe("a violation is rejected, with the offending path named", () => {
  it("rejects a core entity field in the superseded v1 shape", () => {
    // `type` was the v1 spelling, long superseded (first by `baseType`, now by
    // `osfType`), but core-entity.schema.json still required `type` — the exact
    // drift that made every shipped entity fail its own schema.
    expect(() =>
      validator.validate(
        {
          schemaVersion: 1,
          kind: "coreEntity",
          module: "core",
          entity: "Widget",
          title: "Widget",
          language: "en",
          fields: [{ key: "name", type: "string" }],
        },
        "widget.yaml",
      ),
    ).toThrow(/fields\/0/);
  });

  it("rejects an unknown property on a field", () => {
    expect(() =>
      validator.validate(
        {
          schemaVersion: 1,
          kind: "coreEntity",
          module: "core",
          entity: "Widget",
          title: "Widget",
          language: "en",
          fields: [{ key: "name", osfType: "string", notAThing: true }],
        },
        "widget.yaml",
      ),
    ).toThrow(/notAThing/);
  });

  it("accepts a well-formed core entity", () => {
    expect(
      validator.validate(
        {
          schemaVersion: 3,
          kind: "coreEntity",
          module: "core",
          entity: "Widget",
          title: "Widget",
          language: "en",
          fields: [{ key: "name", osfType: "string", required: true }],
          operations: {},
          interfaces: {},
        },
        "widget.yaml",
      ),
    ).toBe("core-entity.schema.json");
  });
});

describe("connector contracts are validated at LOAD, not only in the corpus gate", () => {
  it("accepts a well-formed contract", () => {
    expect(loadFromDisk(connectorDefinition())().connector).toBe("ObjectStore");
  });

  it("rejects a malformed contract before any identifier check runs", () => {
    const definition = { ...connectorDefinition() } as Record<string, unknown>;
    delete definition.implementation;
    expect(loadFromDisk(definition)).toThrow(/connector\.schema\.json/);
  });

  it("names the offending path", () => {
    const definition = connectorDefinition({
      operations: [
        {
          key: "listObjects",
          kind: "query",
          output: { cardinality: "many", fields: [{ key: "key", osfType: "string" }] },
          reliability: { retry: { eligible: true, backoff: "sideways" } },
        },
      ],
    });
    expect(loadFromDisk(definition)).toThrow(/backoff/);
  });

  it("keeps the identifier allowlist as an independent gate", () => {
    // Schema validation does not replace it: a shape schema documents a shape,
    // it is not injection defence, and it can be edited. Asserted against the
    // allowlist directly, because going through loadConnector would prove
    // nothing — the schema's own `connector` pattern rejects this too, so the
    // error could come from either layer.
    const hostile = connectorDefinition({ connector: "Object`Store" });
    expect(() => validateConnectorContentIdentifiers(hostile, "test.yaml")).toThrow(
      /Unsafe connector name/,
    );
    // Operation keys too. The schema happens to carry the same pattern today —
    // which is the point: two independent layers agreeing is the design, and
    // this assertion holds even if the schema's pattern is loosened.
    const hostileKey = connectorDefinition({
      operations: [
        {
          key: "list`Objects",
          kind: "query",
          authorization: { roles: { invoke: ["Connectors.All.Read"] } },
          output: { cardinality: "many", fields: [{ key: "key", osfType: "string" }] },
        },
      ],
    });
    expect(() => validateConnectorContentIdentifiers(hostileKey, "test.yaml")).toThrow(
      /Unsafe/,
    );
  });
});

describe("schema and compiler agree", () => {
  /**
   * The direction that matters. A schema stricter than the compiler refuses
   * authoring that works — which is what `reliability.timeoutMs` did: the
   * schema declared a key the compiler never reads, while rejecting the
   * `timeouts: { attemptMs, totalMs }` it does.
   */
  const acceptedByCompiler: Array<[string, ConnectorDefinition]> = [
    [
      "split attempt/total timeouts",
      connectorDefinition({
        operations: [
          {
            key: "listObjects",
            kind: "query",
            authorization: { roles: { invoke: ["Connectors.All.Read"] } },
            output: { cardinality: "many", fields: [{ key: "key", osfType: "string" }] },
            reliability: { timeouts: { attemptMs: 10_000, totalMs: 30_000 } },
          },
        ],
      }),
    ],
    [
      "retry with idempotency",
      connectorDefinition({
        operations: [
          {
            key: "putObject",
            kind: "mutation",
            authorization: { roles: { invoke: ["Connectors.All.ReadWrite"] } },
            input: [{ key: "requestId", osfType: "string" }],
            output: { cardinality: "one", fields: [{ key: "key", osfType: "string" }] },
            reliability: {
              retry: { eligible: true, maxAttempts: 3, backoff: "exponential" },
              idempotency: { strategy: "key", keyInput: "requestId" },
            },
          },
        ],
      }),
    ],
    [
      "a secret configuration field",
      connectorDefinition({
        configuration: {
          fields: [
            { key: "endpoint", osfType: "string", required: true },
            { key: "accessKeyId", osfType: "string", required: true, secret: true },
          ],
        },
      }),
    ],
  ];

  for (const [label, definition] of acceptedByCompiler) {
    it(`accepts what the compiler accepts: ${label}`, () => {
      // Compiler first: if this throws, the fixture is wrong, not the schema.
      expect(() => buildConnector(definition, "object-store", "test.yaml")).not.toThrow();
      expect(validator.validate(definition, "test.yaml")).toBe("connector.schema.json");
    });
  }
});

/**
 * Both properties below are supported end to end by the compiler and were
 * missing from the schemas, so authoring either one failed the gate. Neither
 * was in use by any YAML in this repo, which is exactly why: an unused
 * property cannot drift visibly. These tests are the standing check, so the
 * next stretch where nothing authors them does not quietly re-open the gap.
 */
describe("coreEntity properties the compiler implements", () => {
  function coreEntity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 3,
      kind: "coreEntity",
      module: "core",
      entity: "BillingRun",
      title: "Billing run",
      language: "en",
      fields: [{ key: "idempotencyKey", osfType: "string" }],
      operations: {},
      interfaces: {},
      ...overrides,
    };
  }

  const v2Operation = (action: string) => ({
    name: `${action} billing runs`,
    description: `${action} billing runs`,
    implementation: { type: "entity", action },
    effects: { data: action === "list" || action === "get" ? "read" : "write", external: "none" },
    reliability: { idempotency: { mode: action === "list" || action === "get" ? "natural" : "none" } },
    confirmation: { mode: "none" },
  });

  it("accepts strict v2 operation and interface authoring", () => {
    const document = coreEntity({
      schemaVersion: 3,
      operations: { list: v2Operation("list"), get: v2Operation("get") },
      interfaces: {
        rest: {},
        graphql: {},
        mcp: { tools: "generic" },
        web: {
          views: {
            collection: {
              renderer: "billing-run.collection",
              route: "/billing-runs",
              columns: [{ key: "idempotencyKey" }],
            },
            record: {
              renderer: "billing-run.record",
              routes: { read: "/billing-runs/:id" },
              title: "{{idempotencyKey}}",
              layout: { tabs: [{ id: "main", fields: ["idempotencyKey"] }] },
            },
          },
        },
      },
    });
    expect(validator.validate(document, "billing-run.yaml")).toBe("core-entity.schema.json");
  });

  const webViews = (tabs: unknown) => coreEntity({
    schemaVersion: 3,
    operations: { list: v2Operation("list"), get: v2Operation("get") },
    interfaces: { rest: {}, graphql: {}, mcp: { tools: "generic" }, web: { views: {
      collection: { route: "/billing-runs", columns: [{ key: "idempotencyKey" }] },
      record: { title: "{{idempotencyKey}}", layout: { tabs } },
    } } },
  });

  it("accepts a FieldRef entry in a view group, as the compiler does", () => {
    // FieldEntry is string | FieldRef in types/views.ts and web-manifest.ts
    // reads render and fieldDisplayMode; the schema used to admit only the key.
    const document = webViews([{ id: "main", fields: [
      "idempotencyKey",
      { key: "idempotencyKey", render: "TextDisplay" },
      { key: "idempotencyKey", fieldDisplayMode: "hidden" },
    ] }]);
    expect(validator.validate(document, "billing-run.yaml")).toBe("core-entity.schema.json");
    expect(() => validator.validate(webViews([{ id: "main", fields: [{ key: "idempotencyKey", hidden: true }] }]), "billing-run.yaml"))
      .toThrow(/fields\/0/);
    expect(() => validator.validate(webViews([{ id: "main", fields: [{ key: "idempotencyKey", fieldDisplayMode: "collapsed" }] }]), "billing-run.yaml"))
      .toThrow(/fieldDisplayMode/);
  });

  it("marks every closed choice in interfaces.web with what it chooses from", () => {
    // A schema-driven editor fills these from the entity (its fields,
    // relationships, sortable fields, custom operations) or the host (its
    // renderer registry, the component catalogue) — from the marker, never
    // from a property's name or position. Every fieldKey reference and every
    // operation, renderer or component key must carry one; a key that is an
    // identifier of something else (a variable source) must not.
    const defs = coreEntitySchema.$defs as Record<string, unknown>;
    const kinds = new Set(["field", "sortableField", "relationship", "operation", "renderer", "component"]);
    const unmarked: string[] = [];
    const seen: string[] = [];
    const visited = new Set<unknown>();
    // A choice site: a field key reference, a renderer key, or a string whose
    // name says it is an operation, renderer or component — the places an
    // editor must not treat as free text.
    const isChoiceSite = (schema: Record<string, unknown>, path: string) => {
      if (path.includes("variableSources")) return false;
      if (schema.$ref === "#/$defs/fieldKey" || schema.$ref === "#/$defs/webRendererKeyV2") return true;
      // The last path element: an item of `actions` is `actions[]`, a map key is `<key>`.
      const name = path.match(/(?:^|[.>|])([^.>|]+)$/)?.[1] ?? "";
      const stringLike = schema.type === "string" || typeof schema.pattern === "string";
      return stringLike && /^(actions\[\]|resultRenderer|component|render|<key>)$/.test(name) && !path.includes("i18n");
    };
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const schema = node as Record<string, unknown>;
      const choice = schema["x-osf-choice"];
      if (choice !== undefined) {
        const kind = typeof choice === "string" ? choice : (choice as { kind?: string }).kind;
        if (!kind || !kinds.has(kind)) unmarked.push(`${path} has an unknown x-osf-choice ${JSON.stringify(choice)}`);
        seen.push(path);
      } else if (isChoiceSite(schema, path)) unmarked.push(path);
      // Follow refs once per target, so a recursive definition terminates; the
      // render definition lives in field-definition.schema.json.
      if (typeof schema.$ref === "string") {
        const local = schema.$ref.match(/^#\/\$defs\/(.+)$/);
        const external = schema.$ref.match(/field-definition\.schema\.json#\/\$defs\/(.+)$/);
        const name = local?.[1] ?? external?.[1];
        const target = local ? defs[name!] : external ? (fieldDefinitionSchema.$defs as Record<string, unknown>)[name!] : undefined;
        if (target && !visited.has(target)) { visited.add(target); walk(target, `${path}->${name}`); }
      }
      for (const [key, child] of Object.entries((schema.properties as Record<string, unknown>) ?? {})) walk(child, `${path}.${key}`);
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") walk(schema.additionalProperties, `${path}.*`);
      if (schema.propertyNames && typeof schema.propertyNames === "object") walk(schema.propertyNames, `${path}.<key>`);
      if (schema.items) walk(schema.items, `${path}[]`);
      for (const combinator of ["oneOf", "anyOf", "allOf"]) {
        for (const [index, variant] of ((schema[combinator] as unknown[] | undefined) ?? []).entries()) walk(variant, `${path}|${combinator}${index}`);
      }
    };
    walk((defs.entityInterfacesV2 as { properties: { web: unknown } }).properties.web, "web");
    expect(unmarked).toEqual([]);
    for (const expected of [
      "web.views->webViewsV2.collection.columns[].key",
      "web.views->webViewsV2.collection.defaultSort.key",
      "web.views->webViewsV2.collection.actions[]",
      "web.views->webViewsV2.record.actions[]",
      "web.views->webViewsV2.record.badges[]",
      "web.views->webViewsV2.record.layout.context.fields[]",
      "web.views->webViewsV2.record.layout.context.relationships[]",
      "web.views->webViewsV2.record.layout.tabs[]->webViewGroupV2.relationship",
      "web.views->webViewsV2.record.layout.tabs[]->webViewGroupV2.fields[]->webFieldEntryV2|oneOf1.render",
      "web.fields.<key>",
      "web.fields.*.render->render.component",
      "web.operations->webInterfaceOperationsV2.<key>",
      "web.operations->webInterfaceOperationsV2.*|oneOf1.resultRenderer",
    ]) expect(seen).toContain(expected);
    expect(seen.some((path) => path.includes("variableSources"))).toBe(false);
  });

  it("titles every interfaces.web schema node in both locales, for schema-driven editors", () => {
    // A node is every object schema and every property under it; the enum
    // members of a choice are titled too. Anything added later must be titled
    // or this fails, so an editor built from the schema never shows raw keys.
    const defs = coreEntitySchema.$defs as Record<string, unknown>;
    const untitled: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      const schema = node as Record<string, unknown>;
      if ("$ref" in schema && Object.keys(schema).length === 1) return;
      const i18n = schema["x-osf-i18n"] as { title?: { en?: string; nl?: string }; enum?: Record<string, { en?: string; nl?: string }> } | undefined;
      if (!i18n?.title?.en || !i18n.title.nl) untitled.push(path);
      for (const member of (schema.enum as string[] | undefined) ?? []) {
        if (!i18n?.enum?.[member]?.en || !i18n.enum[member]?.nl) untitled.push(`${path}=${member}`);
      }
      for (const [key, child] of Object.entries((schema.properties as Record<string, unknown>) ?? {})) walk(child, `${path}.${key}`);
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") walk(schema.additionalProperties, `${path}.*`);
      if (schema.items) walk(schema.items, `${path}[]`);
      for (const [index, variant] of ((schema.oneOf as unknown[] | undefined) ?? []).entries()) walk(variant, `${path}|${index}`);
    };
    walk((defs.entityInterfacesV2 as { properties: { web: unknown } }).properties.web, "web");
    for (const def of ["webViewsV2", "webViewGroupV2", "webWriteModeV2", "webFieldEntryV2"]) walk(defs[def], def);
    expect(untitled).toEqual([]);
  });

  it("accepts plugin-backed CRUD without a second authorization policy", () => {
    const document = coreEntity({
      schemaVersion: 3,
      authorization: {
        roles: {
          read: ["BillingRuns.Read"],
          create: ["BillingRuns.Write"],
          update: ["BillingRuns.Write"],
          delete: ["BillingRuns.Delete"],
        },
      },
      operations: {
        create: {
          name: "Create a billing run",
          description: "Validates the definition and creates its canonical head.",
          implementation: {
            type: "plugin",
            plugin: "example",
            handler: "createBillingRun",
            action: "create",
          },
          target: { scope: "collection" },
          input: {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["idempotencyKey"],
              properties: { idempotencyKey: { type: "string", format: "uuid" } },
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["id"],
              properties: { id: { type: "string", format: "uuid" } },
            },
          },
          errors: [],
          effects: { data: "write", external: "none" },
          reliability: {
            idempotency: { mode: "keyed", inputField: "idempotencyKey" },
          },
          confirmation: { mode: "none" },
        },
      },
      interfaces: { rest: {}, graphql: {}, mcp: { tools: "generic" } },
    });

    expect(validator.validate(document, "billing-run.yaml")).toBe(
      "core-entity.schema.json",
    );
    const create = (document.operations as Record<string, any>).create;
    create.auth = { mode: "session", roles: ["BillingRuns.Write"] };
    expect(() => validator.validate(document, "billing-run.yaml")).toThrow(
      /must NOT be valid/,
    );
  });

  it("accepts plugin-backed delete only with its canonical destructive contract", () => {
    const document = coreEntity({
      schemaVersion: 3,
      authorization: {
        roles: {
          read: ["BillingRuns.Read", "BillingRuns.Delete"],
          create: ["BillingRuns.Write"],
          update: ["BillingRuns.Write"],
          delete: ["BillingRuns.Delete"],
        },
      },
      operations: {
        remove: {
          name: "Delete billing run",
          description: "Deletes a billing run through its owning module.",
          implementation: {
            type: "plugin",
            plugin: "example",
            handler: "deleteBillingRun",
            action: "delete",
          },
          target: { scope: "record", inputField: "billingRunId" },
          input: {
            schema: {
              type: "object",
              properties: { billingRunId: { type: "string", format: "uuid" } },
              required: ["billingRunId"],
              additionalProperties: false,
            },
          },
          output: {
            schema: {
              type: "object",
              properties: { deleted: { type: "boolean" } },
              required: ["deleted"],
              additionalProperties: false,
            },
          },
          errors: [],
          effects: { data: "delete", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
          confirmation: { mode: "acknowledgement" },
        },
      },
      interfaces: {
        rest: {
          operations: {
            remove: { method: "DELETE", path: "/api/example/billing-runs/:billingRunId" },
          },
        },
        graphql: { operations: { remove: {} } },
        mcp: { operations: { remove: {} } },
        web: {
          operations: { remove: {} },
          views: {
            collection: { route: "/billing-runs", columns: [{ key: "idempotencyKey" }] },
          },
        },
      },
    });

    expect(validator.validate(document, "billing-run.yaml")).toBe("core-entity.schema.json");
  });

  it("accepts action-specific record ACL authoring and plugin enforcement", () => {
    const document = coreEntity({
      schemaVersion: 3,
      fields: [{
        key: "authorization",
        osfType: "object",
        required: true,
        defaultValue: {},
        persisted: { column: "authorization", storageClass: "core" },
      }],
      authorization: {
        roles: {
          read: ["Records.All.Read"],
          create: ["Records.All.Manage"],
          update: ["Records.All.Manage"],
          delete: ["Records.All.Delete"],
        },
        rowAccess: {
          enabled: true,
          recordPermissions: {
            field: "authorization",
            empty: "public",
            createRequires: ["view", "edit"],
          },
        },
      },
      operations: {
        archive: {
          name: "Archive record",
          description: "Archives one record.",
          implementation: { type: "plugin", plugin: "example", handler: "archive" },
          target: { scope: "record", inputField: "id" },
          input: {
            schema: {
              type: "object",
              properties: { id: { type: "string", format: "uuid" } },
              required: ["id"],
              additionalProperties: false,
            },
          },
          output: { schema: { type: "object", additionalProperties: true } },
          errors: [],
          auth: {
            mode: "session",
            roles: ["Records.All.Manage"],
            recordPermission: "delete",
          },
          tenancy: { mode: "required" },
          effects: { data: "write", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
          confirmation: { mode: "none" },
        },
      },
      interfaces: { rest: { operations: { archive: {} } } },
    });
    expect(validator.validate(document, "billing-run.yaml")).toBe("core-entity.schema.json");

    const sessionAuth = (document.operations as Record<string, any>).archive.auth;
    delete sessionAuth.roles;
    expect(validator.validate(document, "billing-run.yaml")).toBe("core-entity.schema.json");
    sessionAuth.roles = [];
    expect(validator.validate(document, "billing-run.yaml")).toBe("core-entity.schema.json");
  });

  it("rejects malformed strict v2 Web renderer registry keys", () => {
    const document = coreEntity({
      schemaVersion: 3,
      operations: { list: v2Operation("list") },
      interfaces: {
        web: {
          views: {
            collection: {
              renderer: "Billing Run/Collection",
              route: "/billing-runs",
              columns: [{ key: "idempotencyKey" }],
            },
          },
        },
      },
    });

    expect(() => validator.validate(document, "billing-run.yaml")).toThrow(/renderer/);
  });

  it("accepts false as an explicit interface Operation exclusion", () => {
    const document = coreEntity({
      schemaVersion: 3,
      operations: { list: v2Operation("list"), get: v2Operation("get") },
      interfaces: {
        rest: { operations: { get: false } },
        graphql: { operations: { list: false } },
        mcp: { operations: { get: false } },
      },
    });

    expect(validator.validate(document, "billing-run.yaml")).toBe("core-entity.schema.json");
  });

  it("accepts transport-neutral secure input on a v2 create Operation", () => {
    const create = {
      ...v2Operation("create"),
      interaction: {
        type: "secureInput",
        sourceField: "adapterId",
        sourceEntity: "Adapter",
        definitionsField: "configurationFields",
        into: "configurationValues",
        message: "Enter the connection values securely.",
      },
    };
    const document = coreEntity({
      schemaVersion: 3,
      fields: [
        { key: "adapterId", osfType: "string" },
        { key: "configurationValues", osfType: "object" },
      ],
      operations: { create },
      interfaces: { rest: {}, graphql: {}, mcp: {} },
    });

    expect(validator.validate(document, "connection.yaml")).toBe(
      "core-entity.schema.json",
    );
    create.interaction.type = "mcpElicitation";
    expect(() => validator.validate(document, "connection.yaml")).toThrow(
      /interaction/,
    );
  });

  it("accepts login-session prerequisites only on a v2 entity create Operation", () => {
    const create = {
      ...v2Operation("create"),
      prerequisites: [{
        operation: "osf-integration.provider.setup-guide",
        receipt: { binding: "loginSession" },
      }],
    };
    const document = coreEntity({
      schemaVersion: 3,
      operations: { create },
      interfaces: { rest: {}, graphql: {}, mcp: {} },
    });

    expect(validator.validate(document, "adapter.yaml")).toBe(
      "core-entity.schema.json",
    );

    create.implementation.action = "update";
    expect(() => validator.validate(document, "adapter.yaml")).toThrow(
      /prerequisites|implementation/,
    );
  });

  it("rejects an unknown strict v2 MCP tool projection", () => {
    const document = coreEntity({
      schemaVersion: 3,
      operations: { list: v2Operation("list") },
      interfaces: {
        mcp: { tools: "per-tenant", operations: { list: {} } },
      },
    });
    expect(() => validator.validate(document, "billing-run.yaml")).toThrow(/tools/);
  });

  it("accepts only the canonical server-issued, version-bound challenge shape", () => {
    const challenged = {
      ...v2Operation("delete"),
      confirmation: {
        mode: "challenge",
        challenge: {
          kind: "type-current-field",
          field: "idempotencyKey",
          issuedBy: "server",
          bindTo: ["subject", "tenant", "operation", "target.id", "target.version"],
          expiresAfter: "PT5M",
          singleUse: true,
        },
      },
    };
    const document = coreEntity({
      schemaVersion: 3,
      operations: { remove: challenged },
      interfaces: { rest: { operations: { remove: {} } } },
    });
    expect(validator.validate(document, "billing-run.yaml")).toBe("core-entity.schema.json");

    challenged.confirmation.challenge.issuedBy = "client" as never;
    expect(() => validator.validate(document, "billing-run.yaml")).toThrow(/issuedBy/);
  });

  it("uses acknowledgement instead of the ambiguous explicit confirmation mode", () => {
    const create = {
      ...v2Operation("create"),
      confirmation: { mode: "acknowledgement" },
    };
    const document = coreEntity({
      schemaVersion: 3,
      operations: { create },
      interfaces: { rest: { operations: { create: {} } } },
    });

    expect(validator.validate(document, "billing-run.yaml")).toBe(
      "core-entity.schema.json",
    );

    create.confirmation.mode = "explicit";
    expect(() => validator.validate(document, "billing-run.yaml")).toThrow(
      /confirmation/,
    );
  });

  it("accepts strict version and edit-lease concurrency authoring", () => {
    const update = {
      ...v2Operation("update"),
      concurrency: {
        version: { mode: "required", field: "updatedAt" },
        editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
      },
    };
    const document = coreEntity({
      schemaVersion: 3,
      fields: [
        { key: "updatedAt", osfType: "datetime", readOnly: true },
        { key: "idempotencyKey", osfType: "string" },
      ],
      operations: { update },
      interfaces: { rest: { operations: { update: {} } } },
    });

    expect(validator.validate(document, "billing-run.yaml")).toBe(
      "core-entity.schema.json",
    );

    update.concurrency.editLease.expiresAfterInactivity = "15 minutes";
    expect(() => validator.validate(document, "billing-run.yaml")).toThrow(
      /expiresAfterInactivity/,
    );
  });

  it("admits only schemaVersion 3 and none of the retired top-level keys", () => {
    for (const schemaVersion of [1, 2]) {
      expect(() => validator.validate(coreEntity({ schemaVersion }), "billing-run.yaml")).toThrow(/schemaVersion/);
    }
    for (const retired of ["crud", "rest", "mcp", "ui", "hooks", "permissions"]) {
      expect(() => validator.validate(coreEntity({ [retired]: {} }), "billing-run.yaml")).toThrow(new RegExp(retired));
    }
    expect(() => validator.validate(coreEntity({ operations: undefined }), "billing-run.yaml")).toThrow(/operations/);
  });

  it("rejects operation field projections until the compiler implements them", () => {
    const operation = { ...v2Operation("get"), output: { fields: ["idempotencyKey"] } };
    const document = coreEntity({
      schemaVersion: 3,
      operations: { get: operation },
      interfaces: { rest: { operations: { get: {} } } },
    });

    expect(() => validator.validate(document, "billing-run.yaml")).toThrow(/output/);
  });

  it("accepts entity-level indexes", () => {
    // backend-manifest.ts resolves these field keys to columns and emits
    // CREATE [UNIQUE] INDEX; the schema used to reject the block outright.
    const document = coreEntity({
      indexes: [
        {
          name: "billing_runs_tenant_idempotency_uidx",
          fields: ["tenantId", "idempotencyKey"],
          unique: true,
        },
        { name: "billing_runs_tenant_started_idx", fields: ["tenantId", "startedAt"] },
      ],
    });
    expect(validator.validate(document, "billing-run.yaml")).toBe("core-entity.schema.json");
  });

  it("rejects an index that names no fields", () => {
    const document = coreEntity({ indexes: [{ name: "billing_runs_idx", fields: [] }] });
    expect(() => validator.validate(document, "billing-run.yaml")).toThrow(/indexes\/0\/fields/);
  });

  it("rejects an index name that is not snake_case", () => {
    // The name is persisted verbatim as the SQL index name.
    const document = coreEntity({
      indexes: [{ name: "BillingRunsIdx", fields: ["tenantId"] }],
    });
    expect(() => validator.validate(document, "billing-run.yaml")).toThrow(/indexes\/0\/name/);
  });

  it("accepts a field's variable suggestions", () => {
    // generators/pages.ts mirrors this onto the generated page field.
    const document = coreEntity({
      fields: [
        { key: "entityType", osfType: "string" },
        {
          key: "descriptionTemplate",
          osfType: "string",
          variables: "template",
          suggestions: { sourceField: "entityType" },
        },
      ],
    });
    expect(validator.validate(document, "label-rule.yaml")).toBe("core-entity.schema.json");
  });

  it("rejects an unknown key inside suggestions", () => {
    const document = coreEntity({
      fields: [
        {
          key: "descriptionTemplate",
          osfType: "string",
          suggestions: { sourceEntity: "LabelRule" },
        },
      ],
    });
    expect(() => validator.validate(document, "label-rule.yaml")).toThrow(/suggestions/);
  });

});
