// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../connection.js";
import { databaseRole } from "../database-roles.js";
import { APP_ROLE } from "./app-role.js";
import { WORKER_ROLE } from "./worker-role.js";

const RESOLVER_ROLE = databaseRole("recordActionResolver").name;

/**
 * The record-action point lookup: does this session hold ONE named action on
 * ONE record?
 *
 * WHY IT CANNOT BE AN ORDINARY READ
 * ---------------------------------
 * A named action must be authorizable WITHOUT the record becoming readable —
 * that is the whole reason the axis exists. The generated row-scope policy
 * gates SELECT on the record's `view` permission and is NOT touched here, so
 * the app role cannot see the row it is being authorized against. Something
 * has to read the ACL column on its behalf.
 *
 * WHY NOT app.bypass_rls
 * ----------------------
 * Because that setting is a GLOBAL bypass and any role holding a connection
 * can set it (verified on PostgreSQL 17: a NOSUPERUSER NOBYPASSRLS role runs
 * `set_config('app.bypass_rls','true',true)` and reads every tenant's rows;
 * `revoke set on parameter` records nothing for a placeholder GUC, so it
 * cannot be locked down either). Reaching for it here would add a second
 * dependency on the weakest mechanism in the system, and would break outright
 * in a deployment that does manage to restrict it. The three existing uses
 * (api_key_tenant, capability_grant_tenant, the versioned 0017 migration) are
 * pre-existing and out of this change's scope; nothing new joins them.
 *
 * WHAT IS GRANTED INSTEAD
 * -----------------------
 * The shape identity-link.ts already uses: a dedicated NOLOGIN NOSUPERUSER
 * NOBYPASSRLS role owns a SECURITY DEFINER function, and is admitted by a
 * role-targeted policy to exactly the rows and columns that one question
 * needs. Per ACL-action entity the resolver gets:
 *
 *   - `select (<key>, tenant_id, <acl column>)` — column-level, so a `secret`
 *     column on the same row is "permission denied for table", not a leak;
 *   - `update (<acl column>)` with a `for update using (true) with check
 *     (false)` policy. UPDATE privilege is what PostgreSQL requires for `FOR
 *     SHARE`, and `with check (false)` is what makes the write impossible: the
 *     resolver may LOCK an ACL row and may never change one;
 *   - `for select to <resolver> using (true)` — the row is visible to the
 *     resolver only, never to the app role, and only through this function.
 *
 * EXECUTE is revoked from PUBLIC and from the worker role, and granted to the
 * app role alone: no worker-side action check is supported yet. That revoke is
 * why this migration runs LAST among the privilege steps — `applyAppRoleGrants`
 * and `applyWorkerRoleGrants` sweep EXECUTE over every function in `app` and
 * set a default privilege that catches later ones, so anything granted before
 * them is widened again.
 *
 * WHY THERE IS NO CALLER-CONTROLLED IDENTIFIER
 * --------------------------------------------
 * The function takes an entity NAME, a record key and an action name. Nothing
 * else. The table, its key column, its ACL column and the actions it declares
 * come from the compiled manifest and are baked into a fixed `case` over the
 * entities that opted in, so a caller can neither name a table the compiler
 * did not authorize, nor an action the entity did not declare, nor a column
 * the policy does not cover. Every identifier is validated against a strict
 * pattern below before it reaches SQL, so a malformed manifest fails the
 * migration instead of shaping a statement. The only answer the function can
 * give is one the caller is entitled to: whether its own session holds an
 * action it already names.
 *
 * THE LOCK ORDERING
 * -----------------
 * One ordering, used by every participant: the ACL row of the subject record
 * is locked FIRST, and whoever holds it keeps it until commit.
 *
 *   policy change   the ordinary entity UPDATE of the ACL field takes the row
 *                   lock PostgreSQL gives every UPDATE;
 *   runtime check   `for share` inside this function, in the CALLER's
 *                   transaction, so it is held for the whole Operation;
 *   effect          runs after the check in that same transaction, under that
 *                   same lock.
 *
 * So a revocation that starts after a check waits for the effect to commit,
 * and a check that starts after a revocation waits for it and then reads the
 * revoked ACL. Neither ordering can interleave a grant with its own removal.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const ENTITY_NAME = /^[A-Z][A-Za-z0-9]*$/;
const ACTION_NAME = /^[a-z][A-Za-z0-9]*$/;
/** The uuid shape a uuid-keyed branch refuses before casting. */
const UUID_LITERAL =
  "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";

