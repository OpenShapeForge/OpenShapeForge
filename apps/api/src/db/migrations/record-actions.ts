// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../connection.js";
import { databaseRole } from "../database-roles.js";
import { APP_ROLE } from "./app-role.js";
import { WORKER_ROLE } from "./worker-role.js";

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
 *   - `update (<acl column>)`, because UPDATE privilege is what PostgreSQL
 *     requires for `FOR SHARE` (an empty modified-column set is admitted by
 *     any column-level UPDATE grant). The resolver may LOCK an ACL row;
 *   - three policies, below, that bound what those privileges can reach.
 *
 * WHY THE PERMISSIVE PAIR IS NOT ENOUGH
 * -------------------------------------
 * PostgreSQL combines PERMISSIVE policies with OR, and every tenant-scoped
 * table already carries the generated `<table>_row_scope` (or
 * `<table>_tenant_isolation`) policy, which names no role and therefore
 * applies to the resolver as well. Its write check is `app.bypass_rls() OR
 * tenant_id = app.current_tenant()`, which is TRUE for the very row the
 * resolver is looking at. A role-targeted `for update ... with check (false)`
 * is OR-ed with that and changes nothing: verified on PostgreSQL 17.11, the
 * resolver rewrote an ACL document through the column grant. The same OR made
 * `for select ... using (true)` a cross-tenant read of every row of the table.
 *
 * So the bound is a RESTRICTIVE policy, which combines with AND and can
 * therefore not be widened by any policy that exists now or is added later:
 *
 *   `<table>_record_action_read`   permissive, `for select to <resolver>`,
 *                                  `using (tenant_id = app.current_tenant())`
 *                                  — admits the one tenant's rows that the
 *                                  view-gated row policy would hide;
 *   `<table>_record_action_lock`   permissive, `for update to <resolver>`,
 *                                  same tenant predicate, `with check
 *                                  (false)` — admits `FOR SHARE` on those
 *                                  rows and no new row version;
 *   `<table>_record_action_fence`  RESTRICTIVE, `for all to <resolver>`,
 *                                  `using (current_user <> '<resolver>' or
 *                                  tenant_id = app.current_tenant())`,
 *                                  `with check (current_user <> '<resolver>')`
 *                                  — every statement running AS the resolver
 *                                  sees one tenant and writes nothing, on
 *                                  select, insert, update and delete alike.
 *
 * The `current_user <> '<resolver>'` disjunct is not decoration. RLS matches a
 * policy's `TO` list with `has_privs_of_role`, so a `to <resolver>` policy
 * also applies to the MIGRATE role, which the role contract makes a member of
 * every definer role (database-roles.ts). Without the exemption the fence
 * would silently stop the migrate role from seeding or migrating data in any
 * entity that declares an action. Scoping the policy `to <resolver>` keeps it
 * off the app and worker roles' hot path entirely — neither is a member — and
 * the disjunct then exempts the one member that is not the definer itself.
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
 * the policy does not cover.
 *
 * Every string that reaches SQL is both REJECTED and QUOTED, at the point of
 * interpolation rather than only in the registry builder — these renderers are
 * exported and a plugin-contributed table never passed through the authoring
 * loader. Schema, table and column names must match a plain lowercase
 * identifier and are emitted double-quoted; the entity, action and read-field
 * names must match their authored pattern and are emitted as literals with
 * quotes doubled. A manifest that deviates fails the migration instead of
 * shaping a statement. The only answer the function can give is one the caller
 * is entitled to: whether its own session holds an action it already names.
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
/** The authoring field-key contract (authoring/loader.ts FIELD_KEY_PATTERN). */
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;
const RECORD_PERMISSIONS = ["view", "edit", "delete"];
/** The uuid shape a uuid-keyed branch refuses before casting. */
const UUID_LITERAL =
  "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";
/**
 * The longest name this module derives from a table name. PostgreSQL
 * truncates an identifier at 63 bytes, and three policies whose names
 * collapsed into one would leave the table with whichever was created last.
 */
const LONGEST_POLICY_SUFFIX = "_record_action_fence";

function unrenderable(value: string, reason: string): never {
  throw new Error(
    `Record-action DDL cannot be rendered: ${reason} (${JSON.stringify(value)}). ` +
      "This is compiled manifest output, so fix the authoring or the compiler rather than this migration.",
  );
}

