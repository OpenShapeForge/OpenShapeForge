// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CoreEntity, Field } from "../types.js";
import { loadEntity } from "../loader.js";
import { compile } from "./index.js";
import { withStatusTransitions } from "./transitions.js";
import { buildWebManifest } from "../web-manifest.js";
import { collectAuthoredEntityPluginOperations } from "../../generate-operations.js";
import { assertTransitionAgreements, assertTransitionReferencedPreconditions } from "./transitions-corpus.js";

const authoringDir = join(import.meta.dir, "../../../config/authoring");
const milestone = loadEntity(authoringDir, "agreement-milestone");
const catalogs = { componentCatalog: milestone.componentCatalog, osfTypes: milestone.osfTypes };

function withStatus(patch: Record<string, unknown>, entityPatch: Record<string, unknown> = {}): CoreEntity {
  const base = milestone.coreEntity;
  const fields = (entityPatch.fields as Field[] | undefined) ?? base.fields;
  return {
    ...base,
    ...entityPatch,
    fields: fields.map((field) => (field.key === "status" ? { ...field, ...patch } as Field : field)),
  };
}

const formless = { interfaces: { ...milestone.coreEntity.interfaces, web: undefined } };
/** The milestone with record-level permissions, the way an ACL-protected entity authors them. */
const protectedEntity = (rules: unknown[]) => withStatus({ transitions: { initial: "pending", rules } }, {
  ...formless,
  authorization: {
    ...milestone.coreEntity.authorization,
    rowAccess: { enabled: true, empty: "public", recordPermissions: { field: "authorization", empty: "public", createRequires: ["view", "edit"] } },
  },
  fields: [...milestone.coreEntity.fields, { key: "authorization", osfType: "object", baseType: "object", required: true, defaultValue: {}, persisted: { column: "authorization", storageClass: "core" } }],
});

