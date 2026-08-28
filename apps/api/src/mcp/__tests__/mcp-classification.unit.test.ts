// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for the two classification controls that exist ONLY on the MCP
 * transport.
 *
 * Everything else the MCP handlers do — row redaction, the classified
 * filter/sort oracle guard, the entity role gate — is the shared CRUD core's
 * behaviour and is already proven by the GraphQL and REST suites (#164). These
 * two have no equivalent anywhere else, because no other transport hands its
 * caller a machine-readable schema of the fields it may use:
 *
 *   1. withholdClassified — strip classified properties from an advertised
 *      tool schema, so `tools/list` does not enumerate exactly the fields
 *      redaction exists to hide.
 *   2. assertWritableValues — refuse a WRITE to a classified field by a caller
 *      who could not read the value back, rather than accepting it and
 *      redacting the response.
 *
 * These run without a database, so they hold the line even while no shipped
 * entity declares a restricting classification.
 */
import { describe, expect, it } from "bun:test";
import {
  __assertWritableValuesForTests as assertWritableValues,
  __describeEntityResourceForTests as describeEntityResource,
  __describeToolForTests as describeTool,
  __sessionMayInvokeForTests as sessionMayInvoke,
  __withholdClassifiedForTests as withholdClassified,
} from "../generated-mcp-server.js";

type AnyRecord = Record<string, unknown>;

const READ = "Relations.All.Read";
const WRITE = "Relations.All.ReadWrite";

const session = (...roles: string[]) =>
  ({
    tenantId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    roles,
    groups: [],
    scope: "self",
  }) as never;

/** A table whose read grant is separate from its write grant. */
const table = (columns: AnyRecord[] = []) =>
  ({
    name: "erp.payment_details",
    columns,
    source: {
      crud: {
        operations: { list: true, get: true, create: true, update: true, delete: true },
      },
      authorization: {
        roles: {
          read: [READ, WRITE],
          create: [WRITE],
          update: [WRITE],
          delete: [WRITE],
        },
      },
    },
  }) as never;

const entity = (classifiedFields: string[]) =>
  ({
    entity: "PaymentDetail",
    slug: "payment-detail",
    table: "erp.payment_details",
    toolPrefix: "payment_detail",
    title: "Payment Detail",
    description: "Bank account information.",
    classifiedFields,
  }) as never;

const tool = (inputSchema: AnyRecord) =>
  ({
    name: "payment_detail_create",
    operation: "create",
    entity: "PaymentDetail",
    table: "erp.payment_details",
    title: "Create Payment Detail",
    description: "Creates a new record.",
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }) as never;

const CREATE_SCHEMA: AnyRecord = {
  type: "object",
  properties: {
    accountHolder: { type: "string", maxLength: 200 },
    iban: { type: "string", maxLength: 34, description: "International Bank Account Number." },
    status: { type: "string" },
  },
  required: ["accountHolder", "iban"],
  additionalProperties: false,
};

describe("entity schema resource classification", () => {
  const resourceEntity = {
    ...(entity(["iban"]) as AnyRecord),
    domains: ["finance"],
    displayTemplate: "{{iban}}",
    filterField: "iban",
    fields: [
      {
        key: "accountHolder",
        valueType: "string",
        cardinality: "single",
        required: true,
        readOnly: false,
        immutable: false,
        schema: { type: "string" },
      },
      {
        key: "iban",
        valueType: "string",
        cardinality: "single",
        required: true,
        readOnly: false,
        immutable: false,
        classification: "pii",
        schema: { type: "string", description: "International Bank Account Number." },
      },
    ],
    relationships: [],
  };
  const entry = { entity: resourceEntity, tools: [tool(CREATE_SCHEMA)] } as never;
  const tables = new Map([["erp.payment_details", table()]]) as never;

  it("withholds classified field metadata from a read-only caller", () => {
    const described = describeEntityResource(entry, [entry], tables, session(READ)) as any;
    expect(described.fields.map((field: AnyRecord) => field.key)).toEqual(["accountHolder"]);
    expect(described).not.toHaveProperty("jsonSchema");
    // The classified field's NAME must not reach this caller through the
    // presentation hints either, and the advertised filter must be one the
    // caller's own tools accept.
    expect(described).not.toHaveProperty("displayTemplate");
    expect(described).not.toHaveProperty("filterField");
  });

  it("shows the same compiled field to a caller permitted to read it", () => {
    const described = describeEntityResource(entry, [entry], tables, session(WRITE)) as any;
    expect(described.fields.map((field: AnyRecord) => field.key)).toEqual([
      "accountHolder",
      "iban",
    ]);
    expect(described.fields[1].classification).toBe("pii");
    expect(described).not.toHaveProperty("jsonSchema");
    expect(described.displayTemplate).toBe("{{iban}}");
    expect(described.filterField).toBe("iban");
  });
});

describe("entity schema resource relationships", () => {
  const relatedField = {
    key: "relationId",
    valueType: "string",
    cardinality: "single",
    required: true,
    readOnly: false,
    immutable: false,
    schema: { type: "string", format: "uuid" },
    relationship: { kind: "belongsTo", entity: "Relation" },
  };
  const hiddenRelatedField = {
    ...relatedField,
    key: "accountId",
    relationship: { kind: "belongsTo", entity: "Account" },
  };
  const resourceEntity = {
    ...(entity([]) as AnyRecord),
    domains: ["finance"],
    fields: [relatedField, hiddenRelatedField],
    relationships: [
      {
        key: "relation",
        kind: "belongsTo",
        target: "Relation",
        foreignKey: "relation_id",
      },
      {
        key: "account",
        kind: "belongsTo",
        target: "Account",
        foreignKey: "account_id",
      },
    ],
  };
  const relation = {
    entity: "Relation",
    slug: "relation",
    table: "erp.relations",
    title: "Relation",
  } as never;
  const entry = { entity: resourceEntity, tools: [tool(CREATE_SCHEMA)] } as never;
  const relationEntry = { entity: relation, tools: [] } as never;
  const tables = new Map([["erp.payment_details", table()]]) as never;

  it("keeps the scalar field but strips relationship metadata whose target is not session-visible", () => {
    const described = describeEntityResource(
      entry,
      [entry, relationEntry],
      tables,
      session(READ),
    ) as any;

    // The row contains accountId and the write tools require it, so the field
    // itself stays readable; only the edge to the hidden target disappears —
    // the split GraphQL settled in generated-entity-schema.ts.
    expect(described.fields.map((field: AnyRecord) => field.key)).toEqual([
      "relationId",
      "accountId",
    ]);
    expect(described.fields[0].relationship.resourceUri).toBe(
      "osf://schema/entities/relation",
    );
    expect(described.fields[1]).not.toHaveProperty("relationship");
    expect(described.relationships).toEqual([
      {
        key: "relation",
        kind: "belongsTo",
        target: "Relation",
        foreignKey: "relation_id",
        resourceUri: "osf://schema/entities/relation",
      },
    ]);
  });
});

describe("withholdClassified", () => {
  it("returns the schema untouched when nothing is classified", () => {
    const result = withholdClassified(CREATE_SCHEMA, []);
    expect(result).toBe(CREATE_SCHEMA);
  });

  it("removes classified properties and drops them from required", () => {
    const result = withholdClassified(CREATE_SCHEMA, ["iban"]);
    expect(Object.keys(result.properties as AnyRecord)).toEqual(["accountHolder", "status"]);
    expect(result.required).toEqual(["accountHolder"]);
  });

  it("leaves the rest of the schema intact", () => {
    const result = withholdClassified(CREATE_SCHEMA, ["iban"]);
    expect(result.type).toBe("object");
    expect(result.additionalProperties).toBe(false);
    expect((result.properties as AnyRecord).accountHolder).toEqual({
      type: "string",
      maxLength: 200,
    });
  });

  it("does not mutate the catalog schema it was handed", () => {
    withholdClassified(CREATE_SCHEMA, ["iban"]);
    // The catalog is a module-level singleton shared by every request; mutating
    // it would leak one caller's redaction into the next caller's listing.
    expect(Object.keys(CREATE_SCHEMA.properties as AnyRecord)).toEqual([
      "accountHolder",
      "iban",
      "status",
    ]);
    expect(CREATE_SCHEMA.required).toEqual(["accountHolder", "iban"]);
  });

  it("strips entity fields inside the update values wrapper", () => {
    const updateSchema: AnyRecord = {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        values: {
          type: "object",
          properties: {
            iban: { type: "string" },
            status: { type: "string" },
          },
          required: ["iban"],
        },
      },
      required: ["id", "values"],
    };
    const result = withholdClassified(updateSchema, ["iban"]);
    const values = (result.properties as AnyRecord).values as AnyRecord;
    expect(Object.keys(values.properties as AnyRecord)).toEqual(["status"]);
    expect(values.required).toEqual([]);
    // The outer wrapper keeps its own shape.
    expect(result.required).toEqual(["id", "values"]);
  });

  it("preserves same-named children inside a nested entity object", () => {
    const createSchema: AnyRecord = {
      type: "object",
      properties: {
        iban: { type: "string" },
        bankAccount: {
          type: "object",
          properties: {
            iban: { type: "string" },
            bic: { type: "string" },
          },
          required: ["iban"],
        },
      },
      required: ["iban", "bankAccount"],
    };

    const result = withholdClassified(createSchema, ["iban"]);
    const bankAccount = (result.properties as AnyRecord).bankAccount as AnyRecord;
    expect(Object.keys(result.properties as AnyRecord)).toEqual(["bankAccount"]);
    expect(Object.keys(bankAccount.properties as AnyRecord)).toEqual(["iban", "bic"]);
    expect(bankAccount.required).toEqual(["iban"]);
  });

  it("strips classified fields inside the list filter wrapper", () => {
    const listSchema: AnyRecord = {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: {
            iban: { type: "string" },
            status: { type: "string" },
          },
        },
      },
    };

    const result = withholdClassified(listSchema, ["iban"]);
    const filter = (result.properties as AnyRecord).filter as AnyRecord;
    expect(Object.keys(filter.properties as AnyRecord)).toEqual(["status"]);
  });

  it("removes every classified field when more than one is listed", () => {
    const result = withholdClassified(CREATE_SCHEMA, ["iban", "accountHolder"]);
    expect(Object.keys(result.properties as AnyRecord)).toEqual(["status"]);
    expect(result.required).toEqual([]);
  });
});