/** A validated, double-quoted SQL identifier. Nothing reaches SQL bare. */
function ident(...parts: string[]): string {
  return parts
    .map((part) => {
      if (!IDENTIFIER.test(part)) unrenderable(part, "it is not a plain lowercase identifier");
      return `"${part}"`;
    })
    .join(".");
}

/** A single-quoted SQL string literal, with embedded quotes doubled. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function entityLiteral(name: string): string {
  if (!ENTITY_NAME.test(name)) unrenderable(name, "it is not a PascalCase entity name");
  return literal(name);
}

function actionLiteral(name: string): string {
  if (!ACTION_NAME.test(name) || RECORD_PERMISSIONS.includes(name)) {
    unrenderable(name, "it is not a lowerCamel action name outside view/edit/delete");
  }
  return literal(name);
}

function fieldLiteral(name: string): string {
  if (!FIELD_NAME.test(name)) unrenderable(name, "it is not a lowerCamel field name");
  return literal(name);
}

/**
 * The `<Entity>:<action>` label the projection switches on. Both halves are
 * validated, and neither pattern admits a colon, so the label of one pair can
 * never be the label of another.
 */
function projectionLabel(entity: string, action: string): string {
  entityLiteral(entity);
  actionLiteral(action);
  return literal(`${entity}:${action}`);
}

/** The definer role, validated once: it is interpolated into DDL and a policy. */
const RESOLVER_ROLE = (() => {
  const name = databaseRole("recordActionResolver").name;
  if (!IDENTIFIER.test(name)) unrenderable(name, "the definer role is not a plain identifier");
  return name;
})();

/**
 * The authored field name a column carries, the same derivation the entity
 * runtime uses (operations/entity/columns.ts): the explicit `sourceField`, or
 * the column name in lowerCamel.
 */
