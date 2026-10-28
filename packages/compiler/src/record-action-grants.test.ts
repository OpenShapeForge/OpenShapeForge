// SPDX-License-Identifier: BUSL-1.1
/**
 * The generated first-grant form, against the catalog that actually authors it
 * (`config/authoring/operations/record-action-assignments.yaml`) rather than a
 * stand-in — the marker, the pruning and the expansion are only worth anything
 * if they apply to the real file.
 *
 * The registry half is checked against synthetic contracts, because what is
 * interesting there is the entities that must be left OUT, and this repository
 * deliberately declares only ones that belong in.
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadOperationCatalogs } from "./authoring/operation-catalog.js";
import type { CompiledEntityContract, OperationCatalogDefinition } from "./authoring/types.js";
import type { TableDefinition } from "./schema.js";
import {
  RECORD_ACTION_GRANT,
  RECORD_ACTION_GRANT_TARGET,
  recordActionGrantInputSchema,
  recordActionGrantInputs,
  recordActionGrantVariants,
  withRecordActionGrants,
  type RecordActionGrantVariant,
} from "./record-action-grants.js";

const authoringDir = fileURLToPath(new URL("../config/authoring/", import.meta.url));

/** The real base catalog that authors the marked Operation. */
function assignmentCatalog(): OperationCatalogDefinition {
  const loaded = loadOperationCatalogs(authoringDir)
    .find(({ path }) => path.endsWith("record-action-assignments.yaml"));
  if (!loaded) throw new Error("the record-action assignment catalog is no longer authored");
  return loaded.document;
}

const RUN: RecordActionGrantVariant = {
  entity: "ExternalProcessRun",
  labels: { en: "Process run", nl: "Procesuitvoering" },
  valueField: "id",
  actions: [{ name: "follow" }, { name: "start", labels: { en: "Start", nl: "Starten" } }],
};
const METER: RecordActionGrantVariant = {
  entity: "MeterConnection",
  labels: { en: "Meter connection", nl: "Meteraansluiting" },
  valueField: "id",
  actions: [{ name: "submitReading", labels: { en: "Submit a reading", nl: "Meterstand doorgeven" } }],
};

type Grant = {
  input: { schema: Record<string, any> };
  implementation: { type: string; plugin?: string; handler?: string };
};

function expanded(variants: readonly RecordActionGrantVariant[]): OperationCatalogDefinition {
  return withRecordActionGrants([assignmentCatalog()], variants)[0]!;
}