describe("describeTool", () => {
  it("withholds classified fields from a reader without a write grant", () => {
    const described = describeTool(
      tool(CREATE_SCHEMA),
      entity(["iban"]),
      table(),
      session(READ),
    );
    const properties = (described.inputSchema as AnyRecord).properties as AnyRecord;
    expect(Object.keys(properties)).not.toContain("iban");
  });

  it("advertises them to a caller holding a write grant", () => {
    const described = describeTool(
      tool(CREATE_SCHEMA),
      entity(["iban"]),
      table(),
      session(WRITE),
    );
    const properties = (described.inputSchema as AnyRecord).properties as AnyRecord;
    expect(Object.keys(properties)).toContain("iban");
  });

  it("carries the operation annotations through either way", () => {
    const described = describeTool(
      tool(CREATE_SCHEMA),
      entity(["iban"]),
      table(),
      session(READ),
    );
    expect(described.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});

describe("assertWritableValues", () => {
  it("permits a write to a classified field by a caller with a write grant", () => {
    expect(() =>
      assertWritableValues({ iban: "NL91ABNA0417164300" }, entity(["iban"]), table(), session(WRITE)),
    ).not.toThrow();
  });

  it("refuses a write to a classified field by a read-only caller", () => {
    expect(() =>
      assertWritableValues({ iban: "NL91ABNA0417164300" }, entity(["iban"]), table(), session(READ)),
    ).toThrow(/classified field "iban"/);
  });

  it("permits unclassified fields for a read-only caller", () => {
    // The entity role gate is what refuses the operation itself; this control
    // is only about classified VALUES, so it must not duplicate that judgement.
    expect(() =>
      assertWritableValues({ status: "active" }, entity(["iban"]), table(), session(READ)),
    ).not.toThrow();
  });

  it("is a no-op for an entity with no classified fields", () => {
    expect(() =>
      assertWritableValues({ iban: "NL91ABNA0417164300" }, entity([]), table(), session(READ)),
    ).not.toThrow();
  });

  it("is a no-op when the entity is unknown to the catalog", () => {
    expect(() =>
      assertWritableValues({ iban: "x" }, undefined, table(), session(READ)),
    ).not.toThrow();
  });

  it("names the offending field so the caller can correct the call", () => {
    try {
      assertWritableValues({ iban: "x" }, entity(["iban"]), table(), session(READ));
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).toContain("iban");
      expect((error as Error).message).toContain("PaymentDetail");
    }
  });
});

describe("sessionMayInvoke", () => {
  it("grants read operations to a read-only session and withholds writes", () => {
    expect(sessionMayInvoke(table(), "list", session(READ))).toBe(true);
    expect(sessionMayInvoke(table(), "get", session(READ))).toBe(true);
    expect(sessionMayInvoke(table(), "create", session(READ))).toBe(false);
    expect(sessionMayInvoke(table(), "update", session(READ))).toBe(false);
    expect(sessionMayInvoke(table(), "delete", session(READ))).toBe(false);
  });

  it("grants everything to a write grant", () => {
    for (const operation of ["list", "get", "create", "update", "delete"] as const) {
      expect(sessionMayInvoke(table(), operation, session(WRITE))).toBe(true);
    }
  });

  it("withholds an operation disabled by the common CRUD policy despite a matching role", () => {
    const readOnly = table() as AnyRecord;
    ((readOnly.source as AnyRecord).crud as AnyRecord).operations = {
      list: true,
      get: true,
      create: false,
      update: false,
      delete: false,
    };
    expect(sessionMayInvoke(readOnly as never, "list", session(WRITE))).toBe(true);
    expect(sessionMayInvoke(readOnly as never, "update", session(WRITE))).toBe(false);
  });

  it("fails closed for a roleless session, an unknown table, and absent metadata", () => {
    expect(sessionMayInvoke(table(), "list", session())).toBe(false);
    expect(sessionMayInvoke(undefined, "list", session(WRITE))).toBe(false);
    expect(sessionMayInvoke({ name: "x", columns: [] } as never, "list", session(WRITE))).toBe(
      false,
    );
  });
});
