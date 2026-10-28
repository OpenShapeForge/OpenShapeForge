// SPDX-License-Identifier: BUSL-1.1
/**
 * The database role contract: declared by the compiler, provisioned by the
 * host, verified by the migration chain.
 *
 * Postgres roles are CLUSTER-wide. A migration is per database and runs as
 * the migrate role, which on a managed instance deliberately has neither
 * SUPERUSER nor CREATEROLE. So the chain never creates roles; it checks that
 * every role the generated schema depends on exists with the load-bearing
 * attributes, and that the migrate role is a member of the definer roles
 * whose objects it must hand over. Anything missing is reported with the
 * exact statements an administrator runs — the same statements
 * {@link provisionDatabaseRoles} executes when given the admin connection.
 *
 * TWO OPENSHAPEFORGE DATABASES IN ONE CLUSTER
 * -------------------------------------------
 * {@link readRoleMembers} is where a cluster-wide object meets a per-database
 * check. The member list is cluster-wide; both yardsticks a member is held
 * against are per database — the migrate identity the check is connected as,
 * and `datdba`. The same member list must therefore be accounted for in BOTH
 * databases, which is a condition on the MIGRATE IDENTITIES and the
 * memberships they hold, and not on the owners being equal or distinct:
 *
 *   - ONE migrate identity for both databases satisfies the contract however
 *     their owners differ. It is the only member, and each database
 *     recognises it as the identity it is connected as;
 *   - TWO migrate identities satisfy it only where each database can account
 *     for the other's on one of the three grounds this check accepts: the
 *     member is SUPERUSER, a role the connected migrate identity itself
 *     inherits, or a holder of that database's owner privileges. Where each
 *     database is owned by the role that migrates it, none of the three covers
 *     the other's migrator, so both refuse, each naming it against all three
 *     definer roles. That refusal is symmetric: no provisioning order
 *     satisfies both, the `revoke` each error names would break the other
 *     database, and two roles cannot be members of each other.
 *
 * Two databases sharing one owner therefore pass where each is migrated as an
 * identity holding that owner's privileges — the usual deployment shape, where
 * the migrate role owns the database it migrates — and are refused where
 * neither identity is covered on any of those grounds, exactly as two distinct
 * owners are. Sharing an owner is not sufficient on its own and distinct
 * owners are not what fails: what counts is what each member of the definer
 * roles is in the database doing the checking.
 *
 * Verified in __tests__/database-role-contract.test.ts, on PostgreSQL 17.11
 * and 16.15: it provisions a second database in the test cluster and runs
 * {@link verifyDatabaseRoles} in both databases. Two databases each owned by
 * the distinct non-superuser role that migrates it refuse symmetrically; the
 * same two databases with distinct owners under ONE migrate identity pass in
 * both; and a second migrate identity granted the second database's owner is
 * accepted there while the first database, whose owner privileges it does not
 * hold, still refuses it.
 *
 * The check cannot admit a member on the strength of its being SOME database's
 * owner: that would let the owner of any database in the cluster hold the
 * definer roles' grants in this one. One cluster per deployment, which is what
 * `db:provision-roles` assumes, needs none of this. See docs/migrations.md.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "./connection.js";
import manifest from "../generated/db/manifest.json" with { type: "json" };

export type DatabaseRoleContract = {
  key: "app" | "worker" | "blueprintReader" | "identityResolver" | "recordActionResolver";
  name: string;
  login: boolean;
  migratorMember: boolean;
  purpose: string;
};

export const DATABASE_ROLES: readonly DatabaseRoleContract[] =
  (manifest as { databaseRoles?: readonly DatabaseRoleContract[] }).databaseRoles ?? [];

export function databaseRole(key: DatabaseRoleContract["key"]): DatabaseRoleContract {
  const role = DATABASE_ROLES.find((candidate) => candidate.key === key);
  if (!role) throw new Error(`The generated manifest declares no ${key} database role.`);
  return role;
}

type RoleRow = {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolinherit: boolean;
  member: boolean;
};

/**
 * A role that holds a declared role's privileges by membership.
 *
 * The definer roles own SECURITY DEFINER functions and hold the narrow grants
 * those functions need, and RLS matches a policy's `TO` list with
 * `has_privs_of_role` — so every member of a definer role inherits both the
 * grants and the policies written for it. The contract is that the only
 * members are the MIGRATE identity, which must hand the objects over, and
 * whatever role already holds this database's owner privileges.
 */
