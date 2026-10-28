// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../connection.js";
import {
  databaseRole,
  explainDefinerMember,
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
 *     requires for a row lock in either declared mode (an empty
 *     modified-column set is admitted by any column-level UPDATE grant). The
 *     resolver may LOCK an ACL row;
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
 *                                  (false)` — admits the row lock on those
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
 * AND PUBLIC IS A GRANTEE
 * -----------------------
 * The resolver's reach is the union of its own grants and PUBLIC's, and a
 * `revoke` addressed to the resolver does not touch the second half. Verified
 * on PostgreSQL 17.11: with `grant delete, truncate on <table> to public`, the
 * revoke-and-regrant above leaves `has_table_privilege('<resolver>', ...,
 * 'TRUNCATE')` TRUE, the whole migration still succeeds, and a session running
 * AS the resolver truncates the table. That needs an explicit PUBLIC grant on
 * an entity table AND the ability to execute as the resolver, so it is not an
 * externally reachable exploit; it is a privilege the step claimed was exact
 * and was not.
 *
 * So PUBLIC's privileges are read too — from the same two ACL columns, with
 * `acldefault` standing in where the column is NULL, because NULL means the
 * built-in default rather than "nothing" — and any of them fails the step
 * BEFORE the first grant and before either function body exists. They are not
 * revoked: `revoke ... from public` takes the privilege from every role in the
 * cluster, so a migration doing that silently would be undoing a grant the
 * deployment made for someone else. The error carries the statement an
 * administrator runs if the grant was a mistake.
 *
 * WHAT A PREVIOUS MANIFEST LEFT
 * -----------------------------
 * The per-entity loop visits what the manifest declares TODAY. For an entity
 * that is still declared and whose projection changed, that is enough: the
 * `revoke all` reaches column grants as well (verified on PostgreSQL 17.11 —
 * after `grant select (<old column>)` and then `revoke all on <table>`,
 * `has_column_privilege` is false), so no extra work is needed there.
 *
 * What the loop cannot reach is a table the new manifest no longer mentions —
 * a dropped entity, or an entity whose last action was dropped. Nothing
 * iterates it, so its column SELECT, its ACL UPDATE and its four policies
 * outlive the manifest that justified them. The new function bodies have no
 * branch for it, so nothing reaches it through the lookup; but the exact
 * privilege set this step promises is then only exact for the tables it
 * happened to visit. `revokeStaleRecordActionGrants` takes those grants back
 * and drops those policies, addressing the resolver and nothing else.
 *
 * AND A POLICY IS NOT THE RESOLVER'S BECAUSE IT NAMES THE RESOLVER
 * ----------------------------------------------------------------
 * Both paths change policies by NAME — the per-entity loop drops and recreates
 * the four, the cleanup drops them — and `pg_policy.polroles` is a list. Every
 * policy this module creates is `to <resolver>` alone, but a deployment that
 * conditionally added a second role to one of them (`alter policy ... to
 * <resolver>, <other>`), or that created a policy of its own under one of
 * these names, holds another role's row-level access in that object. A `drop
 * policy` takes that access away; a `create policy` under the same name
 * afterwards is worse still, because the replacement names only the resolver
 * and the catalog goes on showing a policy by that name.
 *
 * So neither path trusts the name: a policy is this module's only if its `TO`
 * list is the resolver and nothing else (`ownedByResolverAlone`), and anything
 * else under one of these names fails the step with the `alter policy` an
 * administrator runs to take the resolver out of the list. Fail closed, like
 * the PUBLIC gate above and for the same reason: which roles still need the
 * policy is a decision about the deployment's access, not a detail a migration
 * may settle on its own. A policy that names no role at all is `{0}` in
 * `polroles` and so applies to every role in the cluster, which is the same
 * refusal. The resolver keeps a stale privilege until that is resolved, and
 * the lookup still has no branch that can use it.
 *
 * AND EVERY ONE OF THESE BOUNDS IS PER DATABASE
 * ---------------------------------------------
 * The resolver is ONE cluster-wide role; `pg_class`, `pg_attribute` and
 * `pg_policy` are per database. So "the resolver holds exactly what this
 * manifest declares" is a statement about the database being migrated, and
 * about no other: a grant it holds in a sibling database is neither visible
 * here nor revocable from here, and the stale-grant cleanup below reaches only
 * this database's tables.
 *
 * That is not a gap this step could close, and the role contract does not close
 * it either: two OpenShapeForge databases in one cluster are admitted whenever
 * every member of the definer roles is accounted for in both, which one
 * migrate identity migrating both satisfies however their owners differ. So a
 * sibling database is a real possibility rather than an excluded one, and what
 * bounds the resolver there is that the sibling's own migrate run makes this
 * same exact-privilege statement about the sibling. In a database no
 * OpenShapeForge migration manages, nothing here bounds the resolver at all.
 * See database-roles.ts and docs/migrations.md for the membership condition;
 * nothing here claims the resolver's privileges are bounded cluster-wide.
 *
 * ONE TRANSACTION
 * ---------------
 * The whole step is one transaction: the grants, the four policies per entity,
 * the stale-grant cleanup and the two function bodies. The migration lock
 * (bootstrap.ts) is a SESSION advisory lock, not a transaction, so without
 * this a concurrent session saw the window between `drop policy` and `create
 * policy`, the window between the column grants and the fence that bounds
 * them, and — across entities — the window in which the OLD function bodies
 * were still installed against the NEW grants, where a branch reads a column
 * the new grant set no longer covers. CREATE POLICY takes ACCESS EXCLUSIVE on
 * the table, so no other session can observe a participating table between the
 * two states: it waits for the commit and then sees the replacement whole.
 *
 * The cost is that those ACCESS EXCLUSIVE locks are held until the step
 * commits rather than per entity, so a long-running reader of one entity table
 * delays the DDL on all of them, and a session holding row locks across two of
 * them can deadlock with this step. Both outcomes are an error on one side and
 * a rollback on this one, which leaves the deployment on the grants and
 * policies it already had.
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
 *   runtime check   a row lock inside this function, in the CALLER's
 *                   transaction, so it is held for the whole Operation;
 *   effect          runs after the check in that same transaction, under that
 *                   same lock.
 *
 * So a revocation that starts after a check waits for the effect to commit,
 * and a check that starts after a revocation waits for it and then reads the
 * revoked ACL. Neither ordering can interleave a grant with its own removal.
 *
 * The STRENGTH of that lock is the action's own declaration, because only the
 * action's author knows whether its effect writes the record: see
 * RECORD_ACTION_LOCKS below. The default is the mode under which two parallel
 * holders cannot deadlock.
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
/** The four policy suffixes this module creates per entity table. */
const POLICY_SUFFIXES = ["read", "lock", "fence", "delete_fence"] as const;
/**
 * A policy name this module creates. The stale-grant cleanup drops policies by
 * the name the catalog holds rather than by one derived from the current table
 * name, so it needs to recognise its own.
 *
 * The NAME alone does not make a policy this module's to drop or replace: see
 * {@link ownedByResolverAlone}.
 */
const OWNED_POLICY = /_record_action_(read|lock|fence|delete_fence)$/;

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
  /**
   * The registry name, which is NOT always the physical table: a table in a
   * plugin module's own schema is registered as `<schema>.<table>`. Used in
   * messages only; the DDL below names {@link ManifestRecordActionTable.table}.
   */
  name: string;
  /** The physical table name. */
  table: string;
  tenantScoped?: boolean;
  columns?: Array<{ name: string; primaryKey?: boolean; type?: string; sourceField?: string }>;
  source?: {
    authoringEntityName?: string;
    authorization?: {
      recordPermissions?: {
        column: string;
        actions?: Array<{
          name: string;
          principals: string[];
          reads?: string[];
          lock?: string;
        }>;
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
  /**
   * Per action, the ACL row lock its check takes. `exclusive` renders `for no
   * key update`, `shared` renders `for share`; see RECORD_ACTION_LOCKS below
   * for why that choice belongs to the action rather than to this migration.
   */
  locks: Record<string, RecordActionLock>;
};

export type RecordActionLock = "exclusive" | "shared";

/**
 * The two lock modes, and what each one does to a concurrent pair.
 *
 * `for share` is self-COMPATIBLE: two holders of the same action on the same
 * record both pass the check, both hold a shared lock on the ACL row, and if
 * the effect then locks that row more strongly each waits for a lock the
 * other will not release until it has upgraded. That is a deadlock, and
 * PostgreSQL resolves it by aborting one transaction. It is not a security
 * failure, but it is a liveness one, and it appears only under parallel load.
 *
 * `for no key update` is self-EXCLUSIVE: the second holder waits at the check
 * until the first commits, so only one is ever positioned to upgrade and the
 * deadlock cannot form. It costs serialization of concurrent holders of the
 * same action on the same record, which is why it is a declared choice: an
 * action whose effect only reads can afford `shared` and say so.
 *
 * Both modes conflict with the ordinary UPDATE of the ACL column (which takes
 * `for no key update` itself), so the revocation fence is identical under
 * either: a revocation that starts after a check waits for the effect to
 * commit, and a check that starts after a revocation waits and then reads the
 * revoked ACL.
 */
export const RECORD_ACTION_LOCKS: Readonly<Record<RecordActionLock, string>> = Object.freeze({
  exclusive: "for no key update",
  shared: "for share",
});

function invalid(table: ManifestRecordActionTable, reason: string): never {
  throw new Error(
    `Record-action policy for ${table.name} cannot be deployed: ${reason}. ` +
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
    if (!IDENTIFIER.test(table.schema) || !IDENTIFIER.test(table.table)) {
      invalid(table, "its schema or table name is not a plain lowercase identifier");
    }
    // The four policies are named after the PHYSICAL table, as policyName()
    // renders them -- not the registry name, which carries a schema prefix
    // for a plugin module's own table. PostgreSQL would truncate them at 63
    // bytes and collapse all four into one.
    if (table.table.length + LONGEST_POLICY_SUFFIX.length > 63) {
      invalid(table, `its table name leaves no room for a "${LONGEST_POLICY_SUFFIX}" policy name within 63 bytes`);
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
    const locks: RecordActionEntity["locks"] = {};
    for (const action of policy.actions) {
      // The compiler emits the mode on every action, so an absent one means
      // the manifest predates the field rather than that the author chose.
      // Take the safe mode either way; never guess "shared".
      const lock = action.lock ?? "exclusive";
      if (lock !== "exclusive" && lock !== "shared") {
        invalid(table, `action "${action.name}" declares lock "${lock}", which is neither exclusive nor shared`);
      }
      locks[action.name] = lock;
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
      table: table.table,
      keyColumn: key!.name,
      keyIsUuid: key!.type === "uuid",
      aclColumn: policy.column,
      actions,
      reads,
      locks,
    });
  }
  return entities.sort((left, right) => left.entity.localeCompare(right.entity));
}

/**
 * The one row every body addresses: the record this key names, inside the
 * session's tenant. The key column is the table's single primary key, so this
 * matches at most one row — which is what lets `select ... into` answer
 * without an ordering, and what makes the lock the lookup takes and the lock
 * the projection takes the same lock.
 */
function recordPredicate(entity: RecordActionEntity): string {
  const key = entity.keyIsUuid
    ? `t.${ident(entity.keyColumn)} = record_key::uuid`
    : `t.${ident(entity.keyColumn)}::text = record_key`;
  return `${key} and t.${ident("tenant_id")} = app.current_tenant()`;
}

/**
 * The ACL row lock an action's check takes, rendered as its SQL clause.
 *
 * An action the manifest carries no mode for predates the field; take the
 * self-exclusive mode rather than guess the permissive one.
 */
function lockClause(entity: RecordActionEntity, action: string): string {
  return RECORD_ACTION_LOCKS[entity.locks[action] ?? "exclusive"];
}

/**
 * The fixed `case` body. Deterministic for a given manifest.
 *
 * One branch per (entity, action), not per entity, because the lock mode is a
 * property of the ACTION: a definition's read-only `follow` and its
 * record-writing `start` live on the same row and must not be forced to share
 * a lock strength. The pair is the `case` label, so an entity or action the
 * compiler did not authorize reaches the `else` and is a plain refusal — no
 * raise, because an exception would abort the caller's transaction and a
 * caller could read that as something other than a denial. A key that is not
 * a key refuses the same way.
 */
export function renderRecordActionLookup(entities: readonly RecordActionEntity[]): string {
  const branches = entities.flatMap((entity) =>
    entity.actions.map((action) => [
      `        when ${projectionLabel(entity.entity, action)} then`,
      ...(entity.keyIsUuid
        ? [`          if record_key !~* ${UUID_LITERAL} then return false; end if;`]
        : []),
      `          select t.${ident(entity.aclColumn)} into document`,
      `            from ${ident(entity.schema, entity.table)} t`,
      `           where ${recordPredicate(entity)}`,
      `           ${lockClause(entity, action)};`,
    ].join("\n")));
  if (branches.length === 0) {
    return "      -- No entity declares a record action in this deployment.\n      return false;";
  }
  return [
    "      case entity || ':' || action",
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
 * It repeats the action's declared lock rather than inheriting it. The lookup
 * already locked this row in this same transaction — `record_action_read`
 * calls `record_action_allows` first and a SECURITY DEFINER call takes no
 * subtransaction, so the lock is the caller's and is held to commit — and
 * re-locking the row it already holds in the same mode costs nothing. Stating
 * it here is what makes the projection's guarantee local: whatever reorders
 * the two bodies later, the ACL this payload was authorized against cannot
 * change under it. Naming the SAME mode is what keeps that free: a weaker
 * clause here would be a no-op the reader has to reason about, and a stronger
 * one would reintroduce the upgrade the declaration exists to avoid.
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
        `           ${lockClause(entity, action)};`,
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
 * Is the principal behind a record action still a live one?
 *
 * WHAT THE ACL LOCK DOES NOT COVER
 * --------------------------------
 * The lookup above fences the GRANT: the ACL row is locked, so a revocation
 * of the action cannot interleave with the effect. It says nothing about the
 * CREDENTIAL that produced the session. An application principal is
 * `platform.api_key_integrations.id`, chosen because it survives rotation
 * (auth/trusted-context.ts) — which is exactly why it cannot answer whether
 * the key in the caller's hand is still valid. A long-running Operation that
 * authenticated with a key, had that key revoked a second later and then
 * authorized its effect against an unchanged ACL would act on a withdrawn
 * credential, and the ACL lock would hold throughout.
 *
 * So the session also carries WHICH credential resolved it — the
 * `platform.api_keys` row the store read under tenant-fenced RLS,
 * `app.current_app_credential()` — and this is the predicate that re-reads it
 * inside the action's own transaction.
 *
 * WHAT IT VERIFIES
 * ----------------
 * Four facts, all from rows and none from input:
 *
 *   - the integration named by the session's verified principal is `active`
 *     in this tenant. 'pending' never finished provisioning and 'disabled'
 *     is the customer having switched the whole integration off; both are a
 *     denial, so a disabled integration cannot authorize;
 *   - the credential row exists in this tenant and belongs to THAT
 *     integration. A session whose two values disagree — the shape a forged
 *     placeholder would take — is refused rather than reconciled;
 *   - it is not revoked;
 *   - it has not expired, measured against `clock_timestamp()` rather than
 *     `now()`. `now()` is the transaction's start, so a transaction that
 *     opened before an expiry would keep reading the credential as live for
 *     as long as it ran; the wall clock is the honest reading and the
 *     stricter one.
 *
 * WHEN EACH FACT IS READ, AND WHAT THAT DOES NOT PROMISE
 * ------------------------------------------------------
 * All four are read WHEN THIS FUNCTION IS ASKED, and every answer is a
 * point-in-time one. It is asked at the transaction gate of a record action
 * (operations/entity/record-permissions.ts, `assertActionPrincipalLive`) and
 * again by the bounded read, so a long effect that re-reads is re-checked —
 * and refused if the credential has since gone.
 *
 * It is NOT a claim about the moment of commit. An invocation admitted while
 * the credential was live commits even if the credential EXPIRES while its
 * effect runs: expiry is the passage of time, and no lock holds time back.
 * Revocation and disabling are the cases that cannot interleave, because each
 * is an UPDATE that the `for share` locks below serialize against — a revoke
 * either waits for the effect in flight or is read by the effect that starts
 * after it. So the semantics are: admitted at the gate, serialized against
 * withdrawal, and never retroactively invalidated by the clock. A later
 * check establishes validity at that check, not at the eventual commit.
 *
 * Every other principal class answers TRUE. A person, a direct bearer service
 * account, a capability grant and a control session carry no API-key
 * credential to withdraw, and their carriers' own lifetimes are unchanged by
 * this: nothing here alters an existing human or key API beyond the named
 * record-action gate that calls it.
 *
 * THE LOCK ORDER, AND WHY IT IS THIS ONE
 * --------------------------------------
 * Both rows are taken `for share`, integration FIRST and credential SECOND.
 *
 * That is the order `disableIntegration` writes them in
 * (auth/api-key/service.ts): it updates the integration row, then every key
 * row under it, in one transaction. A fence that locked the key first would
 * hold what the disable needs second while waiting for what the disable
 * already holds — a deadlock, and one that only appears under load.
 * `revokeKey` takes the key row alone, so it joins this order without
 * extending it. Nothing in the revocation path touches an entity ACL row, so
 * adding the credential rows ahead of the ACL lock introduces no cycle with
 * the single ACL ordering the lookup already keeps.
 *
 * `for share` is the mode because it is self-COMPATIBLE and still conflicts
 * with the `for no key update` an ordinary UPDATE takes. Two concurrent
 * holders of two different keys — or of the same one — do not serialize
 * against each other, while a revoke or a disable that starts after a fence
 * waits for that transaction to commit, and one that starts before it makes
 * the fence wait and then read the withdrawn row. Neither side ever upgrades
 * these locks, so the self-compatible mode cannot produce the upgrade
 * deadlock `shared` admits on an ACL row.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a second rights store, and not a capability: it answers "is this
 * credential still live", never "may it do this". The grant stays in the
 * record ACL and is still decided by `app.record_action_allows`. A caller
 * must pass both.
 */
const RECORD_ACTION_PRINCIPAL_LIVE = `
    create or replace function app.record_action_principal_live() returns boolean
    language plpgsql volatile parallel unsafe
    set search_path = pg_catalog, pg_temp
    as $record_action_live$
    declare
      principal uuid := app.current_app_principal();
      credential uuid := app.current_app_credential();
      tenant uuid := app.current_tenant();
      integration uuid;
    begin
      -- Only an application acts on a credential a customer can withdraw
      -- mid-flight. Every other class is unchanged, deliberately.
      if app.current_principal_class() <> 'application' then
        return true;
      end if;
      -- An application with no credential, or outside a tenant, is a
      -- half-written session: deny rather than guess which half is true.
      if principal is null or credential is null or tenant is null then
        return false;
      end if;
      -- FIRST the integration, because that is the order a disable writes.
      select i.id into integration
        from platform.api_key_integrations i
       where i.id = principal
         and i.tenant_id = tenant
         and i.status = 'active'
         for share;
      if integration is null then
        return false;
      end if;
      -- THEN the credential, bound to that same integration: a session whose
      -- principal and credential name different rows holds nothing.
      perform 1
        from platform.api_keys k
       where k.id = credential
         and k.tenant_id = tenant
         and k.integration_id = integration
         and k.revoked_at is null
         and (k.expires_at is null or k.expires_at > clock_timestamp())
         for share;
      return found;
    end
    $record_action_live$;
  `;

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
 * bound that. So the contract is that the only roles that can act as the
 * resolver are the migrate identity itself and this database's owner, and the
 * only membership the migrate identity leans on is a direct grant carrying
 * INHERIT and SET. Both halves are reachability questions: a helper role
 * granted to migrate and also granted the resolver is a separate principal
 * with all of the above, and so is a role granted the DATABASE OWNER, which
 * reaches the resolver through it without ever being its member (both
 * verified on PostgreSQL 17.11 and 16.15).
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
 * Who may ACT AS the resolver, and how the migrate identity may hold it. Both
 * are compared by role NAME against `current_user` and the current database's
 * owner: `pg_has_role(current_user, <member>, 'USAGE')` is not an identity
 * test — it is true for every role granted TO the migrate role, and true for
 * every member of every role when the caller is a superuser.
 *
 * Neither question stops at a direct grant. The two admitted roles are
 * ordinary roles, so a third role granted one of THEM becomes the resolver
 * through it, and a direct grant carrying neither INHERIT nor SET is not the
 * membership this step needs even while `pg_has_role` is satisfied by that
 * same third path. {@link readUnintendedDefinerMembers} walks the graph; the
 * grant below is read off the edge itself.
 *
 * The walk returns one row per ROUTE, not per role, so a role that reaches the
 * resolver twice over is named twice with a different `revoke` each time. The
 * message says which role can act as the resolver, why each route is refused
 * once per route, and that every statement has to be run — following one of
 * them leaves the other route live.
 */
async function assertResolverMembers(db: OpenShapeForgeDatabase): Promise<void> {
  const identity = await readMigrateIdentity(db);
  const unintended = await readUnintendedDefinerMembers(db, [RESOLVER_ROLE]);
  if (unintended.length > 0) {
    const reaching = [...new Set(unintended.map((row) => row.member))];
    const revokes = [...new Set(unintended.map((row) => `revoke ${row.via} from ${row.member};`))];
    throw new Error(
      `The record-action resolver role ${RESOLVER_ROLE} cannot be used: ` +
        `${reaching.join(", ")} can act as it. ` +
        unintended.map((row) => `${explainDefinerMember(row, identity)}. `).join("") +
        "Such a role inherits the resolver's column grants, is matched by the policies " +
        "written TO it, and owns the two SECURITY DEFINER functions this step installs — " +
        "so it can replace their bodies. " +
        (revokes.length === 1
          ? "Run as an administrator: "
          : `Each statement below cuts one of the ${revokes.length} routes above; run ALL of ` +
            "them as an administrator: ") +
        revokes.join(" "),
    );
  }
  // The migrate identity's own membership: a direct grant with INHERIT and
  // SET, or SUPERUSER, which needs none. Held through a third role, that role
  // can act as the resolver as well — and the walk above has already refused
  // it, so this only reports what arrives from a role the walk admits.
  if (identity.superuser) return;
  const held = await sql<{ member: boolean; direct: boolean; granted: boolean }>`
    select (pg_has_role(current_user, ${RESOLVER_ROLE}, 'USAGE')
      and pg_has_role(current_user, ${RESOLVER_ROLE}, 'SET')) as member,
      exists (select 1 from pg_auth_members am
        join pg_roles role on role.oid = am.roleid
        join pg_roles member on member.oid = am.member
        where role.rolname = ${RESOLVER_ROLE} and member.rolname = current_user) as direct,
      exists (select 1 from pg_auth_members am
        join pg_roles role on role.oid = am.roleid
        join pg_roles member on member.oid = am.member
        where role.rolname = ${RESOLVER_ROLE} and member.rolname = current_user
          and am.inherit_option and am.set_option) as granted
  `.execute(db);
  const row = held.rows[0];
  if (row?.granted) return;
  const how = row?.direct
    ? `is a member of ${RESOLVER_ROLE} without INHERIT and SET`
    : row?.member
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

/** A privilege the catalog holds: granted to the resolver, or to PUBLIC. */
type HeldPrivilege = TablePrivilege & { public: boolean };

function privilegeKey(privilege: TablePrivilege): string {
  return `${privilege.kind}:${privilege.column ?? "-"}:${privilege.privilege}`;
}

function describePrivilege(privilege: HeldPrivilege): string {
  return privilege.kind === "table"
    ? privilege.privilege
    : `${privilege.privilege}(${privilege.column})`;
}

/**
 * Every privilege on one table that the resolver can USE: its own explicit
 * grants, and PUBLIC's.
 *
 * PUBLIC is a grantee like any other in `relacl`, and every role holds what it
 * holds — `pg_roles` has no row for it, `grant ... to <resolver>` is not how it
 * got there, and `revoke ... from <resolver>` does not take it away. Verified
 * on PostgreSQL 17.11: with `grant delete, truncate on <table> to public`,
 * `has_table_privilege('<resolver>', '<table>', 'TRUNCATE')` is TRUE after the
 * revoke-and-regrant below. So reading only the resolver's own grants would
 * report an exact privilege set the resolver does not actually have.
 *
 * `relacl` and `attacl` are read rather than `information_schema`, because they
 * show EVERY grantor's grant. A NULL ACL is not "no privileges": it means the
 * built-in default still applies, so `acldefault` stands in for it — for a
 * relation that is the owner and no one else, and for a column it is empty.
 * A `default privileges` entry that caught this table is already materialised
 * into these two columns by the time the table exists.
 */
async function readTablePrivileges(
  db: OpenShapeForgeDatabase,
  schema: string,
  table: string,
): Promise<HeldPrivilege[]> {
  const qualified = literal(ident(schema, table));
  const held = await sql<{
    kind: string;
    column: string | null;
    privilege: string;
    is_public: boolean;
  }>`
    with target as (select ${sql.raw(qualified)}::regclass as oid),
         who as (select oid as grantee from pg_roles where rolname = ${RESOLVER_ROLE})
    select 'table' as kind, null::name as column, acl.privilege_type as privilege,
           acl.grantee = 0 as is_public
      from target, pg_class c,
           aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl
     where c.oid = target.oid
       and (acl.grantee = 0 or acl.grantee in (select grantee from who))
    union all
    select 'column' as kind, att.attname as column, acl.privilege_type as privilege,
           acl.grantee = 0 as is_public
      from target, pg_attribute att, aclexplode(att.attacl) acl
     where att.attrelid = target.oid
       and (acl.grantee = 0 or acl.grantee in (select grantee from who))
  `.execute(db);
  return held.rows.map((row) => ({
    kind: row.kind as TablePrivilege["kind"],
    column: row.column,
    privilege: row.privilege,
    public: row.is_public,
  }));
}

/**
 * PUBLIC must hold nothing on an entity table, checked BEFORE anything is
 * granted and before either function body exists.
 *
 * The resolver's reach is the union of its own grants and PUBLIC's, and the
 * second half is outside everything this migration controls: PUBLIC DELETE is
 * admitted by the delete fence's own USING for the session's tenant, and
 * PUBLIC TRUNCATE ignores row security altogether. A PUBLIC SELECT or UPDATE
 * is narrower but still wider than the column grants below declare.
 *
 * It is NOT revoked here. `revoke ... from public` takes the privilege from
 * every role in the cluster, not from the resolver, so this migration would be
 * silently undoing a grant the deployment made for someone else. The step
 * fails instead, with the statement an administrator runs if the grant was a
 * mistake.
 */
async function assertNoPublicPrivileges(
  db: OpenShapeForgeDatabase,
  entity: RecordActionEntity,
): Promise<void> {
  const held = await readTablePrivileges(db, entity.schema, entity.table);
  const fromPublic = held.filter((privilege) => privilege.public);
  if (fromPublic.length === 0) return;
  const described = [...new Set(fromPublic.map(describePrivilege))].sort();
  throw new Error(
    `Record-action policy for ${entity.schema}.${entity.table} cannot be deployed: PUBLIC holds ` +
      `${described.join(", ")} on it, and ${RESOLVER_ROLE} holds everything PUBLIC holds. ` +
      "TRUNCATE ignores row security entirely and DELETE is admitted by the fence for the " +
      "session's own tenant, so the resolver would reach past the column grants this manifest " +
      "declares. This migration does not revoke it, because a PUBLIC grant belongs to every " +
      "role in the cluster and revoking it here would take it from all of them. Run as the " +
      `table owner, if the grant was not intended: revoke all on ${entity.schema}.${entity.table} from public;`,
  );
}

/**
 * Read the resolver's privileges on the table back out of the catalog and
 * compare them against the exact set this manifest asked for.
 *
 * A policy bounds SELECT, INSERT, UPDATE and DELETE. It does NOT bound
 * TRUNCATE, which ignores row security completely, and a table-wide UPDATE
 * grant would reach every column rather than the ACL. So the grants are not
 * trusted to be what the two statements above made them: they are read back
 * out of the catalog and anything beyond the declared set fails the migration
 * inside its transaction.
 *
 * PUBLIC's rows are skipped here: {@link assertNoPublicPrivileges} already
 * refused the table before the grants were made, and they are not part of "the
 * set this grant made".
 */
async function assertResolverPrivileges(
  db: OpenShapeForgeDatabase,
  entity: RecordActionEntity,
  expected: readonly TablePrivilege[],
): Promise<void> {
  const held = await readTablePrivileges(db, entity.schema, entity.table);
  const wanted = new Set(expected.map(privilegeKey));
  const actual = new Set(
    held.filter((privilege) => !privilege.public).map(privilegeKey),
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
 * What {@link POLICY_ROLE_NAMES} renders for `polroles` entry `0`. PostgreSQL
 * has no `pg_roles` row for PUBLIC, so the OID is translated here rather than
 * joined; it is never a role name a deployment can also have, because `public`
 * is a reserved role name.
 */
const PUBLIC_GRANTEE = "PUBLIC";

/**
 * A policy as the catalog holds it: its name and every role its `TO` list
 * names. A policy that names no role carries the single name `PUBLIC`, which
 * is what `polroles = {0}` means — it applies to every role in the cluster.
 */
type CatalogPolicy = { name: string; roles: string[] };

/**
 * The role names of the policy aliased `p` in the surrounding query.
 *
 * `polroles` holds role OIDs, `0` standing for "no role named", which RLS
 * reads as every role. A role referenced by a policy cannot be dropped, so the
 * join finds a name for every other entry; the OID is rendered as a last
 * resort rather than silently dropping a participant from the list.
 */
const POLICY_ROLE_NAMES = `
  coalesce((select array_agg(named.name order by named.name)
              from (select case when pr.oid = 0 then ${literal(PUBLIC_GRANTEE)}
                                else coalesce(r.rolname::text, pr.oid::text) end as name
                      from unnest(p.polroles) pr(oid)
                      left join pg_roles r on r.oid = pr.oid) named), '{}'::text[])`;

/**
 * A policy this module may replace or drop: one whose `TO` list is the
 * resolver and nothing else.
 *
 * Every policy this module creates is `to <resolver>` alone, so that is the
 * only shape it can prove is its own. A policy that names a second role — or
 * that names no role, and so applies to all of them — carries another role's
 * row-level access, and `drop policy` would take that access away without the
 * deployment ever asking for it. `create policy` under the same name afterwards
 * would be worse: the replacement names only the resolver, so the other role
 * silently loses the policy while the catalog still shows one by that name.
 */
function ownedByResolverAlone(policy: CatalogPolicy): boolean {
  return policy.roles.length === 1 && policy.roles[0] === RESOLVER_ROLE;
}

/**
 * Refuse a policy under one of this module's four names that is not the
 * resolver's alone, naming the roles that hold it and the statements that
 * resolve it.
 *
 * Fail closed rather than guess: whether the other role still needs the
 * predicate, and whether the resolver should be in that list at all, is a
 * decision about the deployment's access that a migration cannot make. The
 * step is one transaction, so nothing it had already changed survives this.
 */
function refuseSharedPolicies(
  shared: ReadonlyArray<{ schema: string; table: string; policy: CatalogPolicy }>,
): never {
  const described = shared.map(({ schema, table, policy }) => {
    const to = policy.roles.length === 0
      // RLS applies a policy with an empty TO list to no role at all, which
      // the catalog does not produce; reported rather than assumed away.
      ? "no role at all"
      : policy.roles.includes(PUBLIC_GRANTEE)
        ? "every role in the cluster, because it names none"
        : policy.roles.join(", ");
    return `${policy.name} on ${schema}.${table} applies to ${to}`;
  });
  const first = shared[0]!;
  throw new Error(
    `A policy under one of this migration's record-action names is not ${RESOLVER_ROLE}'s alone: ` +
      `${described.join("; ")}. This migration creates each of its policies \`to ${RESOLVER_ROLE}\` ` +
      "alone, so it will neither drop nor replace one that another role's row-level access depends " +
      "on: dropping it would take that access away, and recreating it under the same name would " +
      "narrow the policy to the resolver while the catalog still showed a policy by that name. " +
      "Decide what each role still needs and run, as the table owner: " +
      `alter policy ${first.policy.name} on ${first.schema}.${first.table} to <the roles that keep it>; ` +
      `or drop policy ${first.policy.name} on ${first.schema}.${first.table};`,
  );
}