type ManifestRecordActionTable = {
  schema: string;
  name: string;
  tenantScoped?: boolean;
  columns?: Array<{ name: string; primaryKey?: boolean; type?: string }>;
  source?: {
    authoringEntityName?: string;
    authorization?: {
      recordPermissions?: {
        column: string;
        actions?: Array<{ name: string; principals: string[] }>;
      };
    };
  };
};

export type RecordActionEntity = {
  entity: string;
  schema: string;
  table: string;
  keyColumn: string;
  keyIsUuid: boolean;
  aclColumn: string;
  actions: string[];
};

function invalid(table: ManifestRecordActionTable, reason: string): never {
  throw new Error(
    `Record-action policy for ${table.schema}.${table.name} cannot be deployed: ${reason}. ` +
      "This is compiled manifest output, so fix the authoring or the compiler rather than this migration.",
  );
}

/**
 * The entities that opted into the named-action axis, as the manifest declares
 * them. Everything this returns is about to be interpolated into DDL, so each
 * value is checked here and a deviation stops the migration.
 */
export function recordActionEntities(
  tables: readonly ManifestRecordActionTable[] = manifest.tables as unknown as ManifestRecordActionTable[],
): RecordActionEntity[] {
  const entities: RecordActionEntity[] = [];
  for (const table of tables) {
    const policy = table.source?.authorization?.recordPermissions;
    if (!policy?.actions?.length) continue;
    const entity = table.source?.authoringEntityName;
    if (!entity || !ENTITY_NAME.test(entity)) invalid(table, "it declares no usable authoring entity name");
    if (!IDENTIFIER.test(table.schema) || !IDENTIFIER.test(table.name)) {
      invalid(table, "its schema or table name is not a plain lowercase identifier");
    }
    if (!IDENTIFIER.test(policy.column)) invalid(table, `ACL column "${policy.column}" is not a plain lowercase identifier`);
    // Tenant isolation is enforced INSIDE the function by comparing
    // app.current_tenant(); an entity with no tenant column has no boundary to
    // compare and must not carry an action.
    if (!table.tenantScoped) invalid(table, "a record action requires a tenant-scoped table");
    const key = (table.columns ?? []).find((column) => column.primaryKey);
    if (!key || !IDENTIFIER.test(key.name)) invalid(table, "it has no single plain-identifier primary key");
    if (!(table.columns ?? []).some((column) => column.name === policy.column)) {
      invalid(table, `ACL column "${policy.column}" is not a column of this table`);
    }
    if (!(table.columns ?? []).some((column) => column.name === "tenant_id")) {
      invalid(table, "it has no tenant_id column to fence on");
    }
    const actions = [...new Set(policy.actions.map((action) => action.name))].sort();
    for (const action of actions) {
      if (!ACTION_NAME.test(action) || ["view", "edit", "delete"].includes(action)) {
        invalid(table, `declared action "${action}" is not a lowerCamel name outside view/edit/delete`);
      }
    }
    entities.push({
      entity: entity!,
      schema: table.schema,
      table: table.name,
      keyColumn: key!.name,
      keyIsUuid: key!.type === "uuid",
      aclColumn: policy.column,
      actions,
    });
  }
  return entities.sort((left, right) => left.entity.localeCompare(right.entity));
}

/** The fixed `case` body. Deterministic for a given manifest. */
export function renderRecordActionLookup(entities: readonly RecordActionEntity[]): string {
  if (entities.length === 0) {
    return "      -- No entity declares a record action in this deployment.\n      return false;";
  }
  const branches = entities.map((entity) => {
    const key = entity.keyIsUuid
      ? `t.${entity.keyColumn} = record_key::uuid`
      : `t.${entity.keyColumn}::text = record_key`;
    const allowed = entity.actions.map((action) => `'${action}'`).join(", ");
    return [
      `        when '${entity.entity}' then`,
      // Both guards return rather than raise. An exception would abort the
      // caller's transaction, which a caller could catch and read as something
      // other than a denial; a key that is not a key, and an action this
      // entity does not declare, are plain refusals.
      `          if action not in (${allowed}) then return false; end if;`,
      ...(entity.keyIsUuid
        ? [`          if record_key !~* ${UUID_LITERAL} then return false; end if;`]
        : []),
      `          select t.${entity.aclColumn} into document`,
      `            from ${entity.schema}.${entity.table} t`,
      `           where ${key} and t.tenant_id = app.current_tenant()`,
      `           for share;`,
    ].join("\n");
  });
  return [
    "      case entity",
    ...branches,
    "        else return false;",
    "      end case;",
  ].join("\n");
}

