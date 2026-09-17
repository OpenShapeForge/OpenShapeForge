// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { compile } from "./compiler/index.js";
import { loadEntity } from "./loader.js";
import { createAuthoringValidator } from "./schema-validation.js";
import { buildWebManifest } from "./web-manifest.js";
import { compiledObjectSchema } from "../field-json-schema.js";
import { operationI18nKeyword } from "@openshapeforge/operations";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const dir = join(import.meta.dir, "../../config/authoring");

test("real v3 case templates retain inline action values and ordinary top-level FK relationships", () => {
  const step = compile(loadEntity(dir, "case-step-template"));
  const parent = compile(loadEntity(dir, "case-template"));
  for (const slug of ["case-step-template", "case-template"]) {
    const yaml = parse(readFileSync(join(dir, "entities/core", `${slug}.yaml`), "utf8"));
    expect(yaml.schemaVersion).toBe(3);
    expect(() => createAuthoringValidator().validate(yaml, slug)).not.toThrow();
  }
  const actions = step.model.fields.find(field => field.key === "actions")!;
  expect(actions.cardinality).toBe("collection");
  expect(step.storage.columns.find(column => column.field === "actions")).toMatchObject({ column: "actions", type: "jsonb" });
  expect(step.model.relationships.find(relation => relation.fieldKey === "defaultWorkQueueId")).toMatchObject({ kind: "belongsTo", target: "WorkQueue", foreignKey: "default_work_queue_id" });
  expect(parent.model.relationships.find(relation => relation.fieldKey === "steps")).toMatchObject({ kind: "hasMany", target: "CaseStepTemplate", inverse: "templateId", foreignKey: "case_template_id" });
  const task = actions.item!.children!.find(field => field.key === "taskTemplate")!;
  const queue = task.children!.find(field => field.key === "defaultWorkQueueId")!;
  expect(queue).toMatchObject({ osfType: "workQueueId", baseType: "string", options: { type: "remote", remoteUrl: "/api/workflow/designer/core-entity-options?entity=work-queue" } });
  expect(queue.relationship).toBeUndefined();
  expect(step.model.relationships.some(relation => relation.fieldKey === "actions")).toBe(false);
  expect(step.storage.columns.filter(column => /work_queue/.test(column.column))).toHaveLength(1);

  const ajv = new Ajv2020({ strict: true });
  ajv.addKeyword(operationI18nKeyword);
  const validate = ajv.compile(compiledObjectSchema([actions], {}, { requireRequired: true }));
  const value = { actions: [
    { key: "later", sequenceNumber: 20, kind: "task", required: true, startMode: "manual", taskTemplate: { title: "First in array", defaultWorkQueueId: "00000000-0000-4000-8000-000000000001" } },
    { key: "earlier", sequenceNumber: 10, kind: "task", required: false, startMode: "manual", taskTemplate: { title: "Second in array", description: "Preserved nested text", assignmentMetadata: { role: "operator" } } },
  ] };
  const roundtrip = JSON.parse(JSON.stringify(value));
  expect(validate(roundtrip)).toBe(true);
  expect(roundtrip).toEqual(value);
  expect(roundtrip.actions.map((action: { key: string }) => action.key)).toEqual(["later", "earlier"]);
  expect(validate({ actions: [{ ...value.actions[0], sequenceNumber: "not an integer" }] })).toBe(false);
});

test("a Web projection preserves nested identifier metadata without inventing a nested relation", () => {
  const loaded = loadEntity(dir, "case-step-template");
  // Isolated projection exercise: the real source has only field metadata,
  // so this does not add a production screen or change its exposure.
  loaded.coreEntity.interfaces!.web!.views = {
    collection: { route: "/test-step-templates", columns: [{ key: "name" }] },
    record: { title: "{{name}}", layout: { tabs: [{ id: "actions", fields: ["actions"] }] } },
  };
  const contract = compile(loaded);
  const web = buildWebManifest([{ slug: "case-step-template", contract }]);
  const actions = web.entities.CaseStepTemplate!.fields.actions!;
  const queue = actions.item!.children!.find(field => field.key === "taskTemplate")!.children!.find(field => field.key === "defaultWorkQueueId")!;
  expect(queue).toMatchObject({ osfType: "workQueueId", optionSource: { type: "remote", source: "/api/workflow/designer/core-entity-options?entity=work-queue" }, presentation: { component: "OptionVariablePicker", props: { valueMode: "selectId", clearable: true } } });
  expect(queue.relationship).toBeUndefined();
});