/** Every policy on one table, whichever roles it names. */
async function readTablePolicies(
  db: OpenShapeForgeDatabase,
  schema: string,
  table: string,
): Promise<CatalogPolicy[]> {
  const qualified = literal(ident(schema, table));
  const rows = await sql<{ name: string; roles: string[] }>`
    select p.polname as name, ${sql.raw(POLICY_ROLE_NAMES)} as roles
      from pg_policy p
     where p.polrelid = ${sql.raw(qualified)}::regclass
     order by p.polname
  `.execute(db);
  return rows.rows.map((row) => ({ name: row.name, roles: row.roles }));
}

/**
 * One of the four policy names an entity table carries.
 *
 * `recordActionEntities` already refused a table name that leaves no room for
 * the longest suffix; this repeats the bound at the point of interpolation,
 * because truncation at 63 bytes would collapse the four names into one and
 * leave the table with whichever policy was created last.
 */
function policyName(entity: RecordActionEntity, suffix: string): string {
  const name = `${entity.table}_record_action_${suffix}`;
  if (name.length > 63) unrenderable(name, "the policy name exceeds 63 bytes");
  return name;
}

/**
 * The four policies this entity is about to be given, checked BEFORE the first
 * `drop policy` — because the replacement is a drop and a create, and a
 * deployment that added a second role to one of them would otherwise lose that
 * role's access to a migration that reported success.
 */
