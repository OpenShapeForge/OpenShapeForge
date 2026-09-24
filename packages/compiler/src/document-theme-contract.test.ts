// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadActivePlatformCompile } from "./active-manifest.js";
import { buildWebManifest } from "./authoring/web-manifest.js";

test("document themes are tenant-owned, selected on templates, and projected generically", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const compile = await loadActivePlatformCompile(root);
  const contract = compile.entities.find((entity) => entity.contract.entity.name === "DocumentTheme")!.contract;
  expect(contract.authorization.roles.read).toEqual([
    "Templates.Read",
    "Organization.All.ReadWrite",
    "General.All.Read",
    "General.All.ReadWrite",
    "CaseFile.All.Read",
    "CaseFile.All.ReadWrite",
  ]);
  expect(contract.authorization.roles.create).toEqual(["Organization.All.ReadWrite"]);
  expect(contract.authorization.roles.update).toEqual(["Organization.All.ReadWrite"]);
  expect(contract.authorization.roles.delete).toEqual(["Organization.All.ReadWrite"]);
  expect(Object.keys(contract.entityOperations).sort()).toEqual(["create", "delete", "get", "list", "update"]);
  const resolve = contract.pluginOperations?.find((operation) => operation.key === "resolve");
  expect(resolve?.definition.implementation).toEqual({
    type: "plugin",
    plugin: "documents",
    handler: "resolveDocumentTheme",
  });
  expect(resolve?.interfaces.rest).toMatchObject({ method: "POST", path: "/api/document-themes/resolve" });
  expect(resolve?.interfaces.mcp).not.toBe(false);
  const fields = Object.fromEntries(contract.model.fields.map((field) => [field.key, field]));
  expect(fields.isDefault?.defaultValue).toBe(false);
  expect(fields.surfaceColor?.validation?.pattern).toBe("^#[0-9A-Fa-f]{6}$");
  expect(JSON.stringify(fields.fontFamily)).toContain("source-sans");
  expect(fields.typography?.children?.map((child) => child.key)).toEqual([
    "body", "heading1", "heading2", "heading3", "quote", "list",
  ]);

  const table = compile.manifest.tables.find((candidate) => candidate.source?.authoringEntityName === "DocumentTheme");
  const columnNames = table?.columns.map((column) => column.name) ?? [];
  expect(columnNames).toEqual(expect.arrayContaining(["surface_color", "text_color", "accent_color", "font_family", "typography"]));
  expect(columnNames.some((name) => /logo|icon|css|storage/.test(name))).toBe(false);
  expect(contract.model.fields.some((field) => /logo|icon|css|storage/i.test(field.key))).toBe(false);
  expect(table?.indexes).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: "document_themes_tenant_default_uidx",
      unique: true,
      columns: ["tenant_id"],
      where: '"is_default" = true',
    }),
    expect.objectContaining({
      name: "document_themes_tenant_key_uidx",
      unique: true,
    }),
  ]));

  const template = compile.entities.find((entity) => entity.contract.entity.name === "Template")!.contract;
  const themeRef = template.model.fields.find((field) => field.key === "documentThemeId");
  expect(themeRef?.osfType).toBe("DocumentTheme");
  expect(themeRef?.required).toBe(false);
  expect(themeRef?.relationship?.ownership).toBe("reference");
  const variant = compile.entities.find((entity) => entity.contract.entity.name === "TemplateVariant")!.contract;
  expect(variant.model.fields.some((field) => field.key === "documentThemeId")).toBe(false);
  const document = compile.entities.find((entity) => entity.contract.entity.name === "Document")!.contract;
  expect(document.model.fields.some((field) => field.key === "documentThemeId")).toBe(false);
  const block = compile.entities.find((entity) => entity.contract.entity.name === "Block")!.contract;
  expect(block.model.fields.some((field) => /theme|color|font|css/i.test(field.key))).toBe(false);

  const web = buildWebManifest(compile.entities);
  expect(web.entities.DocumentTheme?.views.collection.route).toBe("/document-themes");
  expect(web.entities.DocumentTheme?.views.record?.routes.create).toBe("/document-themes/new");
  expect(web.entities.Template?.fields.documentThemeId).toBeDefined();
  expect(web.entities.TemplateVariant?.fields.documentThemeId).toBeUndefined();
}, 30_000);
