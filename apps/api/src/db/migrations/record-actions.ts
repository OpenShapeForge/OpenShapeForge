// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../connection.js";
import {
  databaseRole,
  readMigrateIdentity,
  readUnintendedDefinerMembers,
} from "../database-roles.js";
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
 *   - four policies, below, that bound what those privileges can reach.
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
 *                                  `using (<owns the table> or tenant_id =
 *                                  app.current_tenant())`, `with check
 *                                  (<owns the table>)` — one tenant on read,
 *                                  and no INSERT or UPDATE at all;
 *   `<table>_record_action_delete_fence`
 *                                  RESTRICTIVE, `for delete to <resolver>`,
 *                                  `using (<owns the table>)` — because a
 *                                  `for all` policy's WITH CHECK is applied
 *                                  to INSERT and UPDATE only. DELETE is
 *                                  bounded by its USING, and the fence's
 *                                  USING has to stay TRUE for the tenant's
 *                                  own rows or `FOR SHARE` would stop
 *                                  working. Verified on PostgreSQL 17.11:
 *                                  with the `for all` fence alone and a
 *                                  DELETE privilege present, the resolver
 *                                  deleted the row it may only lock.
 *
 * WHAT THE EXEMPTION IS, AND WHY IT IS NOT A ROLE NAME
 * ----------------------------------------------------
 * RLS matches a policy's `TO` list with `has_privs_of_role`, so a
 * `to <resolver>` policy also applies to every role that INHERITS the
 * resolver — the MIGRATE role above all, which the role contract makes a
 * member of every definer role (database-roles.ts). The migrate role must
 * keep seeding and migrating rows of an entity that declares an action, so
 * the fence needs an exemption; but `current_user <> '<resolver>'` exempts
 * every member indiscriminately, and a second role granted the resolver then
 * inherits `update (<acl column>)` and rewrites the current tenant's ACL
 * document — the one write the fence exists to stop. Verified on PostgreSQL
 * 17.11 before this bound was tightened.
 *
 * The exemption is therefore a PRIVILEGE, not a name:
 *
 *   pg_has_role(current_user, <this table's relowner>, 'USAGE')
 *
 * read from `pg_class` at evaluation time, so it follows an ownership
 * transfer and names no deployment-specific role. It admits exactly the
 * sessions that hold the table owner's privileges — the migrate role that
 * created the table, and any second migrator a deployment runs — and those
 * sessions can already drop the policy or disable row security by DDL, so
 * the fence was never a bound on them. It is FALSE for the resolver and for
 * every member of the resolver that is not also an owner, which is what
 * makes the write bound hold for a role the deployment adds later.
 *
 * `assertRowSecurityBounds` refuses to grant anything on a table whose owner
 * is a role the resolver holds the privileges of, so the resolver can never
 * satisfy this predicate: that assertion is load-bearing for the fence, not
 * only for FORCE ROW LEVEL SECURITY.
 *
 * Scoping all four policies `to <resolver>` keeps them off the app and worker
 * roles' hot path entirely — neither is a member of anything.
 *
 * PRIVILEGE, NOT ONLY POLICY
 * --------------------------
 * A policy is not the only bound worth having, and for one statement it is no
 * bound at all: TRUNCATE ignores row security completely. So the grants are
 * REPLACED rather than added to — `revoke all` on the table, then exactly the
 * column SELECT and the column UPDATE this manifest needs — and the result is
 * read back from `pg_class.relacl` and `pg_attribute.attacl` and compared
 * against that exact set. A table-wide grant, a TRUNCATE or DELETE grant, a
 * default privilege that caught this table, or a column SELECT left behind by
 * an action that no longer reads the field fails the migration instead of
 * resting on the fence.
 *
 * ONE TRANSACTION PER TABLE
 * -------------------------
 * The grants and the four policies are applied in a single transaction per
 * entity. The migration lock (bootstrap.ts) is a SESSION advisory lock, not a
 * transaction, so without this a concurrent session saw the window between
 * `drop policy` and `create policy` — and, on a first install, the window
 * between the column grants and the fence that bounds them. CREATE POLICY
 * takes ACCESS EXCLUSIVE on the table, so inside one transaction no other
 * session can observe the table between the two states: it waits for the
 * commit and then sees the replacement.
 *
 * EXECUTE is revoked from PUBLIC and from the worker role, and granted to the
 * app role alone: no worker-side action check is supported yet. That revoke is
 * why this migration runs LAST among the privilege steps — `applyAppRoleGrants`
 * and `applyWorkerRoleGrants` sweep EXECUTE over every function in `app` and
 * set a default privilege that catches later ones, so anything granted before
 * them is widened again. The function DDL, those revokes and the ownership
 * transfer share one transaction too, so a first install never leaves the
 * lookup EXECUTE-able by PUBLIC between `create function` and the revoke.
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
 * truncates an identifier at 63 bytes, and four policies whose names
 * collapsed into one would leave the table with whichever was created last.
 */
const LONGEST_POLICY_SUFFIX = "_record_action_delete_fence";

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
    // The four policies are named after the table. PostgreSQL would truncate
    // them at 63 bytes and collapse all four into one.
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
 * Without row security the four policies below are inert comments and the
 * column grants are an unconditional cross-tenant read plus an ACL write.
 * Without FORCE, a role holding the owner's privileges skips every policy —
 * which is also why the owner is checked rather than assumed.
 *
 * The owner check is doubly load-bearing now that the fence exempts the
 * sessions which hold the owner's privileges: if the resolver held them it
 * would exempt ITSELF and the write bound would be gone.
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

/**
 * The definer role itself, before anything is granted to it.
 *
 * `rolbypassrls` ignores FORCE ROW LEVEL SECURITY and every policy with it,
 * so a resolver carrying that attribute would hold the column grants with no
 * bound at all; `rolsuper` is the same thing and more. And a resolver that is
 * a member of another role is no longer the narrow identity the SECURITY
 * DEFINER functions are meant to run as — under INHERIT, `grant <anything> to
 * <resolver>` widens both function bodies silently, and without it the role is
 * still one `set role` away from them.
 *
 * The MEMBERS of the resolver are the other half, and the half this step is
 * the last line of defence for. RLS matches a policy's `TO` list and object
 * ownership alike with `has_privs_of_role`, so a member of the resolver holds
 * the column grants this step is about to make AND owns the two SECURITY
 * DEFINER functions it is about to create: with `CREATE` on schema `app` it
 * can `create or replace app.record_action_allows` and decide every record
 * action itself. The fence bounds its writes to entity tables; it does not
 * bound that. So the contract is that the only members are the migrate
 * identity itself and this database's owner, and the only membership the
 * migrate identity leans on is a direct grant — a helper role granted to
 * migrate and also granted the resolver is a separate principal with all of
 * the above (verified on PostgreSQL 17.11).
 *
 * database-roles.ts verifies the same contract for every declared role at the
 * head of the chain. This repeats the resolver's own part of it here, because
 * this step hands out a real read and a real write and is also called directly
 * by tests and by a host that assembles its own chain. Deviations fail the
 * step with the administrator's `revoke`; nothing is revoked here.
 */
async function assertResolverRole(db: OpenShapeForgeDatabase): Promise<void> {
  const state = await sql<{
    superuser: boolean;
    bypassrls: boolean;
    inherits: boolean;
    can_login: boolean;
    memberships: string[];
  }>`
    select r.rolsuper as superuser, r.rolbypassrls as bypassrls,
           r.rolinherit as inherits, r.rolcanlogin as can_login,
           coalesce(array_agg(parent.rolname order by parent.rolname)
             filter (where parent.rolname is not null), '{}') as memberships
      from pg_roles r
      left join pg_auth_members am on am.member = r.oid
      left join pg_roles parent on parent.oid = am.roleid
     where r.rolname = ${RESOLVER_ROLE}
     group by r.rolsuper, r.rolbypassrls, r.rolinherit, r.rolcanlogin
  `.execute(db);
  const row = state.rows[0];
  const reason = !row
    ? "it does not exist"
    : row.superuser
      ? "it is a SUPERUSER, which is outside row security entirely"
      : row.bypassrls
        ? "it has BYPASSRLS, which ignores FORCE ROW LEVEL SECURITY and every policy"
        : row.can_login
          ? "it can log in, so the deployment can reach it directly rather than only through the lookup"
          : row.memberships.length > 0
            ? `it is a member of ${row.memberships.join(", ")}` +
              (row.inherits ? ", whose privileges it INHERITS" : "")
            : undefined;
  if (reason !== undefined) {
    throw new Error(
      `The record-action resolver role ${RESOLVER_ROLE} cannot be used: ${reason}. ` +
        "Its privileges are bounded by row-level policies and by nothing else, so it must be " +
        `NOLOGIN NOSUPERUSER NOBYPASSRLS and a member of no role. Run as an administrator: ` +
        `alter role ${RESOLVER_ROLE} nologin nosuperuser nobypassrls noinherit;`,
    );
  }
  await assertResolverMembers(db);
}

/**
 * Who may be a member OF the resolver, and how the migrate identity may hold
 * it. Both are compared by role NAME against `current_user` and the current
 * database's owner: `pg_has_role(current_user, <member>, 'USAGE')` is not an
 * identity test — it is true for every role granted TO the migrate role, and
 * true for every member of every role when the caller is a superuser.
 */
async function assertResolverMembers(db: OpenShapeForgeDatabase): Promise<void> {
  const identity = await readMigrateIdentity(db);
  const unintended = await readUnintendedDefinerMembers(db, [RESOLVER_ROLE]);
  if (unintended.length > 0) {
    const members = unintended.map((row) => row.member);
    throw new Error(
      `The record-action resolver role ${RESOLVER_ROLE} cannot be used: ` +
        `${members.join(", ")} ${members.length === 1 ? "is a member" : "are members"} of it, ` +
        `and neither the migrate identity ${identity.user} nor this database's owner ` +
        `${identity.databaseOwner ?? "(unknown)"}. A member inherits the resolver's column ` +
        "grants, is matched by the policies written TO it, and owns the two SECURITY DEFINER " +
        "functions this step installs — so it can replace their bodies. Run as an " +
        "administrator: " +
        members.map((member) => `revoke ${RESOLVER_ROLE} from ${member};`).join(" "),
    );
  }
  // The migrate identity's own membership: a direct grant, or SUPERUSER, which
  // needs none. Held through a third role, that role is a member as well — and
  // the scan above has already refused it, so this only reports the case where
  // the privilege arrives from a role the scan admits.
  if (identity.superuser) return;
  const held = await sql<{ member: boolean; direct: boolean }>`
    select (pg_has_role(current_user, ${RESOLVER_ROLE}, 'USAGE')
      and pg_has_role(current_user, ${RESOLVER_ROLE}, 'SET')) as member,
      exists (select 1 from pg_auth_members am
        join pg_roles role on role.oid = am.roleid
        join pg_roles member on member.oid = am.member
        where role.rolname = ${RESOLVER_ROLE} and member.rolname = current_user) as direct
  `.execute(db);
  const row = held.rows[0];
  if (row?.member && row.direct) return;
  const how = row?.member
    ? `holds ${RESOLVER_ROLE} only through another role`
    : `is not a member of ${RESOLVER_ROLE}`;
  throw new Error(
    `The migrate identity ${identity.user} cannot install the record-action lookup: it ${how}` +
      ". The step transfers the two SECURITY DEFINER functions to that role, which needs " +
      "membership in it, and the contract is that the grant names the migrate identity " +
      `itself. Run as an administrator: grant ${RESOLVER_ROLE} to ${identity.user} ` +
      "with inherit true, set true;",
  );
}

/** What the resolver may hold on an entity table, and nothing else. */
type TablePrivilege = { kind: "table" | "column"; column: string | null; privilege: string };

function privilegeKey(privilege: TablePrivilege): string {
  return `${privilege.kind}:${privilege.column ?? "-"}:${privilege.privilege}`;
}

/**
 * Read the resolver's privileges on the table back out of the catalog and
 * compare them against the exact set this manifest asked for.
 *
 * A policy bounds SELECT, INSERT, UPDATE and DELETE. It does NOT bound
 * TRUNCATE, which ignores row security completely, and a table-wide UPDATE
 * grant would reach every column rather than the ACL. So the grants are not
 * trusted to be what the two statements above made them: they are read from
 * `pg_class.relacl` and `pg_attribute.attacl` — which, unlike
 * `information_schema`, show every grantor's grant — and anything beyond the
 * declared set fails the migration inside its transaction.
 */
async function assertResolverPrivileges(
  db: OpenShapeForgeDatabase,
  entity: RecordActionEntity,
  expected: readonly TablePrivilege[],
): Promise<void> {
  const qualified = literal(ident(entity.schema, entity.table));
  const held = await sql<{ kind: string; column: string | null; privilege: string }>`
    with target as (select ${sql.raw(qualified)}::regclass as oid),
         who as (select oid as grantee from pg_roles where rolname = ${RESOLVER_ROLE})
    select 'table' as kind, null::name as column, acl.privilege_type as privilege
      from target, who, pg_class c, aclexplode(c.relacl) acl
     where c.oid = target.oid and acl.grantee = who.grantee
    union all
    select 'column' as kind, att.attname as column, acl.privilege_type as privilege
      from target, who, pg_attribute att, aclexplode(att.attacl) acl
     where att.attrelid = target.oid and acl.grantee = who.grantee
  `.execute(db);
  const wanted = new Set(expected.map(privilegeKey));
  const actual = new Set(
    held.rows.map((row) =>
      privilegeKey({ kind: row.kind as TablePrivilege["kind"], column: row.column, privilege: row.privilege }),
    ),
  );
  const extra = [...actual].filter((key) => !wanted.has(key)).sort();
  const missing = [...wanted].filter((key) => !actual.has(key)).sort();
  if (extra.length === 0 && missing.length === 0) return;
  throw new Error(
    `Record-action privileges for ${entity.schema}.${entity.table} are not what this manifest declares: ` +
      [
        extra.length > 0 ? `${RESOLVER_ROLE} also holds ${extra.join(", ")}` : undefined,
        missing.length > 0 ? `${RESOLVER_ROLE} is missing ${missing.join(", ")}` : undefined,
      ].filter(Boolean).join("; ") +
      ". A policy does not bound TRUNCATE at all and a table-wide UPDATE reaches every column, " +
      "so the grant set is checked rather than assumed. Revoke what this migration did not grant.",
  );
}

/**
 * One transaction, or the caller's if it already opened one.
 *
 * The migration lock (bootstrap.ts) is a session advisory lock, so it does
 * not make a sequence of statements atomic to a concurrent reader. Every unit
 * below that must not be observed half-applied gets a real transaction.
 *
 * As in audit-history.ts, "already opened one" means a Kysely transaction. A
 * caller that issued a raw `begin` on the connection is not detectable here
 * and would have the inner COMMIT close its own transaction; the chain opens
 * none around this step.
 */
async function atomically<T>(
  db: OpenShapeForgeDatabase,
  work: (tx: OpenShapeForgeDatabase) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) return work(db);
  return db.transaction().execute((tx) => work(tx));
}