async function assertPoliciesReplaceable(
  db: OpenShapeForgeDatabase,
  entity: RecordActionEntity,
): Promise<void> {
  const names = new Set(POLICY_SUFFIXES.map((suffix) => policyName(entity, suffix)));
  const existing = await readTablePolicies(db, entity.schema, entity.table);
  const shared = existing
    .filter((policy) => names.has(policy.name) && !ownedByResolverAlone(policy))
    .map((policy) => ({ schema: entity.schema, table: entity.table, policy }));
  if (shared.length > 0) refuseSharedPolicies(shared);
}

/**
 * The tables the resolver still reaches, as the catalog holds them — not as
 * the manifest describes them.
 *
 * A table is here if the resolver holds a table or column privilege on it, or
 * if a policy is scoped `to <resolver>`. `polroles` is `{0}` for a policy that
 * names no role, so the generated row-scope policy — which applies to the
 * resolver like every other role — does not by itself bring a table into this
 * set: only an explicit grant or a policy created `to` the resolver by name
 * does.
 *
 * Once a table IS in the set, EVERY policy on it comes back, with its whole
 * `TO` list — not only the ones that name the resolver. Two reasons, and both
 * are about not deciding by name alone. The resolver's presence in a `TO` list
 * does not make the policy the resolver's to drop. And a policy under one of
 * this module's four names whose `TO` list does NOT contain the resolver —
 * another role's, or `{0}` and therefore every role's — is not something to
 * step over quietly either: filtering it out here would leave the cleanup
 * reporting that it had taken this module's footprint back while a policy
 * under its own name, with a role list it never wrote, stayed on the table.
 * The caller refuses both.
 */
