// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { operationErrorOf } from "@openshapeforge/operations";
import type { ModuleOperationContext } from "@openshapeforge/plugin-runtime";
import { list, get, set, reset, profile } from "./runtime.js";
import { catalogMigration } from "./index.js";

const field = { key: "locale", valueType: "string", defaultValue: "nl", label: { en: "Language" } };
function harness() {
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const values = new Map<string, unknown>();
  const session = { userId: "20000000-0000-4000-8000-000000000001", tenantId: "10000000-0000-4000-8000-000000000001", roles: [], groups: [], scope: "tenant", credential: "bearer" };
  const validationCalls: unknown[] = [];
  const context = { session, platform: { schemas: { fields: {
    object: (fields: unknown[]) => { expect(fields).toEqual([field]); return { properties: { locale: { type: "string", enum: ["nl", "en"] } } }; },
    validateObject: (fields: unknown[], value: Record<string, unknown>) => {
      validationCalls.push({ fields, value });
      return ["nl", "en"].includes(String(value.locale)) ? { valid: true } : { valid: false, error: { code: "VALIDATION_FAILED", message: "Invalid language", retryable: false } };
    },
  } }, db: { withSession: async (received: unknown, work: (db: unknown) => unknown) => {
    expect(received).toBe(session);
    const owner = `${session.tenantId}:${session.userId}`;
    return work({ executeQuery: async (query: { sql: string; parameters: readonly unknown[] }) => {
      statements.push(query);
      if (query.sql.startsWith("insert")) values.set(owner, JSON.parse(String(query.parameters[2])));
      if (query.sql.startsWith("delete")) values.delete(owner);
      if (!query.sql.startsWith("select")) return { rows: [] };
      if (query.parameters[1] && query.parameters[1] !== "locale") return { rows: [] };
      return { rows: [{ namespace: "ui", key: "locale", definition: field, hasOverride: values.has(owner), value: values.get(owner) }] };
    } });
  } } } } as unknown as ModuleOperationContext;
  return { context, session, statements, values, validationCalls };
}
async function errorCode(work: () => unknown) { try { await work(); return null; } catch(error) { return operationErrorOf(error)?.code; } }

test("effective default includes exact definition and projected schema without storing a row", async () => {
  const h = harness();
  const result = await list({}, h.context);
  expect(result).toEqual({ value: { items: [{ namespace: "ui", key: "locale", field, schema: { type: "string", enum: ["nl", "en"] }, value: "nl", hasOverride: false }] } });
  expect(h.values.size).toBe(0);
});
test("set uses canonical value validation, server owner and reset restores default", async () => {
  const h = harness();
  expect(await set({ namespace: "ui", key: "locale", value: "en" }, h.context)).toMatchObject({ value: { item: { value: "en", hasOverride: true } } });
  expect(h.validationCalls).toEqual([{ fields: [field], value: { locale: "en" } }]);
  const insert = h.statements.find((s) => s.sql.startsWith("insert"))!;
  expect(insert.sql).toContain("app.current_user_id()");
  expect(insert.sql).toContain("app.current_tenant()");
  expect(insert.parameters).toEqual(["ui", "locale", '"en"']);
  expect(await reset({ namespace: "ui", key: "locale" }, h.context)).toMatchObject({ value: { item: { value: "nl", hasOverride: false } } });
});
test("owner input, unknown keys and invalid values fail without writes", async () => {
  const h = harness();
  expect(await errorCode(() => set({ namespace: "ui", key: "locale", value: "en", ownerUserId: "other" }, h.context))).toBe("VALIDATION");
  expect(await errorCode(() => set({ namespace: "ui", key: "unknown", value: "en" }, h.context))).toBe("NOT_FOUND");
  expect(await errorCode(() => set({ namespace: "ui", key: "locale", value: "xx" }, h.context))).toBe("VALIDATION_FAILED");
  expect(h.values.size).toBe(0);
});
test("user and tenant changes resolve isolated overrides", async () => {
  const h = harness();
  await set({ namespace: "ui", key: "locale", value: "en" }, h.context);
  h.session.userId = "20000000-0000-4000-8000-000000000002";
  expect(await get({ namespace: "ui", key: "locale" }, h.context)).toMatchObject({ value: { item: { value: "nl", hasOverride: false } } });
  h.session.userId = "20000000-0000-4000-8000-000000000001";
  h.session.tenantId = "10000000-0000-4000-8000-000000000002";
  expect(await get({ namespace: "ui", key: "locale" }, h.context)).toMatchObject({ value: { item: { value: "nl", hasOverride: false } } });
  for (const q of h.statements.filter((s) => s.sql.startsWith("select"))) expect(q.sql).toContain("p.owner_user_id = app.current_user_id()");
});
test("profile uses confirmed host session only and refuses pending candidate", async () => {
  const h = harness();
  h.context.session!.relation = { status: "pending_confirmation", relationId: null, candidateRelationId: "candidate" };
  expect(await errorCode(() => profile({}, h.context))).toBe("NOT_FOUND");
  h.context.session!.relation = { status: "linked", relationId: "own", displayName: "Own profile" };
  expect(await profile({}, h.context)).toEqual({ value: { relationId: "own", displayName: "Own profile" } });
  expect(await errorCode(() => profile({ relationId: "other" }, h.context))).toBe("VALIDATION");
});
test("definition catalog mutation requires managed bypass", () => {
  expect(catalogMigration).toContain("force row level security");
  expect(catalogMigration).toContain("with check (app.bypass_rls())");
});