describe("the authored catalog's grant form", () => {
  test("is authored with the marker, the shared input and nothing entity-specific", () => {
    const grant = assignmentCatalog().operations.grantAssignment as unknown as Grant;
    expect(grant.implementation).toEqual({
      type: "plugin", plugin: "osf-record-actions", handler: "grantAssignment",
    });
    expect(grant.input.schema[RECORD_ACTION_GRANT]).toBe(true);
    // The author supplies what every variant shares and not one word more.
    expect(Object.keys(grant.input.schema.properties)).toEqual(["integrationId"]);
  });

  test("expands into one object-typed input whose `oneOf` is one variant per entity", () => {
    const grant = expanded([RUN, METER]).operations.grantAssignment as unknown as Grant;
    const schema = grant.input.schema;
    // The marker is consumed, not shipped.
    expect(schema[RECORD_ACTION_GRANT]).toBeUndefined();
    // ONE generated property beside the authored one, and the input stays a
    // plain closed object: the variant is a level down, which is where a
    // generic operation form resolves a branch at all. A root-level `oneOf`
    // is laid out by such a form as every variant's fields at once
    // (verified against the host's own field loop, see the Battery
    // `operationFields` contract) — every picker and every action list on one
    // page, with none of them required.
    expect(Object.keys(schema.properties)).toEqual(["integrationId", "target"]);
    expect(schema.required).toEqual(["integrationId", "target"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties.target.type).toBe("object");
    // Each branch: the entity fixed by the discriminator, its own picker and
    // its own action list, all three required.
    expect(schema.properties.target.oneOf.map((branch: any) => [
      branch.properties.entity.const, Object.keys(branch.properties), branch.required,
    ])).toEqual([
      ["ExternalProcessRun",
        ["entity", "externalProcessRunRecordId", "externalProcessRunAction"],
        ["entity", "externalProcessRunRecordId", "externalProcessRunAction"]],
      ["MeterConnection",
        ["entity", "meterConnectionRecordId", "meterConnectionAction"],
        ["entity", "meterConnectionRecordId", "meterConnectionAction"]],
    ]);
    const [run, meter] = schema.properties.target.oneOf as [any, any];
    // Distinct names per variant: each record input carries its own reference
    // target, which one shared property could not — and a shared name is also
    // what would carry a record chosen against the other entity's collection
    // through a switch.
    expect(run.properties.externalProcessRunRecordId["x-osf-reference"])
      .toEqual({ entity: "ExternalProcessRun", valueField: "id" });
    expect(meter.properties.meterConnectionRecordId["x-osf-reference"])
      .toEqual({ entity: "MeterConnection", valueField: "id" });
    // Exactly the actions each entity declared, and no entity's vocabulary in
    // the other's variant.
    expect(run.properties.externalProcessRunAction.enum).toEqual(["follow", "start"]);
    expect(meter.properties.meterConnectionAction.enum).toEqual(["submitReading"]);
  });

  test("the generated variant is the shape a generic variant control resolves", () => {
    // What the host requires of a discriminated choice, restated as the four
    // facts it reads (`schemaVariants` in the Battery form code): every branch
    // declares `properties`; one property is present in every branch with a
    // DIFFERENT `const` in each, which is the discriminator; the branch's own
    // title names the choice; and no two branches share a reference input
    // name, which is what the host's reference walk refuses outright.
    const target = (expanded([RUN, METER]).operations.grantAssignment as unknown as Grant)
      .input.schema.properties.target;
    const branches = target.oneOf as Array<Record<string, any>>;
    expect(branches.every((branch) => branch.properties)).toBe(true);
    const discriminators = Object.keys(branches[0]!.properties).filter((key) => {
      const consts = branches.map((branch) => branch.properties[key]?.const);
      return consts.every((value) => value !== undefined) && new Set(consts).size === branches.length;
    });
    expect(discriminators).toEqual(["entity"]);
    for (const branch of branches) {
      expect(branch["x-osf-i18n"].title).toEqual({ en: expect.any(String), nl: expect.any(String) });
    }
    const references = branches.flatMap((branch) => Object.entries(branch.properties)
      .filter(([, field]) => (field as any)["x-osf-reference"]).map(([name]) => name));
    expect(new Set(references).size).toBe(references.length);
    // And the field the whole choice sits in carries its own label.
    expect(Object.keys(target["x-osf-i18n"].title)).toEqual(["en", "nl"]);
  });

  test("labels come from the declaration, and an unlabelled action reads as its own name", () => {
    const schema = (expanded([RUN]).operations.grantAssignment as unknown as Grant).input.schema;
    const [branch] = schema.properties.target.oneOf as [any];
    // The choice itself reads as the entity's own label.
    expect(branch["x-osf-i18n"].title).toEqual({ en: "Process run", nl: "Procesuitvoering" });
    expect(branch.properties.externalProcessRunAction["x-osf-i18n"].enum).toEqual({
      // Authored labels, from the entity that declared the action.
      start: { en: "Start", nl: "Starten" },
      // None authored: the name itself, in both languages, rather than an
      // invented translation or an empty choice.
      follow: { en: "follow", nl: "follow" },
    });
    // Every visible input carries a title in both languages, which is what a
    // strict host requires of an operation form.
    for (const key of Object.keys(branch.properties)) {
      const title = branch.properties[key]["x-osf-i18n"].title;
      expect([typeof title.en, typeof title.nl]).toEqual(["string", "string"]);
    }
    // And no two places in one schema share one label object: a consumer that
    // edits what it was handed must not reach another artifact.
    const second = (expanded([RUN]).operations.grantAssignment as unknown as Grant)
      .input.schema.properties.target;
    expect(second["x-osf-i18n"].title).not.toBe(schema.properties.target["x-osf-i18n"].title);
    expect(second.oneOf[0].properties.entity["x-osf-i18n"].title)
      .not.toBe(branch.properties.entity["x-osf-i18n"].title);
  });

  test("a deployment where no entity declares the axis gets no form at all", () => {
    // Not an empty select over an empty picker: the Operation could never
    // succeed, so the whole surface of it goes — the published base compiles
    // exactly this way.
    const catalog = expanded([]);
    expect(catalog.operations.grantAssignment).toBeUndefined();
    expect(catalog.operations.listAssignments).toBeDefined();
    expect(catalog.interfaces.rest?.operations?.grantAssignment).toBeUndefined();
    expect(catalog.interfaces.mcp?.operations?.grantAssignment).toBeUndefined();
    expect(catalog.interfaces.web?.entities?.RecordActionAssignment?.operations.collectionActions)
      .toBeUndefined();
    // The rest of the surface is untouched.
    expect(catalog.interfaces.rest?.operations?.setAssignment).toBeDefined();
    expect(catalog.interfaces.web?.entities?.RecordActionAssignment?.operations.list.operation)
      .toBe("listAssignments");
  });

  test("the marker is reserved for the one Operation that may grant an action", () => {
    const catalog = assignmentCatalog();
    const grant = catalog.operations.grantAssignment!;
    const borrowed: OperationCatalogDefinition = {
      ...catalog,
      operations: {
        ...catalog.operations,
        // Same marker, a handler that is not the single writer of the axis.
        grantAssignment: {
          ...grant,
          implementation: { type: "plugin", plugin: "osf-record-actions", handler: "listAssignments" },
        },
      },
    };
    expect(() => withRecordActionGrants([borrowed], [RUN]))
      .toThrow(/reserved for the "osf-record-actions" handler "grantAssignment"/);
  });

  test("an author cannot pre-empt the inputs the compiler owns", () => {
    const catalog = assignmentCatalog();
    const grant = catalog.operations.grantAssignment!;
    const authoring = (properties: Record<string, unknown>): OperationCatalogDefinition => ({
      ...catalog,
      operations: {
        ...catalog.operations,
        grantAssignment: {
          ...grant,
          input: { schema: {
            ...grant.input!.schema,
            properties: { ...(grant.input!.schema as any).properties, ...properties },
          } },
        },
      },
    });
    expect(() => withRecordActionGrants([authoring({ recordId: { type: "string" } })], [RUN]))
      .toThrow(/also authors recordId/);
    // The one input the expansion generates, and the root branch it must not
    // find beside its own.
    expect(() => withRecordActionGrants([authoring({ target: { type: "object" } })], [RUN]))
      .toThrow(/also authors target/);
    expect(() => withRecordActionGrants([{
      ...catalog,
      operations: { ...catalog.operations, grantAssignment: { ...grant,
        input: { schema: { ...grant.input!.schema, oneOf: [{ required: ["integrationId"] }] } } } },
    } as OperationCatalogDefinition], [RUN])).toThrow(/also authors oneOf/);
  });

  test("the marker is an opt-in and not a switch, and cannot replace an authored input", () => {
    const catalog = assignmentCatalog();
    const grant = catalog.operations.grantAssignment!;
    const withMarker = (schema: Record<string, unknown>): OperationCatalogDefinition => ({
      ...catalog,
      operations: { ...catalog.operations, grantAssignment: { ...grant, input: { schema } } },
    });
    expect(() => withRecordActionGrants(
      [withMarker({ ...grant.input!.schema, [RECORD_ACTION_GRANT]: false })], [RUN],
    )).toThrow(/the marker is true or absent/);
    // The expansion refuses to replace an authored input even when called
    // directly, past the catalog check that would already have refused it.
    expect(() => recordActionGrantInputSchema(
      { type: "object", properties: { target: { type: "string" } } }, [RUN],
    )).toThrow(/would replace authored input target/);
  });

  test("a catalog with no marked Operation is returned untouched", () => {
    const other = loadOperationCatalogs(authoringDir)
      .map(({ document }) => document)
      .find((document) => !Object.values(document.operations).some((operation) =>
        (operation.input?.schema as Record<string, unknown> | undefined)?.[RECORD_ACTION_GRANT]))!;
    expect(withRecordActionGrants([other], [RUN])[0]).toBe(other);
  });
});

describe("which entities a first grant is offered on", () => {
  const contract = (over: Record<string, unknown> = {}): { contract: CompiledEntityContract } => ({
    contract: {
      entity: { id: "run", name: "ExternalProcessRun", module: "core", title: "Run", domains: [] },
      authorization: {
        roles: { read: [], create: [], update: [], delete: [] },
        rowAccess: { enabled: true, empty: "restricted", recordPermissions: {
          field: "authorization", column: "authorization", empty: "restricted", createRequires: [],
          actions: [{ name: "start", principals: ["integration"] }],
        } },
      },
      storage: { table: "external_process_runs", columns: [{ field: "id", column: "id" }] },
      entityOperations: { update: {} },
      interfaces: { web: { operations: { list: true } } },
      ...over,
    } as unknown as CompiledEntityContract,
  });

  /** The entity's manifest table, as the generic runtime would be given it. */
  const table = (over: Record<string, unknown> = {}): TableDefinition => ({
    schema: "erp",
    name: "external_process_runs",
    tenantScoped: true,
    generatedCrudEligible: true,
    columns: [
      { name: "id", type: "uuid", primaryKey: true },
      { name: "tenant_id", type: "uuid" },
    ],
    source: {
      authoringEntityName: "ExternalProcessRun",
      crud: { operations: { list: true, get: true, create: true, update: true, delete: true } },
    },
    ...over,
  } as unknown as TableDefinition);

  const variants = (over?: Record<string, unknown>, tableOver?: Record<string, unknown>) =>
    recordActionGrantVariants([contract(over)], [table(tableOver)]);

  test("an entity that declares an action for an application is offered", () => {
    expect(variants()).toEqual([{
      entity: "ExternalProcessRun",
      labels: { en: "Run", nl: "Run" },
      valueField: "id",
      actions: [{ name: "start" }],
    }]);
  });

  test("the picker's value field is the entity's own key, not the name `id`", () => {
    // Derived from the manifest key and the authoring that names it: a picker
    // that submitted another field would submit a value the locator and the
    // canonical writer cannot resolve.
    expect(variants(
      { storage: { table: "external_process_runs", columns: [{ field: "runKey", column: "run_key" }] } },
      { columns: [{ name: "run_key", type: "uuid", primaryKey: true }, { name: "tenant_id", type: "uuid" }] },
    )[0]).toMatchObject({ valueField: "runKey" });
  });

  test("an action no application may hold does not make an entity manageable here", () => {
    expect(variants({
      authorization: { roles: { read: [], create: [], update: [], delete: [] }, rowAccess: {
        enabled: true, empty: "restricted", recordPermissions: {
          field: "authorization", column: "authorization", empty: "restricted", createRequires: [],
          actions: [{ name: "follow", principals: ["person"] }],
        },
      } },
    })).toEqual([]);
  });

  test("an entity with no action, no collection or no record shape is left out", () => {
    // No declared action at all: the axis is opt-in, and nothing opted in.
    expect(variants({
      authorization: { roles: { read: [], create: [], update: [], delete: [] } },
    })).toEqual([]);
    // The reference picker populates itself from the target's own collection.
    expect(variants({ interfaces: { web: { operations: {} } } })).toEqual([]);
    // A subtype shares its base's table while the axis is keyed on the base.
    expect(variants({ subtype: { base: {} } })).toEqual([]);
    // A value definition is no record.
    expect(variants({
      entity: { id: "run", name: "ExternalProcessRun", module: "core", title: "Run", domains: [], valueDefinition: true },
    })).toEqual([]);
  });

  /**
   * The rules only the manifest knows. Each of these entities declares the
   * axis and would still be refused by the handler, so offering it would be
   * offering a choice that cannot be completed.
   */
  test("an entity the runtime could not address is not offered either", () => {
    // No tenant column: the row policy this surface relies on is not there.
    expect(variants(undefined, {
      tenantScoped: false,
      columns: [{ name: "id", type: "uuid", primaryKey: true }],
    })).toEqual([]);
    // A key that is not a uuid: the locator and the delegation Operation take one.
    expect(variants(undefined, {
      columns: [{ name: "id", type: "text", primaryKey: true }, { name: "tenant_id", type: "uuid" }],
    })).toEqual([]);
    // A composite key: generated CRUD addresses a row by a single column.
    expect(variants(undefined, {
      columns: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "tenant_id", type: "uuid", primaryKey: true },
      ],
    })).toEqual([]);
    // No key the manifest names at all.
    expect(variants(undefined, {
      columns: [{ name: "id", type: "uuid" }, { name: "tenant_id", type: "uuid" }],
    })).toEqual([]);
    // Assigning an action is an ACL edit through the entity's own update.
    expect(variants(undefined, {
      source: {
        authoringEntityName: "ExternalProcessRun",
        crud: { operations: { list: true, get: true, create: true, update: false, delete: true } },
      },
    })).toEqual([]);
    // A table the generic runtime does not serve, or serves internally only.
    expect(variants(undefined, { generatedCrudEligible: false })).toEqual([]);
    expect(variants(undefined, { domainInternal: true })).toEqual([]);
    // And an entity with no table of its own in this manifest.
    expect(variants(undefined, {
      source: { authoringEntityName: "SomethingElse", crud: { operations: { update: true } } },
    })).toEqual([]);
  });

  /**
   * `source.authoringEntityName` is provenance, not a manifest key: the
   * manifest is merged by physical `schema.table`, so a platform or
   * plugin-contributed table may name an authoring entity a promoted table
   * already names. Which of them answers decides which column the picker's
   * value field is read off.
   */
  test("the entity's table is the served one, whatever order the manifest holds", () => {
    const shadow = table({
      schema: "legacy",
      name: "external_process_runs",
      domainInternal: true,
      columns: [{ name: "legacy_key", type: "uuid", primaryKey: true }, { name: "tenant_id", type: "uuid" }],
    });
    // A table the generic runtime does not serve is not this entity's table,
    // even when it is the first one carrying the name: the served one is, and
    // its key is the one the canonical writer addresses a record by.
    expect(recordActionGrantVariants([contract()], [shadow, table()])[0])
      .toMatchObject({ valueField: "id" });
  });

  test("two served tables for one entity fail the build rather than pick one", () => {
    // Nothing in the manifest forbids the collision and the runtime registry
    // resolves it by its own table order, so a variant built from either key
    // would agree with the handler only by luck. The build says so instead.
    expect(() => recordActionGrantVariants([contract()], [
      table(),
      table({ schema: "plugin", name: "external_process_runs" }),
    ])).toThrow(
      /ExternalProcessRun declares the record-action axis and is served by more than one physical table: erp\.external_process_runs, plugin\.external_process_runs/,
    );
  });
});

test("the variant input names are one rule, and distinct per entity", () => {
  expect(recordActionGrantInputs("ExternalProcessRun"))
    .toEqual({ record: "externalProcessRunRecordId", action: "externalProcessRunAction" });
  expect(recordActionGrantInputs("MeterConnection"))
    .toEqual({ record: "meterConnectionRecordId", action: "meterConnectionAction" });
  // Which is what the generated schema declares, inside each variant.
  const schema = recordActionGrantInputSchema({ type: "object", properties: {} }, [RUN, METER]);
  const target = (schema.properties as Record<string, any>)[RECORD_ACTION_GRANT_TARGET];
  expect(target).toBeDefined();
  for (const [index, variant] of [RUN, METER].entries()) {
    const names = recordActionGrantInputs(variant.entity);
    const branch = target.oneOf[index];
    expect(branch.properties[names.record]).toBeDefined();
    expect(branch.properties[names.action]).toBeDefined();
  }
});