async function readManagedTables(
  db: OpenShapeForgeDatabase,
): Promise<Array<{ schema: string; table: string; policies: CatalogPolicy[] }>> {
  const rows = await sql<{
    schema: string;
    table: string;
    policy: string | null;
    roles: string[];
  }>`
    with who as (select oid as grantee from pg_roles where rolname = ${RESOLVER_ROLE}),
         managed as (
           select c.oid as relid, n.nspname as nspname, c.relname as relname
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where c.relkind in ('r', 'p')
              and (exists (select 1
                             from aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl,
                                  who
                            where acl.grantee = who.grantee)
                or exists (select 1 from pg_attribute att, aclexplode(att.attacl) acl, who
                            where att.attrelid = c.oid and acl.grantee = who.grantee)
                or exists (select 1 from pg_policy p, who
                            where p.polrelid = c.oid and who.grantee = any(p.polroles)))
         )
    select m.nspname as schema, m.relname as table, p.polname as policy,
           ${sql.raw(POLICY_ROLE_NAMES)} as roles
      from managed m
      left join pg_policy p on p.polrelid = m.relid
     order by m.nspname, m.relname, p.polname
  `.execute(db);
  const managed = new Map<string, { schema: string; table: string; policies: CatalogPolicy[] }>();
  for (const row of rows.rows) {
    const key = `${row.schema}.${row.table}`;
    const entry = managed.get(key) ??
      { schema: row.schema, table: row.table, policies: [] };
    if (row.policy !== null) entry.policies.push({ name: row.policy, roles: row.roles });
    managed.set(key, entry);
  }
  return [...managed.values()];
}