export async function applyRecordActionsMigration(
  db: OpenShapeForgeDatabase,
  entities: readonly RecordActionEntity[] = recordActionEntities(),
): Promise<RecordActionEntity[]> {
  // Ownership transfer needs CREATE on `app`, exactly as identity-link.ts does.
  await sql`grant usage on schema app to ${sql.id(RESOLVER_ROLE)}`.execute(db);
  await sql`grant create on schema app to ${sql.id(RESOLVER_ROLE)}`.execute(db);

  for (const entity of entities) {
    const target = sql.id(entity.schema, entity.table);
    const readPolicy = `${entity.table}_record_action_read`;
    const lockPolicy = `${entity.table}_record_action_lock`;
    await sql`grant usage on schema ${sql.id(entity.schema)} to ${sql.id(RESOLVER_ROLE)}`.execute(db);
    await sql.raw(
      `grant select ("${entity.keyColumn}", "tenant_id", "${entity.aclColumn}") ` +
        `on ${entity.schema}.${entity.table} to ${RESOLVER_ROLE}`,
    ).execute(db);
    // The lock privilege and nothing more: see the header. The WITH CHECK
    // below is what makes a write impossible even with the column grant.
    await sql.raw(
      `grant update ("${entity.aclColumn}") on ${entity.schema}.${entity.table} to ${RESOLVER_ROLE}`,
    ).execute(db);
    await sql`drop policy if exists ${sql.id(readPolicy)} on ${target}`.execute(db);
    await sql`create policy ${sql.id(readPolicy)} on ${target}
      for select to ${sql.id(RESOLVER_ROLE)} using (true)`.execute(db);
    await sql`drop policy if exists ${sql.id(lockPolicy)} on ${target}`.execute(db);
    await sql`create policy ${sql.id(lockPolicy)} on ${target}
      for update to ${sql.id(RESOLVER_ROLE)} using (true) with check (false)`.execute(db);
  }

  await sql.raw(`
    create or replace function app.record_action_allows(
      entity text,
      record_key text,
      action text
    ) returns boolean
    language plpgsql volatile security definer
    set search_path = pg_catalog, pg_temp
    as $record_action$
    declare
      document jsonb;
    begin
      if entity is null or record_key is null or record_key = '' then
        return false;
      end if;
      -- Mirrors the TS parser and app.record_permissions_valid: an action is a
      -- lowerCamel name and may never restate a record permission.
      if action is null or action !~ '^[a-z][A-Za-z0-9]*$'
        or action in ('view', 'edit', 'delete') then
        return false;
      end if;
      -- No tenant, no answer. Every branch below also fences on this.
      if app.current_tenant() is null then
        return false;
      end if;
${renderRecordActionLookup(entities)}
      -- An absent row, a wrong tenant, a malformed document and an unnamed
      -- action are one answer: no.
      if document is null or not app.record_permissions_valid(document) then
        return false;
      end if;
      return app.record_action_subject_allows(document -> 'actions' -> action);
    end
    $record_action$;
  `).execute(db);
  await sql`revoke all on function app.record_action_allows(text, text, text) from public`.execute(db);
  await sql`revoke all on function app.record_action_allows(text, text, text)
    from ${sql.id(WORKER_ROLE)}`.execute(db);
  await sql`grant execute on function app.record_action_allows(text, text, text)
    to ${sql.id(APP_ROLE)}`.execute(db);
  await sql`alter function app.record_action_allows(text, text, text)
    owner to ${sql.id(RESOLVER_ROLE)}`.execute(db);
  return [...entities];
}
