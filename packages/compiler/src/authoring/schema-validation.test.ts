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
import fieldV2Schema from "../../config/schemas/field-v2.schema.json" with { type: "json" };
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
        input: [{ key: "prefix", valueType: "string" }],
        output: { cardinality: "many", fields: [{ key: "key", valueType: "string" }] },
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
    expect(validator.schemaFiles).toContain("field-v2.schema.json");
  });

  it("maps every kind to a schema or to a documented reason for having none", () => {
    const overlap = Object.keys(SCHEMA_BY_KIND).filter((kind) => kind in UNSCHEMAD_KINDS);
    expect(overlap).toEqual([]);
    for (const reason of Object.values(UNSCHEMAD_KINDS)) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("keeps the FieldV2 schema id as an equivalent compatibility entry point", () => {
    const ajv = new Ajv2020.default({ strict: false });
    ajv.addSchema(workflowInspectorSchema);
    ajv.addSchema(fieldDefinitionSchema);
    ajv.addSchema(fieldV2Schema);
    const canonical = ajv.getSchema(fieldDefinitionSchema.$id)!;
    const compatibility = ajv.getSchema(fieldV2Schema.$id)!;
    const compatibilityDefinition = ajv.getSchema(
      `${fieldV2Schema.$id}#/$defs/fieldV2`,
    )!;
    const compatibilityProperties = ajv.getSchema(
      `${fieldV2Schema.$id}#/$defs/fieldV2Properties`,
    )!;
    const recursiveDefinition = {
      key: "address",
      valueType: "object",
      children: [
        { key: "street", valueType: "string" },
        {
          key: "residents",
          valueType: "object",
          cardinality: "collection",
          item: { key: "resident", valueType: "object" },
        },
      ],
    };

    expect(canonical(recursiveDefinition)).toBe(true);
    expect(compatibility(recursiveDefinition)).toBe(true);
    expect(compatibilityDefinition(recursiveDefinition)).toBe(true);
    expect(compatibilityProperties(recursiveDefinition)).toBe(true);
    expect(canonical({ valueType: "string" })).toBe(false);
    expect(compatibility({ valueType: "string" })).toBe(false);
    expect(compatibilityDefinition({ valueType: "string" })).toBe(false);
    expect(compatibilityProperties({ valueType: "string" })).toBe(false);

    for (const definition of Object.keys(fieldV2Schema.$defs)) {
      expect(ajv.getSchema(`${fieldV2Schema.$id}#/$defs/${definition}`)).toBeDefined();
    }
  });

  it("accepts scalar query capabilities and rejects unsupported opt-ins", () => {
    const ajv = new Ajv2020.default({ strict: false });
    ajv.addSchema(workflowInspectorSchema);
    ajv.addSchema(fieldDefinitionSchema);
    const validate = ajv.getSchema(fieldDefinitionSchema.$id)!;

    expect(validate({
      key: "email",
      valueType: "string",
      searchable: true,
      filterable: true,
      sortable: false,
    })).toBe(true);
    expect(validate({
      key: "lines",
      valueType: "string",
      cardinality: "collection",
      item: { key: "line", valueType: "string" },
      filterable: true,
    })).toBe(false);
    expect(validate({ key: "rank", valueType: "integer", searchable: true })).toBe(false);
    expect(validate({
      key: "payload",
      valueType: "object",
      searchable: false,
      filterable: false,
      sortable: false,
    })).toBe(true);
  });

  it("rejects a fieldDefinition semantic value with a second authored shape", () => {
    const ajv = new Ajv2020.default({ strict: false });
    ajv.addSchema(workflowInspectorSchema);
    ajv.addSchema(fieldDefinitionSchema);
    ajv.addSchema(fieldV2Schema);
    const canonical = ajv.getSchema(fieldDefinitionSchema.$id)!;
    const compatibility = ajv.getSchema(fieldV2Schema.$id)!;

    const semanticField = {
      key: "definition",
      valueType: "object",
      semanticType: "fieldDefinition",
    };
    expect(canonical(semanticField)).toBe(true);
    expect(compatibility(semanticField)).toBe(true);

    for (const ambiguous of [
      { ...semanticField, children: [{ key: "extra", valueType: "string" }] },
      { ...semanticField, item: { key: "extra", valueType: "string" } },
    ]) {
      expect(canonical(ambiguous)).toBe(false);
      expect(compatibility(ambiguous)).toBe(false);
    }

    expect(
      canonical({
        key: "ordinaryObject",
        valueType: "object",
        children: [{ key: "extra", valueType: "string" }],
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
    // `type` was the v1 spelling; the compiler has taken `valueType` for a long
    // time, but core-entity.schema.json still required `type` — the exact drift
    // that made every shipped entity fail its own schema.
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
          fields: [{ key: "name", valueType: "string", notAThing: true }],
        },
        "widget.yaml",
      ),
    ).toThrow(/notAThing/);
  });

  it("accepts a well-formed core entity", () => {
    expect(
      validator.validate(
        {
          schemaVersion: 1,
          kind: "coreEntity",
          module: "core",
          entity: "Widget",
          title: "Widget",
          language: "en",
          fields: [{ key: "name", valueType: "string", required: true }],
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
          output: { cardinality: "many", fields: [{ key: "key", valueType: "string" }] },
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
          output: { cardinality: "many", fields: [{ key: "key", valueType: "string" }] },
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
            output: { cardinality: "many", fields: [{ key: "key", valueType: "string" }] },
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
            input: [{ key: "requestId", valueType: "string" }],
            output: { cardinality: "one", fields: [{ key: "key", valueType: "string" }] },
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
            { key: "endpoint", valueType: "string", required: true },
            { key: "accessKeyId", valueType: "string", required: true, secret: true },
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
      schemaVersion: 1,
      kind: "coreEntity",
      module: "core",
      entity: "BillingRun",
      title: "Billing run",
      language: "en",
      fields: [{ key: "idempotencyKey", valueType: "string" }],
      ...overrides,
    };
  }

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
        { key: "entityType", valueType: "string" },
        {
          key: "descriptionTemplate",
          valueType: "string",
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
          valueType: "string",
          suggestions: { sourceEntity: "LabelRule" },
        },
      ],
    });
    expect(() => validator.validate(document, "label-rule.yaml")).toThrow(/suggestions/);
  });

  it("accepts a read-only common CRUD policy", () => {
    const document = coreEntity({
      crud: { operations: { create: false, update: false, delete: false } },
    });
    expect(validator.validate(document, "billing-run.yaml")).toBe("core-entity.schema.json");
  });

  it("rejects unknown CRUD operations", () => {
    const document = coreEntity({ crud: { operations: { publish: true } } });
    expect(() => validator.validate(document, "billing-run.yaml")).toThrow(/crud/);
  });
});