/**
 * Take back what a PREVIOUS manifest granted.
 *
 * The loop above replaces the grants of every entity the manifest declares
 * today, which covers an entity whose read projection or ACL column changed —
 * `revoke all on <table>` reaches the column grants too (verified on
 * PostgreSQL 17.11: a `select (<old column>)` grant is gone afterwards, and
 * `has_column_privilege` is false). It does NOT cover an entity, or the last
 * action of an entity, that the new manifest DROPPED: nothing iterates a table
 * the manifest no longer mentions, so its column SELECT, its ACL UPDATE and
 * its four policies survived every later migration. The new function bodies
 * have no branch for it, so nothing could reach it through the lookup — but
 * the resolver kept a privilege the deployment can no longer see a reason for,
 * and the next role granted the resolver would inherit it.
 *
 * So the resolver's own grants are revoked and the four policies this module
 * names are dropped. Only the resolver's: `revoke ... from <resolver>` touches
 * no other grantee, and PUBLIC's privileges on a table nothing manages any
 * more are left exactly as the deployment set them. The result is read back,
 * because a revoke only reaches what this migrator granted.
 *
 * And only policies the resolver holds ALONE. A policy under one of these four
 * names whose `TO` list is anything else carries row-level access this module
 * did not write — a second role's, or, for `polroles = {0}`, every role's — so
 * the step refuses instead of dropping it. `refuseSharedPolicies` names the
 * roles and the `alter policy` that resolves it. That check reads every policy
 * on every stale table and runs before the first revoke, so the refusal does
 * not depend on which table carries it, and a policy under one of these names
 * that does not mention the resolver at all is refused rather than left behind
 * while the step reports the footprint taken back.
 *
 * Schema USAGE stays granted. It is not a table privilege, the resolver needs
 * it for the schemas it still reads, and a USAGE grant on a schema whose
 * tables it holds nothing on opens nothing.
 */
