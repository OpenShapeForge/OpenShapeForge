// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CoreEntity, Field } from "../types.js";
import { loadEntity } from "../loader.js";
import { compile } from "./index.js";
import { withStatusTransitions } from "./transitions.js";
import { buildWebManifest } from "../web-manifest.js";
import { collectAuthoredEntityPluginOperations } from "../../generate-operations.js";
import { assertTransitionAgreements } from "./transitions.js";

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
      [{ contract }, { contract: compile(loadEntity(authoringDir, "invoice")) }],
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
    expect(() => assertTransitionAgreements([contract])).toThrow('references no compiled entity');
    const retyped = { ...invoice, storage: { ...invoice.storage, columns: invoice.storage.columns.map((column) => (column.field === "agreementId" ? { ...column, type: "text" } : column)) } };
    expect(() => assertTransitionAgreements([contract, retyped])).toThrow('Invoice.agreementId (string text) is not a persisted single field of the same type as AgreementMilestone.agreementId (string uuid)');
    const missing = { ...invoice, model: { ...invoice.model, fields: invoice.model.fields.filter((field) => field.key !== "agreementId") } };
    expect(() => assertTransitionAgreements([contract, missing])).toThrow('Invoice.agreementId (absent) is not a persisted single field');
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
    expect(lower(withStatus({ transitions: { initial: "pending", rules: [{ ...rule, stamps: [{ field: "agreementId", value: "actor" }] }] } }, formless))).toThrow("neither a Relation reference nor a string");
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