export async function applyRecordActionsMigration(
  db: OpenShapeForgeDatabase,
  entities: readonly RecordActionEntity[] = recordActionEntities(),
): Promise<RecordActionEntity[]> {
  // The definer role's own attributes, before it is handed a grant: its
  // privileges are bounded by policies, and BYPASSRLS or an inherited role
  // would put it outside them.
  await assertResolverRole(db);
  // Ownership transfer needs CREATE on `app`, exactly as identity-link.ts does.
  await sql`grant usage on schema app to ${sql.id(RESOLVER_ROLE)}`.execute(db);
  await sql`grant create on schema app to ${sql.id(RESOLVER_ROLE)}`.execute(db);

  const tenantFence = `${ident("tenant_id")} = app.current_tenant()`;

  for (const entity of entities) {
    const qualified = ident(entity.schema, entity.table);
    const target = sql.id(entity.schema, entity.table);
    /**
     * The fence's exemption: TRUE only for a session holding the privileges of
     * THIS table's owner, read from the catalog so an ownership transfer
     * carries and no deployment role is named. FALSE for the resolver —
     * `assertRowSecurityBounds` refuses the table otherwise — and FALSE for
     * every member of the resolver that does not also own the table.
     */
    const ownsTheTable =
      `coalesce((select pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')` +
      ` from pg_catalog.pg_class c where c.oid = ${literal(qualified)}::regclass), false)`;
    const policy = (suffix: string) => {
      const name = `${entity.table}_record_action_${suffix}`;
      // Truncation at 63 bytes would collapse the four names into one and
      // leave the table with whichever policy was created last.
      if (name.length > 63) unrenderable(name, "the policy name exceeds 63 bytes");
      return sql.id(name);
    };
    // Exactly the columns the two questions need: the key and tenant to find
    // the row, the ACL to decide, and the union of the declared read
    // projections to answer with. Anything else on the row stays "permission
    // denied for table" even to the resolver.
    const readColumns = [...new Set(
      Object.values(entity.reads).flat().map((read) => read.column),
    )].sort();
    const selectColumns = [entity.keyColumn, "tenant_id", entity.aclColumn, ...readColumns]
      .filter((column, index, all) => all.indexOf(column) === index);
    const selectable = selectColumns.map((column) => ident(column)).join(", ");

    // The grants and the four policies that bound them, atomically: a
    // concurrent session must never see the column grants without the fence,
    // nor the table between `drop policy` and `create policy`. CREATE POLICY
    // takes ACCESS EXCLUSIVE, so a reader waits for the commit and then sees
    // the replacement whole.
    await atomically(db, async (tx) => {
      // A policy only bounds a privilege while row security is ON and applies
      // to the role reading. Both are true by construction — the generated
      // schema emits ENABLE and FORCE ROW LEVEL SECURITY for every
      // tenant-scoped table and the registry refuses a table that is not
      // tenant-scoped — and this asserts it anyway, because the step after it
      // hands out a column grant that is a real read and a real write if the
      // assertion is false.
      await assertRowSecurityBounds(tx, entity);
      await sql`grant usage on schema ${sql.id(entity.schema)} to ${sql.id(RESOLVER_ROLE)}`.execute(tx);
      // REPLACE rather than add: a table-wide grant reaches every column, a
      // TRUNCATE grant is outside row security altogether, and a column
      // SELECT left over from an action that no longer reads the field is a
      // disclosure this manifest does not declare. Revoking first makes the
      // grant set a function of the manifest alone.
      await sql`revoke all on ${target} from ${sql.id(RESOLVER_ROLE)}`.execute(tx);
      await sql.raw(
        `grant select (${selectable}) on ${qualified} to ${ident(RESOLVER_ROLE)}`,
      ).execute(tx);
      // The lock privilege and nothing more: UPDATE is what PostgreSQL
      // requires for FOR SHARE. The fence policy below is what makes the write
      // impossible; the column grant alone would not.
      await sql.raw(
        `grant update (${ident(entity.aclColumn)}) on ${qualified} to ${ident(RESOLVER_ROLE)}`,
      ).execute(tx);
      await assertResolverPrivileges(tx, entity, [
        ...selectColumns.map((column) => ({ kind: "column" as const, column, privilege: "SELECT" })),
        { kind: "column", column: entity.aclColumn, privilege: "UPDATE" },
      ]);
      // Permissive: admits the resolver to the rows the view-gated row policy
      // hides from the app role, within this session's tenant and no further.
      await sql`drop policy if exists ${policy("read")} on ${target}`.execute(tx);
      await sql`create policy ${policy("read")} on ${target}
        for select to ${sql.id(RESOLVER_ROLE)} using (${sql.raw(tenantFence)})`.execute(tx);
      await sql`drop policy if exists ${policy("lock")} on ${target}`.execute(tx);
      await sql`create policy ${policy("lock")} on ${target}
        for update to ${sql.id(RESOLVER_ROLE)}
        using (${sql.raw(tenantFence)}) with check (false)`.execute(tx);
      // RESTRICTIVE, and therefore the actual bound: permissive policies are
      // OR-ed, so the generated row policy — which names no role and whose
      // write check is satisfied by the resolver's own tenant — would
      // otherwise hand back both the cross-tenant read and the ACL write the
      // two policies above appear to refuse. The exemption is the table
      // owner's privileges rather than a role name, so a second member of the
      // resolver inherits the column grants and still cannot write.
      await sql`drop policy if exists ${policy("fence")} on ${target}`.execute(tx);
      await sql`create policy ${policy("fence")} on ${target}
        as restrictive for all to ${sql.id(RESOLVER_ROLE)}
        using (${sql.raw(ownsTheTable)} or ${sql.raw(tenantFence)})
        with check (${sql.raw(ownsTheTable)})`.execute(tx);
      // A `for all` policy's WITH CHECK is applied to INSERT and UPDATE only,
      // so DELETE is bounded by the fence's USING — which has to stay true for
      // the tenant's own rows, or FOR SHARE stops working. This is the one
      // statement that needs its own restrictive USING. The resolver holds no
      // DELETE privilege either, by the revoke above and by the privilege
      // assertion; this is what holds if a later grant appears.
      await sql`drop policy if exists ${policy("delete_fence")} on ${target}`.execute(tx);
      await sql`create policy ${policy("delete_fence")} on ${target}
        as restrictive for delete to ${sql.id(RESOLVER_ROLE)}
        using (${sql.raw(ownsTheTable)})`.execute(tx);
    });
  }

  // The two function bodies, their EXECUTE grants and the ownership transfer
  // as one unit: `create function` defaults to EXECUTE for PUBLIC, so a first
  // install would otherwise expose the lookup to every role in the window
  // before the revoke.
  await atomically(db, async (tx) => {
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
  `).execute(tx);
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
  `).execute(tx);
    await sql`revoke all on function app.record_action_read(text, text, text) from public`.execute(tx);
    await sql`revoke all on function app.record_action_read(text, text, text)
      from ${sql.id(WORKER_ROLE)}`.execute(tx);
    await sql`grant execute on function app.record_action_read(text, text, text)
      to ${sql.id(APP_ROLE)}`.execute(tx);
    await sql`alter function app.record_action_read(text, text, text)
      owner to ${sql.id(RESOLVER_ROLE)}`.execute(tx);
    await sql`revoke all on function app.record_action_allows(text, text, text) from public`.execute(tx);
    await sql`revoke all on function app.record_action_allows(text, text, text)
      from ${sql.id(WORKER_ROLE)}`.execute(tx);
    await sql`grant execute on function app.record_action_allows(text, text, text)
      to ${sql.id(APP_ROLE)}`.execute(tx);
    await sql`alter function app.record_action_allows(text, text, text)
      owner to ${sql.id(RESOLVER_ROLE)}`.execute(tx);
  });
  return [...entities];
}