describe("status transitions", () => {
  const contract = compile(milestone);
  const operation = contract.pluginOperations!.find((candidate) => candidate.key === "trigger")!;

  test("lowers each rule into a record Operation bound to the core transitions module", () => {
    expect(operation.id).toBe("AgreementMilestone.trigger");
    expect(operation.definition.implementation).toEqual({
      type: "plugin", plugin: "osf-transitions", handler: "transitionAgreementMilestoneTrigger",
    });
    expect(operation.definition.target).toEqual({ scope: "record", inputField: "id" });
    expect(operation.definition.auth).toEqual({ mode: "session", roles: ["Agreements.All.ReadWrite"] });
    expect(operation.definition.concurrency).toEqual({ version: { mode: "required", field: "updatedAt" } });
    expect(operation.definition.errors!.map((error) => error.code)).toEqual([
      "VALIDATION", "FORBIDDEN", "NOT_FOUND", "INVALID_STATE", "VERSION_CONFLICT",
    ]);
    expect((operation.definition.description as { en: string }).en).toContain("status: pending -> triggered");
    expect((operation.definition.description as { en: string }).en).toContain("agreementId.code is set");
    expect((operation.definition.description as { nl: string }).nl).toContain("agreementId.code ingevuld is");
    expect(operation.interfaces.rest).toEqual({ method: "POST", path: "/api/rest/v1/agreement-milestones/:id/trigger" });
  });

  test("the input carries the id and the rule's writes fields; stamped fields never enter it", () => {
    const schema = operation.definition.input!.schema as { required: string[]; properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(["id"]);
    expect(schema.required).toEqual(["id"]);
    const { entity: withWrites } = withStatusTransitions(withStatus({ transitions: { initial: "pending", rules: [
      { key: "trigger", from: ["pending"], to: "triggered", writes: ["triggeredBy"], stamps: [{ field: "triggeredAt", value: "now" }] },
    ] } }, formless), catalogs);
    const written = withWrites.operations!.trigger!.input!.schema as { properties: Record<string, unknown> };
    expect(Object.keys(written.properties)).toEqual(["id", "triggeredBy"]);
    const output = operation.definition.output!.schema as { required: string[]; properties: Record<string, { enum?: string[] }> };
    expect(output.required).toEqual(["id", "status"]);
    expect(output.properties.status!.enum).toEqual(["pending", "triggered", "invoiced", "cancelled"]);
  });

  test("status is writtenBy every rule's Operation, a stamped field by its rule only", () => {
    expect(contract.model.fields.find((field) => field.key === "status")!.writtenBy).toEqual(["AgreementMilestone.trigger", "AgreementMilestone.cancel", "AgreementMilestone.invoice"]);
    for (const key of ["triggeredAt", "triggeredBy"]) {
      expect(contract.model.fields.find((field) => field.key === key)!.writtenBy).toEqual(["AgreementMilestone.trigger"]);
    }
    expect(contract.model.fields.find((field) => field.key === "producedInvoiceId")!.writtenBy).toEqual(["AgreementMilestone.invoice"]);
    expect(contract.model.fields.find((field) => field.key === "description")!.writtenBy).toBeUndefined();
  });

  test("the compiled rule table reaches the contract and the web manifest with the record action", () => {
    expect(contract.transitions).toEqual([{
      field: "status", initial: "pending",
      rules: [
        {
          key: "trigger", operation: "AgreementMilestone.trigger", from: ["pending"], to: "triggered", label: { en: "Trigger", nl: "Triggeren" },
          preconditions: [{ via: "agreementId", field: "code", present: true }],
          stamps: [{ field: "triggeredAt", value: "now" }, { field: "triggeredBy", value: "actor", actor: "user" }],
        },
        { key: "cancel", operation: "AgreementMilestone.cancel", from: ["pending", "triggered"], to: "cancelled", label: { en: "Cancel", nl: "Annuleren" } },
        { key: "invoice", operation: "AgreementMilestone.invoice", from: ["triggered"], to: "invoiced", label: { en: "Invoice", nl: "Factureren" }, writes: [{ field: "producedInvoiceId", required: true, agreesOn: ["agreementId"] }] },
      ],
    }]);
    expect(contract.interfaces?.web?.operations).toBeDefined();
    const web = buildWebManifest([{ slug: "agreement-milestone", contract }]);
    const entity = web.entities.AgreementMilestone!;
    expect(entity.transitions).toEqual(contract.transitions as typeof entity.transitions);
    expect(entity.views.record!.operations.actions!.map((action) => action.id)).toEqual(expect.arrayContaining(["AgreementMilestone.trigger", "AgreementMilestone.cancel", "AgreementMilestone.invoice"]));
  });

  test("the invoice rule requires the invoice it names, under the finance role, and is the only other writer of that field", () => {
    const invoice = contract.pluginOperations!.find((candidate) => candidate.key === "invoice")!;
    expect(invoice.id).toBe("AgreementMilestone.invoice");
    expect(invoice.definition.auth).toEqual({ mode: "session", roles: ["Finance.All.ReadWrite"] });
    const schema = invoice.definition.input!.schema as { required: string[]; properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(["id", "producedInvoiceId"]);
    expect(schema.required).toEqual(["id", "producedInvoiceId"]);
    expect((invoice.definition.description as { en: string }).en).toContain("status: triggered -> invoiced");
    expect(invoice.interfaces.rest).toEqual({ method: "POST", path: "/api/rest/v1/agreement-milestones/:id/invoice" });
  });

  test("the lowered Operation passes the plugin Operation gates with a REST, MCP and GraphQL projection", () => {
    const compiled = collectAuthoredEntityPluginOperations(
      [{ contract }],
      { repoRoot: authoringDir, authoringDir, webPresent: false },
    ).find((candidate) => candidate.key === "AgreementMilestone.trigger");
    expect(compiled!.transports.rest).toMatchObject({ method: "POST", path: "/api/rest/v1/agreement-milestones/:id/trigger" });
    expect(compiled!.transports.mcp).toEqual({ enabled: true, name: "agreement_milestone_trigger" });
    expect(compiled!.transports.graphql).toMatchObject({ enabled: true, kind: "mutation" });
    expect((compiled!.inputSchema as { required: string[] }).required).toEqual(["id", "expectedVersion"]);
  });

  test("a constrained write must be a single reference and agree on persisted fields of this entity", () => {
    const rules = (writes: unknown[]) => withStatus({ transitions: { initial: "pending", rules: [{ key: "invoice", from: ["triggered"], to: "invoiced", writes }] } }, formless);
    expect(() => withStatusTransitions(rules([{ field: "expectedAt", agreesOn: ["agreementId"] }]), catalogs)).toThrow('constrains "expectedAt" with agreesOn, but it is not a single entity reference');
    expect(() => withStatusTransitions(rules([{ field: "producedInvoiceId", agreesOn: ["nothing"] }]), catalogs)).toThrow('agreesOn "nothing", which is not a persisted single comparable field');
    const { entity } = withStatusTransitions(rules(["producedInvoiceId"]), catalogs);
    expect((entity.operations!.invoice!.input!.schema as { required: string[] }).required).toEqual(["id"]);
  });

  test("across the corpus, the referenced entity must carry the agreed field as the same base type", () => {
    const invoice = compile(loadEntity(authoringDir, "invoice"));
    expect(() => assertTransitionAgreements([contract, invoice])).not.toThrow();
    // A plugin entity constraining a reference to a core entity is the same check, keyed by name.
    const pluginEntity = { ...contract, entity: { ...contract.entity, name: "PluginMilestone" }, transitions: contract.transitions!.map((status) => ({ ...status, rules: status.rules.map((rule) => ({ ...rule, operation: rule.operation.replace("AgreementMilestone", "PluginMilestone") })) })) };
    expect(() => assertTransitionAgreements([pluginEntity, invoice])).not.toThrow();
    expect(() => assertTransitionAgreements([pluginEntity])).toThrow('[PluginMilestone] PluginMilestone.invoice constrains "producedInvoiceId" with agreesOn, but it references no compiled entity');
    expect(() => assertTransitionAgreements([contract])).toThrow('references no compiled entity');
    const retyped = { ...invoice, storage: { ...invoice.storage, columns: invoice.storage.columns.map((column) => (column.field === "agreementId" ? { ...column, type: "text" } : column)) } };
    expect(() => assertTransitionAgreements([contract, retyped])).toThrow('Invoice.agreementId (string text) is not a persisted single field of the same type as AgreementMilestone.agreementId (string uuid)');
    const missing = { ...invoice, model: { ...invoice.model, fields: invoice.model.fields.filter((field) => field.key !== "agreementId") } };
    expect(() => assertTransitionAgreements([contract, missing])).toThrow('Invoice.agreementId (absent) is not a persisted single field');
  });

  test("across the corpus, a referenced precondition field must be a persisted single field of a compiled entity", () => {
    const agreement = compile(loadEntity(authoringDir, "agreement"));
    expect(() => assertTransitionReferencedPreconditions([contract, agreement])).not.toThrow();
    const pluginEntity = {
      ...contract,
      entity: { ...contract.entity, name: "PluginMilestone" },
      transitions: contract.transitions!.map((status) => ({
        ...status,
        rules: status.rules.map((rule) => ({
          ...rule,
          operation: rule.operation.replace("AgreementMilestone", "PluginMilestone"),
        })),
      })),
    };
    expect(() => assertTransitionReferencedPreconditions([pluginEntity, agreement])).not.toThrow();
    expect(() => assertTransitionReferencedPreconditions([pluginEntity])).toThrow(
      '[PluginMilestone] PluginMilestone.trigger precondition via "agreementId" references no compiled entity',
    );
    expect(() => assertTransitionReferencedPreconditions([contract])).toThrow("references no compiled entity");
    const withoutCode = {
      ...agreement,
      model: { ...agreement.model, fields: agreement.model.fields.filter((field) => field.key !== "code") },
    };
    expect(() => assertTransitionReferencedPreconditions([contract, withoutCode])).toThrow(
      'precondition "agreementId.code" is not a persisted single field of Agreement',
    );
    const unpersisted = {
      ...agreement,
      storage: { ...agreement.storage, columns: agreement.storage.columns.filter((column) => column.field !== "code") },
    };
    expect(() => assertTransitionReferencedPreconditions([contract, unpersisted])).toThrow(
      'precondition "agreementId.code" is not a persisted single field of Agreement',
    );
    const collection = {
      ...agreement,
      model: {
        ...agreement.model,
        fields: agreement.model.fields.map((field) => (field.key === "code" ? { ...field, cardinality: "collection" } : field)),
      },
    };
    expect(() => assertTransitionReferencedPreconditions([contract, collection])).toThrow(
      'precondition "agreementId.code" is not a persisted single field of Agreement',
    );

    const withIn = (
      patch: { field: string; in: Array<string | number | boolean> },
      target: typeof agreement = agreement,
      snapshot: Readonly<Record<string, ReadonlyArray<{ value: string }>>> = {},
    ) => {
      const entity = {
        ...contract,
        transitions: contract.transitions!.map((status) => ({
          ...status,
          rules: status.rules.map((rule) =>
            rule.key === "trigger"
              ? { ...rule, preconditions: [{ via: "agreementId", ...patch }] }
              : rule,
          ),
        })),
      };
      return () => assertTransitionReferencedPreconditions([entity, target], snapshot);
    };
    expect(withIn({ field: "code", in: ["AGR-1"] })).not.toThrow();
    expect(withIn({ field: "code", in: [1] })).toThrow('in value 1 is not a string');
    const objectField = {
      ...agreement,
      model: {
        ...agreement.model,
        fields: agreement.model.fields.map((field) => (field.key === "code" ? { ...field, baseType: "object" as const } : field)),
      },
    };
    expect(withIn({ field: "code", in: ["x"] }, objectField as typeof agreement)).toThrow("in requires a comparable field, not object");
    const optioned = {
      ...agreement,
      model: {
        ...agreement.model,
        fields: agreement.model.fields.map((field) =>
          field.key === "code"
            ? { ...field, options: { type: "static" as const, items: [{ value: "open", label: { en: "open" } }, { value: "closed", label: { en: "closed" } }] } }
            : field,
        ),
      },
    };
    expect(withIn({ field: "code", in: ["open"] }, optioned)).not.toThrow();
    expect(withIn({ field: "code", in: ["missing"] }, optioned)).toThrow("is not one of the static options");
    const grouped = {
      ...agreement,
      model: {
        ...agreement.model,
        fields: agreement.model.fields.map((field) =>
          field.key === "code"
            ? { ...field, options: { type: "referentiedata" as const, referentieGroep: "AGREEMENTKIND" } }
            : field,
        ),
      },
    };
    const snapshot = { AGREEMENTKIND: [{ value: "service" }, { value: "license" }] };
    expect(withIn({ field: "code", in: ["service"] }, grouped, snapshot)).not.toThrow();
    expect(withIn({ field: "code", in: ["missing"] }, grouped, snapshot)).toThrow(
      "is not one of the referentiedata group AGREEMENTKIND",
    );

    const retarget = (patch: { baseType?: string; validation?: { format?: string; min?: number; max?: number }; columnType?: string }) => ({
      ...agreement,
      model: {
        ...agreement.model,
        fields: agreement.model.fields.map((field) =>
          field.key === "code"
            ? { ...field, ...(patch.baseType ? { baseType: patch.baseType as typeof field.baseType } : {}), ...(patch.validation ? { validation: patch.validation } : {}) }
            : field,
        ),
      },
      storage: {
        ...agreement.storage,
        columns: agreement.storage.columns.map((column) =>
          column.field === "code" && patch.columnType ? { ...column, type: patch.columnType } : column,
        ),
      },
    });
    expect(withIn({ field: "code", in: ["2026-03-01T09:30:00.000Z"] }, retarget({ baseType: "datetime", columnType: "timestamptz" }))).not.toThrow();
    expect(withIn({ field: "code", in: ["not-a-datetime"] }, retarget({ baseType: "datetime", columnType: "timestamptz" }))).toThrow(
      'in value "not-a-datetime" is not a datetime',
    );
    expect(withIn({ field: "code", in: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"] }, retarget({ validation: { format: "uuid" }, columnType: "uuid" }))).not.toThrow();
    expect(withIn({ field: "code", in: ["not-a-uuid"] }, retarget({ validation: { format: "uuid" }, columnType: "uuid" }))).toThrow(
      'in value "not-a-uuid" is not a uuid',
    );
    expect(withIn({ field: "code", in: [10] }, retarget({ baseType: "integer", columnType: "integer" }))).not.toThrow();
    expect(withIn({ field: "code", in: [2_147_483_648] }, retarget({ baseType: "integer", columnType: "integer" }))).toThrow(
      "in value 2147483648 is out of range for integer",
    );
    expect(withIn({ field: "code", in: [11] }, retarget({ baseType: "integer", columnType: "integer", validation: { max: 10 } }))).toThrow(
      "in value 11 is out of range",
    );
    expect(withIn({ field: "code", in: [1.5] }, retarget({ baseType: "number", columnType: "numeric", validation: { max: 1 } }))).toThrow(
      "in value 1.5 is out of range",
    );
    expect(withIn({ field: "code", in: [1.5] }, retarget({ baseType: "number", columnType: "numeric", validation: { max: 2 } }))).not.toThrow();
    expect(withIn({ field: "code", in: [1.5] }, retarget({ baseType: "number", columnType: "integer" }))).toThrow(
      "in value 1.5 is not exact for integer",
    );
    expect(withIn({ field: "code", in: [2_147_483_648] }, retarget({ baseType: "integer", columnType: "bigint" }))).not.toThrow();
    expect(withIn({ field: "code", in: [2 ** 63] }, retarget({ baseType: "integer", columnType: "bigint" }))).toThrow(
      "in value 9223372036854776000 is out of range for bigint",
    );
  });

  test("an entity without transitions is returned untouched", () => {
    const plain = withStatus({ transitions: undefined });
    expect(withStatusTransitions(plain, catalogs)).toEqual({ entity: plain, transitions: [] });
  });
});

describe("status transition validation", () => {
  const rule = { key: "trigger", from: ["pending"], to: "triggered" };
  const lower = (entity: CoreEntity) => () => withStatusTransitions(entity, catalogs);

  test("requires static options and states from the option set", () => {
    expect(lower(withStatus({ options: { type: "referentiedata", referentieGroep: "X" } }))).toThrow("options.type: static");
    expect(lower(withStatus({ transitions: { initial: "open", rules: [rule] } }))).toThrow('initial "open"');
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, from: ["open"] }] } }))).toThrow('state "open"');
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, to: "done" }] } }))).toThrow('state "done"');
  });

  test("the default value is the initial state and the field is not otherwise written or edited", () => {
    expect(lower(withStatus({ defaultValue: "triggered" }))).toThrow("defaultValue must equal initial");
    expect(lower(withStatus({ writtenBy: ["Other.op"] }))).toThrow("only writers");
    expect(lower(withStatus({ immutable: true }))).toThrow("only writers");
    const edited = {
      ...milestone.coreEntity,
      interfaces: {
        ...milestone.coreEntity.interfaces,
        web: {
          ...milestone.coreEntity.interfaces!.web!,
          views: {
            ...milestone.coreEntity.interfaces!.web!.views!,
            record: {
              ...milestone.coreEntity.interfaces!.web!.views!.record!,
              modes: { update: { title: { en: "Edit" }, groups: [{ fields: ["status"] }] } },
            },
          },
        },
      },
    } as CoreEntity;
    expect(lower(edited)).toThrow('"status" cannot be edited in the update form');
    const editedWrite = { ...edited, fields: edited.fields.map((field) => field.key === "status"
      ? { ...field, transitions: { initial: "pending", rules: [{ ...rule, writes: ["expectedAt"] }] } } : field) } as CoreEntity;
    editedWrite.interfaces!.web!.views!.record!.modes = { update: { title: { en: "Edit" }, groups: [{ fields: ["expectedAt"] }] } };
    expect(lower(editedWrite)).toThrow('"expectedAt" cannot be edited in the update form; rule "trigger" writes it');
  });

  test("rule keys are unique and do not collide with the entity's operations", () => {
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [rule, rule] } }, formless))).toThrow("collides");
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, key: "update" }] } }, formless))).toThrow("collides");
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, key: "Trigger" }] } }, formless))).toThrow("must match");
  });

  test("writes and preconditions name persisted fields that nothing else writes", () => {
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, writes: ["missing"] }] } }, formless))).toThrow('writes "missing"');
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, writes: ["status"] }] } }, formless))).toThrow('writes "status"');
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, writes: ["amount"] }] } }, formless))).toThrow("already written elsewhere");
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [
      { ...rule, writes: ["triggeredAt"] },
      { key: "cancel", from: ["pending"], to: "cancelled", writes: ["triggeredAt"] },
    ] } }, formless))).toThrow('rule "trigger" already writes');
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, preconditions: [{ field: "nope", present: true }] }] } }, formless))).toThrow('precondition names "nope"');
  });

  test("a referenced precondition via must be a persisted single entity reference, with present or in", () => {
    const via = (preconditions: unknown[]) => withStatus({ transitions: { initial: "pending", rules: [{ ...rule, preconditions }] } }, formless);
    expect(lower(via([{ via: "nope", field: "code", present: true }]))).toThrow('precondition via "nope" is not a persisted single entity reference');
    expect(lower(via([{ via: "expectedAt", field: "code", present: true }]))).toThrow('precondition via "expectedAt" is not a persisted single entity reference');
    expect(lower(via([{ via: "producedInvoiceId", field: "code", present: true, in: ["x"] }]))).toThrow("must set present or in, not both");
    expect(lower(via([{ via: "agreementId", field: "code" }]))).toThrow("must set present or in, not both");
    expect(lower(via([{ via: "agreementId", field: "code", in: [] }]))).toThrow("in is empty");
    expect(lower(via([{ field: "expectedAt", in: ["x"] }]))).toThrow("precondition in requires via");
    const collection = {
      key: "agreements",
      osfType: "Agreement",
      baseType: "string",
      cardinality: "collection" as const,
      persisted: { column: "agreements", storageClass: "core" as const },
      relationship: { ownership: "reference" as const },
    };
    expect(lower(withStatus(
      { transitions: { initial: "pending", rules: [{ ...rule, preconditions: [{ via: "agreements", field: "code", present: true }] }] } },
      { ...formless, fields: [...milestone.coreEntity.fields, collection] },
    ))).toThrow('precondition via "agreements" is not a persisted single entity reference');
    expect(lower(via([{ via: "agreementId", field: "code", present: true }]))).not.toThrow();
    expect(lower(via([{ via: "agreementId", field: "status", in: ["active"] }]))).not.toThrow();
  });

  test("a written field that is required without a default would make the entity uncreatable", () => {
    const required = { ...milestone.coreEntity, fields: milestone.coreEntity.fields.map((field) => field.key === "triggeredBy" ? { ...field, required: true } : field) };
    const entity = (rules: unknown[]) => ({ ...withStatus({ transitions: { initial: "pending", rules } }, formless), fields: required.fields.map((field) => field.key === "status" ? { ...field, transitions: { initial: "pending", rules } } : field) } as CoreEntity);
    expect(lower(entity([{ ...rule, writes: ["triggeredBy"] }]))).toThrow("required without a defaultValue");
    expect(lower(entity([{ ...rule, stamps: [{ field: "triggeredBy", value: "actor" }] }]))).toThrow("required without a defaultValue");
    const defaulted = { ...entity([{ ...rule, writes: ["triggeredBy"] }]) };
    defaulted.fields = defaulted.fields.map((field) => field.key === "triggeredBy" ? { ...field, defaultValue: "system" } : field);
    expect(lower(defaulted)).not.toThrow();
  });

  test("stamps name a datetime field for now and a Relation reference or string for actor", () => {
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, stamps: [{ field: "triggeredBy", value: "now" }] }] } }, formless))).toThrow("not a datetime field");
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, stamps: [{ field: "triggeredAt", value: "actor" }] }] } }, formless))).toThrow("neither a Relation reference nor a string");
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, writes: ["triggeredAt"], stamps: [{ field: "triggeredAt", value: "now" }] }] } }, formless))).toThrow('rule "trigger" already writes');
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, stamps: [{ field: "expectedAt", value: "actor" }] }] } }, formless))).toThrow("neither a Relation reference nor a string");
    const relationField = { key: "actorRelationId", osfType: "Relation", baseType: "string", persisted: { column: "actor_relation_id", storageClass: "core" }, relationship: { ownership: "reference" } };
    const { entity, transitions } = withStatusTransitions(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, stamps: [{ field: "actorRelationId", value: "actor" }] }] } }, { ...formless, fields: [...milestone.coreEntity.fields, relationField] }), catalogs);
    expect(entity.fields.find((field) => field.key === "actorRelationId")!.writtenBy).toEqual(["AgreementMilestone.trigger"]);
    expect(transitions[0]!.rules[0]!.stamps).toEqual([{ field: "actorRelationId", value: "actor", actor: "relation" }]);
  });

  test("an ACL-protected entity gets recordPermission edit, which a rule may only restate; others may not name one", () => {
    const { entity, transitions } = withStatusTransitions(protectedEntity([rule]), catalogs);
    expect(entity.operations!.trigger!.auth).toEqual({ mode: "session", roles: ["Agreements.All.ReadWrite"], recordPermission: "edit" });
    expect(transitions[0]!.rules[0]!.recordPermission).toBe("edit");
    const restated = withStatusTransitions(protectedEntity([{ ...rule, auth: { recordPermission: "edit" } }]), catalogs);
    expect(restated.entity.operations!.trigger!.auth).toEqual({ mode: "session", roles: ["Agreements.All.ReadWrite"], recordPermission: "edit" });
    expect(lower(protectedEntity([{ ...rule, auth: { recordPermission: "view" } }]))).toThrow("requires edit");
    expect(lower(protectedEntity([{ ...rule, auth: { recordPermission: "delete" } }]))).toThrow("requires edit");
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, auth: { recordPermission: "edit" } }] } }, formless))).toThrow("no record-level permissions");
    expect(withStatusTransitions(withStatus({ transitions: { initial: "pending", rules: [rule] } }, formless), catalogs).entity.operations!.trigger!.auth).toEqual({ mode: "session", roles: ["Agreements.All.ReadWrite"] });
  });

  test("a rule may narrow the roles and require an acknowledgement", () => {
    const { entity } = withStatusTransitions(withStatus({ transitions: { initial: "pending", rules: [
      { ...rule, auth: { roles: ["Finance.All.ReadWrite"] }, confirmation: { mode: "acknowledgement" }, preconditions: [{ field: "expectedAt", present: true }] },
    ] } }, formless), catalogs);
    const definition = entity.operations!.trigger!;
    expect(definition.auth).toEqual({ mode: "session", roles: ["Finance.All.ReadWrite"] });
    expect(definition.confirmation).toEqual({ mode: "acknowledgement" });
    expect(entity.fields.find((field) => field.key === "status")!.writtenBy).toEqual(["AgreementMilestone.trigger"]);
  });
});