async function revokeStaleRecordActionGrants(
  db: OpenShapeForgeDatabase,
  entities: readonly RecordActionEntity[],
): Promise<string[]> {
  const current = new Set(entities.map((entity) => `${entity.schema}.${entity.table}`));
  const managed = (await readManagedTables(db))
    .filter(({ schema, table }) => !current.has(`${schema}.${table}`));
  // Before anything is revoked or dropped, and across every stale table at
  // once, so an administrator sees the whole job rather than one table of it.
  const shared = managed.flatMap(({ schema, table, policies }) =>
    policies
      .filter((policy) => OWNED_POLICY.test(policy.name) && !ownedByResolverAlone(policy))
      .map((policy) => ({ schema, table, policy })));
  if (shared.length > 0) refuseSharedPolicies(shared);
  const cleaned: string[] = [];
  for (const { schema, table, policies } of managed) {
    // These names come from the catalog, not from the manifest. A name this
    // module could not have rendered is a grant it cannot have made, so it is
    // reported rather than revoked on a guess.
    if (!IDENTIFIER.test(schema) || !IDENTIFIER.test(table)) {
      throw new Error(
        `${RESOLVER_ROLE} holds a privilege on ${JSON.stringify(`${schema}.${table}`)}, which this ` +
          "migration cannot have granted: its name is not a plain lowercase identifier. The resolver " +
          "must hold nothing outside the entities the manifest declares. Revoke it as an administrator.",
      );
    }
    const target = sql.id(schema, table);
    await sql`revoke all on ${target} from ${sql.id(RESOLVER_ROLE)}`.execute(db);
    // By actual name rather than by a name derived from the table's, so a
    // renamed table loses its policies too. Only the ones scoped to the
    // resolver alone — the gate above already refused every other `TO` list
    // under one of these names, so this filter is the same decision twice and
    // never the only thing standing between a drop and another role's access.
    // A policy under any OTHER name is not this module's and is left alone;
    // the generated row-scope policy on a former entity table is exactly that.
    for (const policy of policies) {
      if (!OWNED_POLICY.test(policy.name) || !ownedByResolverAlone(policy)) continue;
      await sql`drop policy if exists ${sql.id(policy.name)} on ${target}`.execute(db);
    }
    const left = await readTablePrivileges(db, schema, table);
    const own = [...new Set(left.filter((privilege) => !privilege.public).map(describePrivilege))].sort();
    if (own.length > 0) {
      throw new Error(
        `${RESOLVER_ROLE} still holds ${own.join(", ")} on ${schema}.${table}, which no entity in this ` +
          "manifest declares. A revoke only reaches what this migrator granted, so a grant made by a " +
          "second grantor survives it. Revoke it as that grantor, or as an administrator.",
      );
    }
    cleaned.push(`${schema}.${table}`);
  }
  return cleaned;
}

