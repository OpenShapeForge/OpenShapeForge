// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadActivePlatformCompile } from "./active-manifest.js";
import { buildWebManifest } from "./authoring/web-manifest.js";

test("managed document type operations preserve read access and separate deletion", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const compile = await loadActivePlatformCompile(root);
  const contract = compile.entities.find(entity => entity.contract.entity.name === "DocumentType")!.contract;
  expect(contract.authorization.roles.read).toContain("CaseFile.All.ReadWrite");
  expect(contract.authorization.roles.read).toContain("DocumentTypes.All.Delete");
  expect(contract.authorization.roles.create).toEqual(["CaseFile.All.ReadWrite"]);
  expect(contract.authorization.roles.update).toEqual(["CaseFile.All.ReadWrite"]);
  expect(contract.authorization.roles.delete).toEqual(["DocumentTypes.All.Delete"]);
  expect(contract.hardDelete).toEqual({ requireNeverPublished: true });
  expect(Object.keys(contract.entityOperations).sort()).toEqual(["create", "delete", "get", "list", "update"]);
  const defaults = Object.fromEntries(contract.model.fields.map(field => [field.key, field.defaultValue]));
  expect(defaults.requiresRegistration).toBe(true);
  expect(defaults.allowsExternalPublication).toBe(false);
  expect(defaults.defaultConfidentiality).toBeUndefined();
  const web = buildWebManifest(compile.entities).entities.DocumentType!;
  expect(web.displayTemplate).toBe("{{name}}");
  expect(web.views.collection.route).toBe("/document-types");
  expect(web.views.record?.routes.create).toBe("/document-types/new");
  expect(web.operations.create).toBeDefined();
  expect(web.operations.delete).toBeDefined();
  expect(contract.entityOperations.delete).toMatchObject({
    authorization: { roles: ["DocumentTypes.All.Delete"] },
    concurrency: { version: { mode: "required", field: "updatedAt" } },
    interaction: { confirmation: { mode: "acknowledgement" } },
  });
  const version = compile.entities.find(entity => entity.contract.entity.name === "DocumentTypeVersion")!.contract;
  expect(version.entityOperations.delete).toBeUndefined();
  expect(version.authorization.roles.delete).toEqual([]);
  const document = buildWebManifest(compile.entities).entities.Document!;
  expect(document.fields.documentType!.optionSource).toEqual({
    type: "entity", source: "DocumentType", valueField: "code",
  });
  expect(document.fields.documentType!.options).toBeUndefined();
}, 30_000);
