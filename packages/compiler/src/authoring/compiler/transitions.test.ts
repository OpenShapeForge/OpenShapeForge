// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CoreEntity, Field } from "../types.js";
import { loadEntity } from "../loader.js";
import { compile } from "./index.js";
import { withStatusTransitions } from "./transitions.js";
import { buildWebManifest } from "../web-manifest.js";
import { collectAuthoredEntityPluginOperations } from "../../generate-operations.js";

const authoringDir = join(import.meta.dir, "../../../config/authoring");
const milestone = loadEntity(authoringDir, "agreement-milestone");
const catalogs = { componentCatalog: milestone.componentCatalog, osfTypes: milestone.osfTypes };

function withStatus(patch: Partial<Field> & { transitions?: Field["transitions"] }, entityPatch: Partial<CoreEntity> = {}): CoreEntity {
  const base = milestone.coreEntity;
  return {
    ...base,
    ...entityPatch,
    fields: base.fields.map((field) => (field.key === "status" ? { ...field, ...patch } : field)),
  };
}

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

  test("the input carries the id, the rule's writes fields and nothing else", () => {
    const schema = operation.definition.input!.schema as { required: string[]; properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["id", "triggeredAt", "triggeredBy"]);
    expect(schema.required).toEqual(["id"]);
    const output = operation.definition.output!.schema as { required: string[]; properties: Record<string, { enum?: string[] }> };
    expect(output.required).toEqual(["id", "status"]);
    expect(output.properties.status!.enum).toEqual(["pending", "triggered", "invoiced", "cancelled"]);
  });

  test("status and the writes fields are writtenBy the rule's Operation only", () => {
    for (const key of ["status", "triggeredAt", "triggeredBy"]) {
      expect(contract.model.fields.find((field) => field.key === key)!.writtenBy).toEqual(["AgreementMilestone.trigger"]);
    }
    expect(contract.model.fields.find((field) => field.key === "description")!.writtenBy).toBeUndefined();
  });

  test("the compiled rule table reaches the contract and the web manifest with the record action", () => {
    expect(contract.transitions).toEqual([{
      field: "status", initial: "pending",
      rules: [{ key: "trigger", operation: "AgreementMilestone.trigger", from: ["pending"], to: "triggered", label: { en: "Trigger", nl: "Triggeren" }, writes: ["triggeredAt", "triggeredBy"] }],
    }]);
    expect(contract.interfaces?.web?.operations).toBeDefined();
    const web = buildWebManifest([{ slug: "agreement-milestone", contract }]);
    const entity = web.entities.AgreementMilestone!;
    expect(entity.transitions).toEqual(contract.transitions);
    expect(entity.views.record!.operations.actions!.map((action) => action.id)).toContain("AgreementMilestone.trigger");
  });

  test("the lowered Operation passes the plugin Operation gates with a REST, MCP and GraphQL projection", () => {
    const [compiled] = collectAuthoredEntityPluginOperations(
      [{ contract }],
      { repoRoot: authoringDir, authoringDir, webPresent: false },
    );
    expect(compiled!.transports.rest).toMatchObject({ method: "POST", path: "/api/rest/v1/agreement-milestones/:id/trigger" });
    expect(compiled!.transports.mcp).toEqual({ enabled: true, name: "agreement_milestone_trigger" });
    expect(compiled!.transports.graphql).toMatchObject({ enabled: true, kind: "mutation" });
    expect((compiled!.inputSchema as { required: string[] }).required).toEqual(["id", "expectedVersion"]);
  });

  test("an entity without transitions is returned untouched", () => {
    const plain = withStatus({ transitions: undefined });
    expect(withStatusTransitions(plain, catalogs)).toEqual({ entity: plain, transitions: [] });
  });
});

describe("status transition validation", () => {
  const rule = { key: "trigger", from: ["pending"], to: "triggered" };
  const lower = (entity: CoreEntity) => () => withStatusTransitions(entity, catalogs);
  const formless = { interfaces: { ...milestone.coreEntity.interfaces, web: undefined } } as Partial<CoreEntity>;

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
    expect(lower(edited)).toThrow("cannot be edited in the update form");
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