/**
 * One transaction, or the caller's if it already opened one.
 *
 * The migration lock (bootstrap.ts) is a session advisory lock, so it does
 * not make a sequence of statements atomic to a concurrent reader. The whole
 * step runs inside this, so nothing it changes can be observed half-applied
 * and a refusal part-way through leaves nothing behind.
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
  return atomically(db, (tx) => applyRecordActions(tx, entities));
}

async function applyRecordActions(
  db: OpenShapeForgeDatabase,
  entities: readonly RecordActionEntity[],
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
    const policy = (suffix: string) => sql.id(policyName(entity, suffix));
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

    // A policy only bounds a privilege while row security is ON and applies
    // to the role reading. Both are true by construction — the generated
    // schema emits ENABLE and FORCE ROW LEVEL SECURITY for every
    // tenant-scoped table and the registry refuses a table that is not
    // tenant-scoped — and this asserts it anyway, because the step after it
    // hands out a column grant that is a real read and a real write if the
    // assertion is false.
    await assertRowSecurityBounds(db, entity);
    // And PUBLIC must hold nothing, because the resolver holds whatever PUBLIC
    // holds and no revoke addressed to the resolver can take it back. Checked
    // before the first grant, so a table PUBLIC can already TRUNCATE is
    // refused rather than fenced.
    await assertNoPublicPrivileges(db, entity);
    // And each of the four policies must be this module's to replace. The
    // replacement is a `drop policy` and a `create policy` under the same
    // name, which would take a second role named in the old one out of it.
    await assertPoliciesReplaceable(db, entity);
    await sql`grant usage on schema ${sql.id(entity.schema)} to ${sql.id(RESOLVER_ROLE)}`.execute(db);
    // REPLACE rather than add: a table-wide grant reaches every column, a
    // TRUNCATE grant is outside row security altogether, and a column
    // SELECT left over from an action that no longer reads the field is a
    // disclosure this manifest does not declare. Revoking first makes the
    // grant set a function of the manifest alone.
    await sql`revoke all on ${target} from ${sql.id(RESOLVER_ROLE)}`.execute(db);
    await sql.raw(
      `grant select (${selectable}) on ${qualified} to ${ident(RESOLVER_ROLE)}`,
    ).execute(db);
    // The lock privilege and nothing more: UPDATE is what PostgreSQL
    // requires for FOR SHARE. The fence policy below is what makes the write
    // impossible; the column grant alone would not.
    await sql.raw(
      `grant update (${ident(entity.aclColumn)}) on ${qualified} to ${ident(RESOLVER_ROLE)}`,
    ).execute(db);
    await assertResolverPrivileges(db, entity, [
      ...selectColumns.map((column) => ({ kind: "column" as const, column, privilege: "SELECT" })),
      { kind: "column", column: entity.aclColumn, privilege: "UPDATE" },
    ]);
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
    // OR-ed, so the generated row policy — which names no role and whose
    // write check is satisfied by the resolver's own tenant — would
    // otherwise hand back both the cross-tenant read and the ACL write the
    // two policies above appear to refuse. The exemption is the table
    // owner's privileges rather than a role name, so a second member of the
    // resolver inherits the column grants and still cannot write.
    await sql`drop policy if exists ${policy("fence")} on ${target}`.execute(db);
    await sql`create policy ${policy("fence")} on ${target}
      as restrictive for all to ${sql.id(RESOLVER_ROLE)}
      using (${sql.raw(ownsTheTable)} or ${sql.raw(tenantFence)})
      with check (${sql.raw(ownsTheTable)})`.execute(db);
    // A `for all` policy's WITH CHECK is applied to INSERT and UPDATE only,
    // so DELETE is bounded by the fence's USING — which has to stay true for
    // the tenant's own rows, or FOR SHARE stops working. This is the one
    // statement that needs its own restrictive USING. The resolver holds no
    // DELETE privilege either, by the revoke above and by the privilege
    // assertion; this is what holds if a later grant appears.
    await sql`drop policy if exists ${policy("delete_fence")} on ${target}`.execute(db);
    await sql`create policy ${policy("delete_fence")} on ${target}
      as restrictive for delete to ${sql.id(RESOLVER_ROLE)}
      using (${sql.raw(ownsTheTable)})`.execute(db);
    // The INVERSE question's index: "which records has this subject been
    // given an action on". The point lookup is keyed and needs nothing, but
    // the management listing
    // (operations/record-action-assignments/read-model.ts) asks the opposite
    // way round, and grants are sparse — a tenant with a hundred thousand
    // records and ten grants would otherwise read the hundred thousand to
    // find the ten, per page. `jsonb_path_ops` because the listing's only
    // index-eligible predicate is containment of one
    // `{actions:{<action>:{integrations:[<id>]}}}` path, which is exactly what
    // that operator class stores and the smallest index that answers it.
    //
    // It is a pre-filter, never the authority: the authoritative membership
    // test stays `app.record_action_integration_actions`, which also rejects a
    // malformed document that containment alone would match. Additive, under a
    // name derived from the table like every other object here, so
    // `db:migrate` rolls it forward.
    await sql.raw(
      `create index if not exists ${ident(`${entity.table}_record_action_subjects`)} ` +
        `on ${qualified} using gin (${ident(entity.aclColumn)} jsonb_path_ops)`,
    ).execute(db);
  }

  // What a PREVIOUS manifest granted and this one does not declare. The loop
  // above only visits the entities that exist today, so a dropped entity — or
  // an entity whose last action was dropped — keeps its grants for ever
  // otherwise.
  await revokeStaleRecordActionGrants(db, entities);

  // The credential fence. Deliberately NOT security definer and therefore
  // not owned by the resolver: it reads and locks two platform tables the
  // restricted app role already holds tenant-fenced DML on, so it needs no
  // privilege of its own and adds no definer reach. `search_path` is pinned
  // and every name is qualified all the same, because an invoker function
  // inherits whatever path the session set.
  await sql.raw(RECORD_ACTION_PRINCIPAL_LIVE).execute(db);
  await sql`revoke all on function app.record_action_principal_live() from public`.execute(db);
  await sql`revoke all on function app.record_action_principal_live()
    from ${sql.id(WORKER_ROLE)}`.execute(db);
  await sql`grant execute on function app.record_action_principal_live()
    to ${sql.id(APP_ROLE)}`.execute(db);

  // The two function bodies, their EXECUTE grants and the ownership transfer.
  // `create function` defaults to EXECUTE for PUBLIC, so a first install would
  // otherwise expose the lookup to every role in the window before the revoke.
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
      -- and the ACL row lock it takes covers this read too, so the
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
  // CREATE is needed only for transferring ownership. Keeping it would let a
  // later resolver member replace its own security-definer functions.
  await sql`revoke create on schema app from ${sql.id(RESOLVER_ROLE)}`.execute(db);
  return [...entities];
}