type RoleMemberRow = {
  role: string;
  member: string;
  superuser: boolean;
  /** The member is the migrate identity, or a role it is itself a member of. */
  migrator: boolean;
  /** The member holds the privileges of this database's owner. */
  databaseOwner: boolean;
};

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid database role name: ${name}`);
  return name;
}

/** The statements an administrator runs to satisfy the contract. Passwords are
 * never rendered; login roles get a placeholder the operator replaces. */
export function renderProvisioningSql(options: { migratorRole?: string } = {}): string {
  const lines: string[] = [];
  for (const role of DATABASE_ROLES) {
    const name = identifier(role.name);
    const attributes = role.login
      ? "login password '<set-by-operator>' nosuperuser nobypassrls nocreatedb " +
        "nocreaterole noreplication"
      : "nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication";
    lines.push(`-- ${role.purpose}`);
    lines.push(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = '${name}') ` +
        `then create role ${name} ${attributes}; end if; end $$;`,
    );
    if (role.migratorMember && options.migratorRole) {
      lines.push(`grant ${name} to ${identifier(options.migratorRole)} with inherit true, set true;`);
    }
  }
  return lines.join("\n");
}

async function readRoles(db: OpenShapeForgeDatabase): Promise<Map<string, RoleRow>> {
  const names = DATABASE_ROLES.map((role) => sql.lit(identifier(role.name)));
  if (names.length === 0) return new Map();
  const result = await sql<RoleRow>`
    select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole,
      rolcreatedb, rolreplication, rolinherit,
      (pg_has_role(current_user, rolname, 'USAGE')
        and pg_has_role(current_user, rolname, 'SET')) as member
    from pg_roles
    where rolname in (${sql.join(names)})
  `.execute(db);
  return new Map(result.rows.map((row) => [row.rolname, row]));
}

/** Every role that holds a declared role's privileges by membership. */
async function readRoleMembers(db: OpenShapeForgeDatabase): Promise<RoleMemberRow[]> {
  const names = DATABASE_ROLES.map((role) => sql.lit(identifier(role.name)));
  if (names.length === 0) return [];
  const result = await sql<RoleMemberRow>`
    select role.rolname as role, member.rolname as member,
      member.rolsuper as superuser,
      pg_has_role(current_user, member.rolname, 'USAGE') as migrator,
      pg_has_role(member.rolname,
        (select datdba from pg_database where datname = current_database()),
        'USAGE') as "databaseOwner"
    from pg_auth_members am
    join pg_roles role on role.oid = am.roleid
    join pg_roles member on member.oid = am.member
    where role.rolname in (${sql.join(names)})
    order by role.rolname, member.rolname
  `.execute(db);
  return result.rows;
}

/** Every role a declared role is itself a member of, and therefore inherits. */
async function readRoleMemberships(db: OpenShapeForgeDatabase): Promise<Map<string, string[]>> {
  const names = DATABASE_ROLES.map((role) => sql.lit(identifier(role.name)));
  if (names.length === 0) return new Map();
  const result = await sql<{ role: string; parent: string }>`
    select member.rolname as role, role.rolname as parent
    from pg_auth_members am
    join pg_roles role on role.oid = am.roleid
    join pg_roles member on member.oid = am.member
    where member.rolname in (${sql.join(names)})
    order by member.rolname, role.rolname
  `.execute(db);
  const memberships = new Map<string, string[]>();
  for (const row of result.rows) {
    memberships.set(row.role, [...(memberships.get(row.role) ?? []), row.parent]);
  }
  return memberships;
}

/**
 * Check the contract against pg_roles as the CURRENT connection. Throws one
 * error naming every deviation and the statements that fix them, so a fresh
 * environment fails once with the complete remedy rather than one role at a
 * time.
 *
 * Attributes, MEMBERSHIP IN the declared roles, and the declared roles' own
 * memberships are all part of the contract:
 *
 *   - no declared role may be SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or
 *     REPLICATION. The first two put it outside row security; the rest let it
 *     widen its own reach without an administrator;
 *   - a definer role must be NOINHERIT and a member of nothing. Its functions
 *     are SECURITY DEFINER, so `grant <anything> to <definer>` would widen
 *     every one of those bodies at once;
 *   - the only members OF a definer role are the migrate identity, which must
 *     hand its objects over, and roles that already hold this database's owner
 *     privileges. Every other member inherits the definer role's narrow grants
 *     AND is matched by the policies written `TO` it, because RLS resolves a
 *     policy's TO list with has_privs_of_role. A second member is a second
 *     holder of those grants; the record-action fence bounds it (its exemption
 *     is the table owner's privileges, not a role name), but the contract is
 *     that it does not exist. Superusers are accepted because they are outside
 *     row security and privilege checks regardless of any membership.
 */
