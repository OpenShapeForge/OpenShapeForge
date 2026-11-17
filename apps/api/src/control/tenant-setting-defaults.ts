// SPDX-License-Identifier: BUSL-1.1
import { sql, type Transaction } from "kysely";
import { COLOR_SETTINGS_NAMESPACE, COLOR_SETTINGS_KEY } from "@openshapeforge/operations";
import type { RuntimeTenantSettingDefault } from "@openshapeforge/plugin-runtime";
import type { RuntimeModule } from "../modules/contract.js";
import type { DB } from "../generated/db/types.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withSystemSession, SYSTEM_BYPASS_ROLE } from "../db/session.js";
import { generatedRuntimeFieldSchemas } from "../modules/field-schemas.js";
import { assertTypedDefinitionSupported } from "../operations/entity/typed-values.js";
import manifest from "../generated/db/manifest.json" with { type: "json" };
import type { GeneratedCrudTable } from "../operations/entity/types.js";

function hasConfidentialDefinition(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasConfidentialDefinition);
  const record = value as Record<string, unknown>;
  return (record.classification as { sensitivity?: unknown } | undefined)?.sensitivity === 'confidential'
    || Object.values(record).some(hasConfidentialDefinition);
}

export const paletteSettingDefault: RuntimeTenantSettingDefault = {
  namespace: COLOR_SETTINGS_NAMESPACE, key: COLOR_SETTINGS_KEY,
  definition: { key: "value", osfType: "colorPalette", label: { en: "Custom colors", nl: "Eigen kleuren" } },
  value: { colors: [] }, description: "Eigen kleuren / Custom colors",
};

/** Validate through the same typed-value contract as ordinary TenantSetting CRUD. */
export function tenantSettingDefaultsOf(modules: readonly Pick<RuntimeModule, "tenantSettingDefaults">[] = []): readonly RuntimeTenantSettingDefault[] {
  const policy = (manifest.tables as GeneratedCrudTable[]).find(table => table.source?.authoringEntityName === "TenantSetting")?.columns.find(column => column.name === "value")?.typedBy;
  if (!policy) throw new Error("Canonical TenantSetting typed-value policy is required.");
  const defaults = [paletteSettingDefault, ...modules.flatMap(module => module.tenantSettingDefaults ?? [])];
  const slots = new Set<string>();
  for (const entry of defaults) {
    if (!entry.namespace?.trim() || entry.namespace.length > 120 || !entry.key?.trim() || entry.key.length > 120 || (entry.description?.length ?? 0) > 500)
      throw new Error("Invalid tenant-variable default identity.");
    const slot = JSON.stringify([entry.namespace, entry.key]);
    if (slots.has(slot)) throw new Error(`Duplicate tenant-variable default: ${entry.namespace}/${entry.key}.`);
    slots.add(slot);
    if (hasConfidentialDefinition(entry.definition) && entry.value != null)
      throw new Error("Confidential tenant-variable defaults must be unset.");
    if (entry.definition?.key !== "value" || !generatedRuntimeFieldSchemas.validateObject([entry.definition], entry.value == null ? {} : { value: entry.value }).valid)
      throw new Error(`Invalid typed default for ${entry.namespace}/${entry.key}.`);
    try { assertTypedDefinitionSupported(entry.definition, "value", "submitted", policy); }
    catch (cause) { throw new Error(`Invalid typed default for ${entry.namespace}/${entry.key}.`, { cause }); }
  }
  return defaults;
}

/** Short transaction-owned insert-only reconciliation; normal CRUD retains ownership of every existing row. */
export async function ensureTenantSettingDefaults(trx: Transaction<DB>, tenantId: string, defaults: readonly RuntimeTenantSettingDefault[]): Promise<number> {
  // Serialize the missing-row check against ordinary inserts too, without a new constraint on existing data.
  await sql`lock table erp.tenant_settings in share row exclusive mode`.execute(trx);
  let inserted = 0;
  for (const entry of defaults) {
    const result = await sql`
      insert into erp.tenant_settings(id,tenant_id,namespace,key,definition,value,description)
      select gen_random_uuid(),${tenantId}::uuid,${entry.namespace},${entry.key},
        ${JSON.stringify(entry.definition)}::text::jsonb,${entry.value == null ? null : JSON.stringify(entry.value)}::text::jsonb,${entry.description ?? null}
      where not exists(select 1 from erp.tenant_settings where tenant_id=${tenantId}::uuid and namespace=${entry.namespace} and key=${entry.key})
      returning id
    `.execute(trx);
    inserted += result.rows.length;
  }
  return inserted;
}

/** Migration/backfill and future tenant provisioning use the same owner-supplied definitions. */
export async function backfillTenantSettingDefaults(db: OpenShapeForgeDatabase, modules: readonly RuntimeModule[] = []) {
  const defaults = tenantSettingDefaultsOf(modules);
  return withSystemSession(db, { actorSubject: "tenant-variable-defaults", roles: [SYSTEM_BYPASS_ROLE], reason: "Insert missing declared tenant-variable defaults; preserve all existing values" }, async trx => {
    const tenants = await sql<{ id: string }>`select id from erp.tenants order by id`.execute(trx);
    let inserted = 0;
    for (const tenant of tenants.rows) inserted += await ensureTenantSettingDefaults(trx, tenant.id, defaults);
    return { tenants: tenants.rows.length, inserted };
  });
}
