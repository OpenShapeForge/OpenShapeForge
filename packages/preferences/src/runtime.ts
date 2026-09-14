// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, ModuleOperationHandler, RuntimeModule } from "@openshapeforge/plugin-runtime";
import { query, type Executor } from "./sql.js";
import { preferenceDefinitionsSeed } from "./seed.js";

type Row = { namespace: string; key: string; definition: Record<string, unknown>; value: unknown; hasOverride: boolean };
const SELECT = `select d.namespace, d.key, d.definition, p.value,
  (p.id is not null) as "hasOverride" from platform.preference_definitions d
  left join erp.personal_preferences p on p.namespace = d.namespace and p.key = d.key
  and p.tenant_id = app.current_tenant() and p.owner_user_id = app.current_user_id()`;

function failure(code: string, message: string): never { throw operationFailure({ code, message, retryable: false }); }
function inputCheck(input: Record<string, unknown>, action: string) {
  const allowed = action === "list" ? ["namespace"] : action === "set" ? ["namespace", "key", "value"] : ["namespace", "key"];
  if (Object.keys(input).some((key) => !allowed.includes(key)) || (input.namespace !== undefined && (typeof input.namespace !== "string" || !/^[a-z][a-z0-9.-]{0,119}$/.test(input.namespace)))) failure("VALIDATION", "Check the preference namespace and input.");
  if (action !== "list" && (typeof input.namespace !== "string" || typeof input.key !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(input.key))) failure("VALIDATION", "A preference namespace and key are required.");
  if (action === "set" && !Object.hasOwn(input, "value")) failure("VALIDATION", "A preference value is required.");
}
function project(row: Row, context: ModuleOperationContext) {
  if (!context.platform) failure("OPERATION_UNAVAILABLE", "Preference services are unavailable.");
  const object = context.platform.schemas.fields.object([row.definition]);
  const properties = object.properties as Record<string, unknown>;
  return { namespace: row.namespace, key: row.key, field: row.definition, schema: properties[row.key],
    value: row.hasOverride ? row.value : row.definition.defaultValue ?? null, hasOverride: row.hasOverride };
}
function handler(action: "list" | "get" | "set" | "reset"): ModuleOperationHandler {
  return async (input, context) => {
    const session = context.session;
    if (!session?.tenantId || !session.userId) failure("UNAUTHENTICATED", "Sign in to use your preferences.");
    const platform = context.platform;
    if (!platform) failure("OPERATION_UNAVAILABLE", "Preference services are unavailable.");
    inputCheck(input, action);
    return platform.db.withSession(session, async (transaction) => {
      const db = transaction as unknown as Executor;
      const where = action === "list" ? (input.namespace === undefined ? "" : " where d.namespace = $1") : " where d.namespace = $1 and d.key = $2";
      const parameters = action === "list" ? (input.namespace === undefined ? [] : [input.namespace]) : [input.namespace, input.key];
      const read = async () => (await db.executeQuery<Row>(query(`${SELECT}${where} order by d.namespace, d.key`, parameters))).rows;
      const rows = await read();
      if (action === "list") return { value: { items: rows.map((row) => project(row, context)) } };
      const row = rows[0];
      if (!row) failure("NOT_FOUND", "This preference is not available.");
      if (action === "set") {
        const validation = platform.schemas.fields.validateObject([row.definition], { [row.key]: input.value });
        if (!validation.valid) throw operationFailure(validation.error);
        await db.executeQuery(query(`insert into erp.personal_preferences (id, tenant_id, owner_user_id, namespace, key, value)
          values (gen_random_uuid(), app.current_tenant(), app.current_user_id(), $1, $2, $3::text::jsonb)
          on conflict (tenant_id, owner_user_id, namespace, key) do update set value = excluded.value, updated_at = now()`,
        [row.namespace, row.key, JSON.stringify(input.value)]));
      }
      if (action === "reset") await db.executeQuery(query(`delete from erp.personal_preferences
        where tenant_id = app.current_tenant() and owner_user_id = app.current_user_id() and namespace = $1 and key = $2`, [row.namespace, row.key]));
      return { value: { item: project(action === "get" ? row : (await read())[0]!, context) } };
    });
  };
}
export const list = handler("list");
export const get = handler("get");
export const set = handler("set");
export const reset = handler("reset");
export const profile: ModuleOperationHandler = (input, context) => {
  if (!context.session?.tenantId || !context.session.userId) failure("UNAUTHENTICATED", "Sign in to view your profile.");
  if (Object.keys(input).length) failure("VALIDATION", "Profile lookup takes no input.");
  const link = context.session.relation as { status?: unknown; relationId?: unknown; displayName?: unknown } | null;
  if (link?.status !== "linked" || typeof link.relationId !== "string") failure("NOT_FOUND", "Your profile has not been confirmed yet.");
  return { value: { relationId: link.relationId, displayName: typeof link.displayName === "string" ? link.displayName : null } };
};
export default { name: "preferences", operationHandlers: { list, get, set, reset, profile }, seeds: [preferenceDefinitionsSeed] } satisfies RuntimeModule;