function fieldNameForColumn(column: { name: string; sourceField?: string }): string {
  return column.sourceField ??
    column.name.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

export type ManifestRecordActionTable = {
  schema: string;
  name: string;
  tenantScoped?: boolean;
  columns?: Array<{ name: string; primaryKey?: boolean; type?: string; sourceField?: string }>;
  source?: {
    authoringEntityName?: string;
    authorization?: {
      recordPermissions?: {
        column: string;
        actions?: Array<{ name: string; principals: string[]; reads?: string[] }>;
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
  /**
   * Per action, the columns its read projection carries, as
   * `{ field, column }`. Empty for an action that authorizes an effect and
   * discloses nothing.
   */
  reads: Record<string, Array<{ field: string; column: string }>>;
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
    // The three policies are named after the table. PostgreSQL would truncate
    // them at 63 bytes and collapse all three into one.
    if (table.name.length + LONGEST_POLICY_SUFFIX.length > 63) {
      invalid(table, `its name leaves no room for a "${LONGEST_POLICY_SUFFIX}" policy name within 63 bytes`);
    }
    if (!IDENTIFIER.test(policy.column)) invalid(table, `ACL column "${policy.column}" is not a plain lowercase identifier`);
    // Tenant isolation is enforced INSIDE the function by comparing
    // app.current_tenant(); an entity with no tenant column has no boundary to
    // compare and must not carry an action.
    if (!table.tenantScoped) invalid(table, "a record action requires a tenant-scoped table");
    // ONE key column, because both the lookup and the projection address the
    // record by it: one column of a compound key matches more than one row,
    // and `select ... into` would then answer from an arbitrary one.
    const keys = (table.columns ?? []).filter((column) => column.primaryKey);
    const key = keys[0];
    if (keys.length !== 1 || !key || !IDENTIFIER.test(key.name)) {
      invalid(table, "it has no single plain-identifier primary key");
    }
    if (!(table.columns ?? []).some((column) => column.name === policy.column)) {
      invalid(table, `ACL column "${policy.column}" is not a column of this table`);
    }
    if (!(table.columns ?? []).some((column) => column.name === "tenant_id")) {
      invalid(table, "it has no tenant_id column to fence on");
    }
    const actions = [...new Set(policy.actions.map((action) => action.name))].sort();
    for (const action of actions) {
      if (!ACTION_NAME.test(action) || RECORD_PERMISSIONS.includes(action)) {
        invalid(table, `declared action "${action}" is not a lowerCamel name outside view/edit/delete`);
      }
    }
    const reads: RecordActionEntity["reads"] = {};
    for (const action of policy.actions) {
      const projection: Array<{ field: string; column: string }> = [];
      for (const field of [...new Set(action.reads ?? [])].sort()) {
        // The field NAME is a key of the returned jsonb document, so it is
        // interpolated as a literal. `sourceField` comes from the manifest and
        // a plugin-contributed column never passed the authoring loader.
        if (!FIELD_NAME.test(field)) {
          invalid(table, `action "${action.name}" reads "${field}", which is not a lowerCamel field name`);
        }
        const column = (table.columns ?? []).find(
          (candidate) => fieldNameForColumn(candidate) === field,
        );
        // The compiler already refused an unpersisted, classified, computed,
        // localized or relationship field, and the ACL field itself. Reaching
        // here with no column means manifest and authoring disagree.
        if (!column || !IDENTIFIER.test(column.name)) {
          invalid(table, `action "${action.name}" reads "${field}", which is not a plain column of this table`);
        }
        if (column!.name === policy.column || column!.name === "tenant_id") {
          invalid(table, `action "${action.name}" may not read "${field}"`);
        }
        projection.push({ field, column: column!.name });
      }
      if (projection.length > 0) reads[action.name] = projection;
    }
    // The entity name is the `case` label the caller selects a branch with.
    // Two tables answering to one name would make the second branch dead and
    // the first branch the wrong table.
    if (entities.some((existing) => existing.entity === entity)) {
      invalid(table, `entity name "${entity}" is already declared by another table`);
    }
    entities.push({
      entity: entity!,
      schema: table.schema,
      table: table.name,
      keyColumn: key!.name,
      keyIsUuid: key!.type === "uuid",
      aclColumn: policy.column,
      actions,
      reads,
    });
  }
  return entities.sort((left, right) => left.entity.localeCompare(right.entity));
}

/**
 * The one row both bodies address: the record this key names, inside the
 * session's tenant. The key column is the table's single primary key, so this
 * matches at most one row — which is what lets `select ... into` answer
 * without an ordering, and what makes the `FOR SHARE` of the lookup and of
 * the projection the same lock.
 */
function recordPredicate(entity: RecordActionEntity): string {
  const key = entity.keyIsUuid
    ? `t.${ident(entity.keyColumn)} = record_key::uuid`
    : `t.${ident(entity.keyColumn)}::text = record_key`;
  return `${key} and t.${ident("tenant_id")} = app.current_tenant()`;
}

/** The fixed `case` body. Deterministic for a given manifest. */
export function renderRecordActionLookup(entities: readonly RecordActionEntity[]): string {
  if (entities.length === 0) {
    return "      -- No entity declares a record action in this deployment.\n      return false;";
  }
  const branches = entities.map((entity) => {
    const allowed = entity.actions.map(actionLiteral).join(", ");
    return [
      `        when ${entityLiteral(entity.entity)} then`,
      // Both guards return rather than raise. An exception would abort the
      // caller's transaction, which a caller could catch and read as something
      // other than a denial; a key that is not a key, and an action this
      // entity does not declare, are plain refusals.
      `          if action not in (${allowed}) then return false; end if;`,
      ...(entity.keyIsUuid
        ? [`          if record_key !~* ${UUID_LITERAL} then return false; end if;`]
        : []),
      `          select t.${ident(entity.aclColumn)} into document`,
      `            from ${ident(entity.schema, entity.table)} t`,
      `           where ${recordPredicate(entity)}`,
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

/**
 * The read projection, one branch per (entity, action) that declared fields.
 *
 * An action with no declared `reads` has no branch and falls through to null:
 * it authorizes an effect and discloses nothing. Every column name here was
 * resolved from the manifest and checked against the identifier pattern, and
 * the ACL and tenant columns are refused outright, so the projection cannot
 * name the row's own policy or widen past the record.
 *
 * It repeats the `FOR SHARE` of the lookup rather than inheriting it. The
 * lookup already locked this row in this same transaction — `record_action_read`
 * calls `record_action_allows` first and a SECURITY DEFINER call takes no
 * subtransaction, so the lock is the caller's and is held to commit — and
 * re-locking the row it already holds costs nothing. Stating it here is what
 * makes the projection's guarantee local: whatever reorders the two bodies
 * later, the ACL this payload was authorized against cannot change under it.
 */
export function renderRecordActionProjection(
  entities: readonly RecordActionEntity[],
): string {
  const branches = entities.flatMap((entity) =>
    Object.entries(entity.reads).map(([action, projection]) => {
      const object = projection
        .map((read) => `${fieldLiteral(read.field)}, t.${ident(read.column)}`)
        .join(", ");
      return [
        `        when ${projectionLabel(entity.entity, action)} then`,
        `          select jsonb_build_object(${object}) into payload`,
        `            from ${ident(entity.schema, entity.table)} t`,
        `           where ${recordPredicate(entity)}`,
        `           for share;`,
      ].join("\n");
    }));
  if (branches.length === 0) {
    return "      -- No declared action carries a read projection.\n      return null;";
  }
  return [
    "      case entity || ':' || action",
    ...branches,
    "        else return null;",
    "      end case;",
  ].join("\n");
}

/**
 * Row security must be ENABLED and FORCED on the entity table, and the
 * resolver must not hold the owner's privileges on it.
 *
 * Without row security the three policies below are inert comments and the
 * column grants are an unconditional cross-tenant read plus an ACL write.
 * Without FORCE, a role holding the owner's privileges skips every policy —
 * which is also why the owner is checked rather than assumed.
 */
async function assertRowSecurityBounds(
  db: OpenShapeForgeDatabase,
  entity: RecordActionEntity,
): Promise<void> {
  const state = await sql<{
    enabled: boolean;
    forced: boolean;
    owner: string;
    resolver_owns: boolean;
  }>`
    select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
           owner.rolname as owner,
           pg_has_role(${RESOLVER_ROLE}, c.relowner, 'USAGE') as resolver_owns
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_roles owner on owner.oid = c.relowner
     where n.nspname = ${entity.schema} and c.relname = ${entity.table}
  `.execute(db);
  const row = state.rows[0];
  const reason = !row
    ? "the table does not exist"
    : !row.enabled
      ? "row level security is not enabled on it"
      : !row.forced
        ? "row level security is not FORCED on it"
        : row.resolver_owns
          ? `its owner ${row.owner} is a role the resolver holds the privileges of`
          : undefined;
  if (reason === undefined) return;
  throw new Error(
    `Record-action policy for ${entity.schema}.${entity.table} cannot be deployed: ${reason}. ` +
      "The resolver's column grants are only bounded by its policies, and a policy only " +
      "applies while row security is enabled and forced for the role that reads.",
  );
}

export async function applyRecordActionsMigration(
  db: OpenShapeForgeDatabase,
  entities: readonly RecordActionEntity[] = recordActionEntities(),
): Promise<RecordActionEntity[]> {
  // Ownership transfer needs CREATE on `app`, exactly as identity-link.ts does.
  await sql`grant usage on schema app to ${sql.id(RESOLVER_ROLE)}`.execute(db);
  await sql`grant create on schema app to ${sql.id(RESOLVER_ROLE)}`.execute(db);

  // Inside a policy the resolver is a string, not an identifier.
  const resolverLiteral = literal(RESOLVER_ROLE);
  const tenantFence = `${ident("tenant_id")} = app.current_tenant()`;
  const notTheResolver = `current_user <> ${resolverLiteral}`;

  for (const entity of entities) {
    const target = sql.id(entity.schema, entity.table);
    const policy = (suffix: string) => {
      const name = `${entity.table}_record_action_${suffix}`;
      // Truncation at 63 bytes would collapse the three names into one and
      // leave the table with whichever policy was created last.
      if (name.length > 63) unrenderable(name, "the policy name exceeds 63 bytes");
      return sql.id(name);
    };
    // A policy only bounds a privilege while row security is ON and applies to
    // the role reading. Both are true by construction — the generated schema
    // emits ENABLE and FORCE ROW LEVEL SECURITY for every tenant-scoped table
    // and the registry refuses a table that is not tenant-scoped — and this
    // asserts it anyway, because the step after it hands out a column grant
    // that is a real read and a real write if the assertion is false.
    await assertRowSecurityBounds(db, entity);
    await sql`grant usage on schema ${sql.id(entity.schema)} to ${sql.id(RESOLVER_ROLE)}`.execute(db);
    // Exactly the columns the two questions need: the key and tenant to find
    // the row, the ACL to decide, and the union of the declared read
    // projections to answer with. Anything else on the row stays "permission
    // denied for table" even to the resolver.
    const readColumns = [...new Set(
      Object.values(entity.reads).flat().map((read) => read.column),
    )].sort();
    const selectable = [entity.keyColumn, "tenant_id", entity.aclColumn, ...readColumns]
      .filter((column, index, all) => all.indexOf(column) === index)
      .map((column) => ident(column))
      .join(", ");
    await sql.raw(
      `grant select (${selectable}) on ${ident(entity.schema, entity.table)} to ${ident(RESOLVER_ROLE)}`,
    ).execute(db);
    // The lock privilege and nothing more: UPDATE is what PostgreSQL requires
    // for FOR SHARE. The fence policy below is what makes the write
    // impossible; the column grant alone would not.
    await sql.raw(
      `grant update (${ident(entity.aclColumn)}) on ${ident(entity.schema, entity.table)} to ${ident(RESOLVER_ROLE)}`,
    ).execute(db);
    // Permissive: admits the resolver to the rows the view-gated row policy
    // hides from the app role, within this session's tenant and no further.
    await sql`drop policy if exists ${policy("read")} on ${target}`.execute(db);
    await sql`create policy ${policy("read")} on ${target}
      for select to ${sql.id(RESOLVER_ROLE)} using (${sql.raw(tenantFence)})`.execute(db);
    await sql`drop policy if exists ${policy("lock")} on ${target}`.execute(db);
    await sql`create policy ${policy("lock")} on ${target}
      for update to ${sql.id(RESOLVER_ROLE)}
      using (${sql.raw(tenantFence)}) with check (false)`.execute(db);
    // RESTRICTIVE, and therefore the actual bound: permissive policies are
    // OR-ed, so the generated row policy — which names no role and whose write
    // check is satisfied by the resolver's own tenant — would otherwise hand
    // back both the cross-tenant read and the ACL write the two policies above
    // appear to refuse. `current_user` rather than the TO list exempts the
    // migrate role, which the role contract makes a member of this role.
    await sql`drop policy if exists ${policy("fence")} on ${target}`.execute(db);
    await sql`create policy ${policy("fence")} on ${target}
      as restrictive for all to ${sql.id(RESOLVER_ROLE)}
      using (${sql.raw(notTheResolver)} or ${sql.raw(tenantFence)})
      with check (${sql.raw(notTheResolver)})`.execute(db);
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
  await sql.raw(`
    create or replace function app.record_action_read(
      entity text,
      record_key text,
      action text
    ) returns jsonb
    language plpgsql volatile security definer
    set search_path = pg_catalog, pg_temp
    as $record_action_read$
    declare
      payload jsonb;
    begin
      -- The authorization is not re-implemented here: the same lookup decides,
      -- and the FOR SHARE lock it takes covers this read too, so the
      -- projection cannot come from a row whose grant has since changed.
      if not app.record_action_allows(entity, record_key, action) then
        return null;
      end if;
${renderRecordActionProjection(entities)}
      return payload;
    end
    $record_action_read$;
  `).execute(db);
  await sql`revoke all on function app.record_action_read(text, text, text) from public`.execute(db);
  await sql`revoke all on function app.record_action_read(text, text, text)
    from ${sql.id(WORKER_ROLE)}`.execute(db);
  await sql`grant execute on function app.record_action_read(text, text, text)
    to ${sql.id(APP_ROLE)}`.execute(db);
  await sql`alter function app.record_action_read(text, text, text)
    owner to ${sql.id(RESOLVER_ROLE)}`.execute(db);
  await sql`revoke all on function app.record_action_allows(text, text, text) from public`.execute(db);
  await sql`revoke all on function app.record_action_allows(text, text, text)
    from ${sql.id(WORKER_ROLE)}`.execute(db);
  await sql`grant execute on function app.record_action_allows(text, text, text)
    to ${sql.id(APP_ROLE)}`.execute(db);
  await sql`alter function app.record_action_allows(text, text, text)
    owner to ${sql.id(RESOLVER_ROLE)}`.execute(db);
  return [...entities];
}
