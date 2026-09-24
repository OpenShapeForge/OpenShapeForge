// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { ModuleOperationContext } from "@openshapeforge/plugin-runtime";
import { resolveDocumentTheme } from "./theme-runtime.js";

const tenant = "20000000-0000-4000-8000-000000000001";
const otherTenant = "20000000-0000-4000-8000-000000000099";
const themeId = "20000000-0000-4000-8000-000000000010";
const defaultId = "20000000-0000-4000-8000-000000000011";
const templateId = "20000000-0000-4000-8000-000000000020";
const versionId = "20000000-0000-4000-8000-000000000021";
const documentId = "20000000-0000-4000-8000-000000000022";

const themeRow = (id: string, color: string, isDefault = false) => ({
  id, key: id === defaultId ? "default" : "brand", name: "Theme", isDefault, surfaceColor: color,
  textColor: "#111827", accentColor: "#2563eb", fontFamily: "dm-sans",
  typography: {
    body: { fontSize: 11, lineHeight: 1.5, fontWeight: 400, colorRole: "text" },
    heading1: { fontSize: 22, lineHeight: 1.25, fontWeight: 700, colorRole: "text" },
    heading2: { fontSize: 16, lineHeight: 1.3, fontWeight: 700, colorRole: "text" },
    heading3: { fontSize: 13, lineHeight: 1.35, fontWeight: 700, colorRole: "text" },
    quote: { fontSize: 11, lineHeight: 1.5, fontWeight: 400, colorRole: "text" },
    list: { fontSize: 11, lineHeight: 1.5, fontWeight: 400, colorRole: "text" },
  },
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function context(queries: Array<{ sql: string; rows: unknown[] }>): ModuleOperationContext & { seen: string[] } {
  const seen: string[] = [];
  return {
    transport: "operation",
    session: { tenantId: tenant, userId: tenant, credential: "bearer", roles: ["CaseFile.All.Read"], groups: [], scope: "tenant" },
    platform: {
      records: { assertAccess: async () => undefined },
      db: {
        withSession: async (_session: unknown, work: (trx: unknown) => Promise<unknown>) => work({
          executeQuery: async (query: { sql: string }) => {
            seen.push(query.sql);
            const match = queries.find((entry) => query.sql.includes(entry.sql));
            if (!match) throw new Error(`unexpected query: ${query.sql}`);
            return { rows: match.rows };
          },
        }),
      },
    },
    seen,
  } as unknown as ModuleOperationContext & { seen: string[] };
}

describe("DocumentTheme.resolve", () => {
  test("refuses mixed or empty sources and a missing tenant", async () => {
    const ctx = context([]);
    await expect(resolveDocumentTheme({}, ctx)).rejects.toMatchObject({ operationError: { code: "VALIDATION" } });
    await expect(resolveDocumentTheme({ documentId, templateId }, ctx)).rejects.toMatchObject({ operationError: { code: "VALIDATION" } });
    const noTenant = { ...ctx, session: { ...ctx.session!, tenantId: null } };
    await expect(resolveDocumentTheme({ templateId }, noTenant)).rejects.toMatchObject({ operationError: { code: "UNAUTHENTICATED" } });
  });

  test("a template uses its stored theme, then live token values, never another tenant's row", async () => {
    const ctx = context([
      { sql: "from erp.templates", rows: [{ document_theme_id: themeId }] },
      { sql: "from erp.document_themes where tenant_id = $1 and id = $2", rows: [themeRow(themeId, "#ff0000")] },
    ]);
    const result = await resolveDocumentTheme({ templateId }, ctx) as { value: { theme: { id: string; surfaceColor: string }; resolution: { kind: string; sourceId: string; themeId: string } } };
    expect(result.value.resolution).toEqual({ kind: "template", sourceId: templateId, themeId });
    expect(result.value.theme).toMatchObject({ id: themeId, surfaceColor: "#ff0000" });
    expect(JSON.stringify(result.value)).not.toContain(otherTenant);
  });

  test("a published version and a document keep the snapshot theme id and follow live values", async () => {
    const snapshot = { schemaVersion: 1, entity: "Template", head: { table: "templates", row: { document_theme_id: themeId }, children: {} } };
    const versionCtx = context([
      { sql: "from erp.template_versions", rows: [{ snapshot }] },
      { sql: "from erp.document_themes where tenant_id = $1 and id = $2", rows: [themeRow(themeId, "#00aa00")] },
    ]);
    const version = await resolveDocumentTheme({ templateVersionId: versionId }, versionCtx) as { value: { theme: { surfaceColor: string }; resolution: { kind: string } } };
    expect(version.value.resolution.kind).toBe("template-version");
    expect(version.value.theme.surfaceColor).toBe("#00aa00");

    const documentCtx = context([
      { sql: "from erp.documents", rows: [{ template_version_id: versionId }] },
      { sql: "from erp.template_versions", rows: [{ snapshot }] },
      { sql: "from erp.document_themes where tenant_id = $1 and id = $2", rows: [themeRow(themeId, "#0000aa")] },
    ]);
    const document = await resolveDocumentTheme({ documentId }, documentCtx) as { value: { theme: { surfaceColor: string }; resolution: { kind: string } } };
    expect(document.value.resolution.kind).toBe("template-version");
    expect(document.value.theme.surfaceColor).toBe("#0000aa");
    const statements = [...versionCtx.seen, ...documentCtx.seen].join("\n");
    expect(statements).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(statements).not.toContain("document_versions");
  });

  test("an older template without a selection stays unthemed", async () => {
    const ctx = context([
      { sql: "from erp.templates", rows: [{ document_theme_id: null }] },
    ]);
    const result = await resolveDocumentTheme({ templateId }, ctx) as { value: { theme: null; resolution: { kind: string; sourceId: string; themeId: null } } };
    expect(result.value.resolution).toEqual({ kind: "none", sourceId: templateId, themeId: null });
    expect(result.value.theme).toBeNull();
    expect(ctx.seen.join("\n")).not.toContain("document_themes");
  });

  test("a deleted selected theme fails instead of silently changing an existing document", async () => {
    const ctx = context([
      { sql: "from erp.templates", rows: [{ document_theme_id: themeId }] },
      { sql: "from erp.document_themes where tenant_id = $1 and id = $2", rows: [] },
    ]);
    await expect(resolveDocumentTheme({ templateId }, ctx)).rejects.toMatchObject({ operationError: { code: "NOT_FOUND" } });
  });

  test("an unavailable stored font is an error rather than a silent substitute", async () => {
    const ctx = context([
      { sql: "from erp.templates", rows: [{ document_theme_id: themeId }] },
      { sql: "from erp.document_themes where tenant_id = $1 and id = $2", rows: [{ ...themeRow(themeId, "#ffffff"), fontFamily: "system" }] },
    ]);
    await expect(resolveDocumentTheme({ templateId }, ctx)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
  });

  test("corrupt stored colors and typography fail instead of changing document styling", async () => {
    const valid = themeRow(themeId, "#ffffff");
    const broken = [
      { ...valid, surfaceColor: "var(--app-color)" },
      { ...valid, typography: null },
      { ...valid, typography: { ...valid.typography, body: null } },
      { ...valid, typography: { ...valid.typography, body: { ...valid.typography.body, fontSize: 100 } } },
      { ...valid, typography: { ...valid.typography, body: { ...valid.typography.body, lineHeight: "1.5" } } },
      { ...valid, typography: { ...valid.typography, body: { ...valid.typography.body, colorRole: "app" } } },
      { ...valid, typography: { ...valid.typography, body: { ...valid.typography.body, spaceBefore: -1 } } },
    ];
    for (const row of broken) {
      const ctx = context([
        { sql: "from erp.templates", rows: [{ document_theme_id: themeId }] },
        { sql: "from erp.document_themes where tenant_id = $1 and id = $2", rows: [row] },
      ]);
      await expect(resolveDocumentTheme({ templateId }, ctx)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
    }
  });

  test("a malformed theme id in a published snapshot is an invalid state", async () => {
    const ctx = context([
      { sql: "from erp.template_versions", rows: [{ snapshot: { schemaVersion: 1, entity: "Template", head: { row: { document_theme_id: "bad" } } } }] },
    ]);
    await expect(resolveDocumentTheme({ templateVersionId: versionId }, ctx)).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
  });
});