export async function verifyDatabaseRoles(db: OpenShapeForgeDatabase): Promise<void> {
  const rows = await readRoles(db);
  const current = (await sql<{ user: string }>`select current_user as "user"`.execute(db)).rows[0]!.user;
  const problems: string[] = [];
  const remedies: string[] = [];
  for (const role of DATABASE_ROLES) {
    const row = rows.get(role.name);
    if (!row) {
      problems.push(`role ${role.name} (${role.key}) does not exist`);
      continue;
    }
    if (row.rolsuper) problems.push(`role ${role.name} must not be SUPERUSER`);
    if (row.rolbypassrls) problems.push(`role ${role.name} must not have BYPASSRLS`);
    if (row.rolcreaterole) problems.push(`role ${role.name} must not have CREATEROLE`);
    if (row.rolcreatedb) problems.push(`role ${role.name} must not have CREATEDB`);
    if (row.rolreplication) problems.push(`role ${role.name} must not have REPLICATION`);
    if (row.rolcanlogin !== role.login) {
      problems.push(`role ${role.name} must ${role.login ? "" : "not "}be able to log in`);
    }
    // A definer role owns SECURITY DEFINER functions, so what it inherits is
    // what those bodies run with.
    if (!role.login && row.rolinherit) {
      problems.push(`definer role ${role.name} must be NOINHERIT`);
      remedies.push(`alter role ${identifier(role.name)} noinherit;`);
    }
    if (role.migratorMember && !row.member) {
      problems.push(`migrate role ${current} is not a member of ${role.name}`);
    }
  }
  const definers = new Set(DATABASE_ROLES.filter((role) => !role.login).map((role) => role.name));
  for (const [name, parents] of await readRoleMemberships(db)) {
    if (!definers.has(name)) continue;
    for (const parent of parents) {
      problems.push(`definer role ${name} must not be a member of ${parent}`);
      remedies.push(`revoke ${identifier(parent)} from ${identifier(name)};`);
    }
  }
  for (const row of await readRoleMembers(db)) {
    if (!definers.has(row.role)) continue;
    if (row.superuser || row.migrator || row.databaseOwner) continue;
    problems.push(
      `role ${row.member} is a member of definer role ${row.role} and is neither the ` +
        `migrate role ${current} nor a holder of this database's owner privileges`,
    );
    remedies.push(`revoke ${identifier(row.role)} from ${identifier(row.member)};`);
  }
  if (problems.length === 0) return;
  throw new Error(
    "Database role contract is not satisfied:\n" +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      "\n\nRoles are cluster-wide and are provisioned by the host, not by this migration. " +
      "Run apps/api/src/db/provision-roles.ts with OPENSHAPEFORGE_ADMIN_DATABASE_URL, " +
      "or execute as an administrator:\n\n" +
      [renderProvisioningSql({ migratorRole: current }), ...remedies].join("\n"),
  );
}

export type ProvisionOptions = {
  /** Password per login role, keyed by contract key. Required for login roles that do not exist yet. */
  passwords: Partial<Record<DatabaseRoleContract["key"], string>>;
  /** Existing login roles whose passwords must be rotated explicitly. */
  rotatePasswords?: Partial<Record<DatabaseRoleContract["key"], boolean>>;
  /** The migrate role that must become a member of the definer roles. */
  migratorRole?: string;
};

export type ProvisionResult = { created: string[]; rotated: string[]; granted: string[]; unchanged: string[] };

/**
 * Satisfy the contract as an ADMINISTRATOR connection (CREATEROLE). Idempotent:
 * existing roles are left untouched unless their password is explicitly
 * selected for rotation, and memberships are granted only when missing.
 */
export async function provisionDatabaseRoles(
  admin: OpenShapeForgeDatabase,
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const result: ProvisionResult = { created: [], rotated: [], granted: [], unchanged: [] };
  const before = await readRoles(admin);
  for (const role of DATABASE_ROLES) {
    const name = identifier(role.name);
    if (!before.has(role.name)) {
      if (role.login) {
        const password = options.passwords[role.key];
        if (!password) {
          throw new Error(`A password is required to create login role ${role.name} (${role.key}).`);
        }
        await sql`
          create role ${sql.ref(name)} login password ${sql.lit(password)}
          nosuperuser nobypassrls nocreatedb nocreaterole noreplication
        `.execute(admin);
      } else {
        await sql`
          create role ${sql.ref(name)} nologin nosuperuser nocreatedb
          nocreaterole noinherit nobypassrls noreplication
        `.execute(admin);
      }
      result.created.push(role.name);
    } else if (role.login && options.rotatePasswords?.[role.key]) {
      const password = options.passwords[role.key];
      if (!password) {
        throw new Error(`A password is required to rotate login role ${role.name} (${role.key}).`);
      }
      await sql`alter role ${sql.ref(name)} login password ${sql.lit(password)}`.execute(admin);
      result.rotated.push(role.name);
    } else {
      result.unchanged.push(role.name);
    }
    if (role.migratorMember && options.migratorRole) {
      const migrator = identifier(options.migratorRole);
      const membership = await sql<{ member: boolean; superuser: boolean }>`
        select (pg_has_role(${migrator}, ${name}, 'USAGE')
          and pg_has_role(${migrator}, ${name}, 'SET')) as member,
          (select rolsuper from pg_roles where rolname = ${migrator}) as superuser
      `.execute(admin);
      const row = membership.rows[0];
      if (row && !row.member && !row.superuser) {
        await sql`
          grant ${sql.ref(name)} to ${sql.ref(migrator)}
          with inherit true, set true
        `.execute(admin);
        result.granted.push(`${name} -> ${migrator}`);
      }
    }
  }
  return result;
}
