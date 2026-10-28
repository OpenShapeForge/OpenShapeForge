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
  /** The migrate identity holds this role's privileges and can SET ROLE to it. */
  member: boolean;
  /** `grant <role> to <migrate identity>` exists — not a path through a third role. */
  direct: boolean;
};

/**
 * The identity a migration actually runs as, and the ONE other role name the
 * membership contract admits.
 *
 * Every rule below compares role NAMES against these two. `pg_has_role` is not
 * an identity test: `pg_has_role(current_user, X, 'USAGE')` is true for every
 * role X granted TO the migrate role, and true for EVERY role when the caller
 * is a superuser. Using it to answer "is this member the migrator?" admitted
 * both — a helper role granted to migrate and also granted a definer role
 * passed the contract, and a superuser caller passed every member of every
 * definer role (verified on PostgreSQL 17.11). That helper inherits the
 * definer role's grants and, because object ownership is resolved with
 * `has_privs_of_role`, OWNS its SECURITY DEFINER functions: with `CREATE` on
 * schema `app` it can `create or replace app.record_action_allows`.
 */
export type MigrateIdentity = {
  /** `current_user`, by name. */
  user: string;
  /**
   * The caller is a SUPERUSER. It needs no grant to hand objects over and is
   * outside row security and privilege checks either way, so it satisfies the
   * membership requirement explicitly rather than by accident of `pg_has_role`
   * — and it never widens which MEMBERS of a definer role are admitted.
   */
  superuser: boolean;
  /**
   * The owner of the current database, by name. It already owns the schema the
   * definer objects live in, so its membership is part of the contract; a role
   * that merely holds its privileges is not it, and is reported.
   */
  databaseOwner: string | null;
};

/** A member of a definer role that the contract does not admit. */
export type UnintendedDefinerMember = { role: string; member: string };

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

/** The migrate identity, read once and compared by name from then on. */
export async function readMigrateIdentity(db: OpenShapeForgeDatabase): Promise<MigrateIdentity> {
  const result = await sql<MigrateIdentity>`
    select current_user as "user",
      coalesce((select rolsuper from pg_roles where rolname = current_user), false) as superuser,
      (select owner.rolname from pg_database d
         join pg_roles owner on owner.oid = d.datdba
        where d.datname = current_database()) as "databaseOwner"
  `.execute(db);
  return result.rows[0]!;
}

/**
 * The members of the given roles that the contract does not admit, by NAME.
 *
 * Admitted, and nothing else:
 *
 *   - `current_user`, the migrate identity that must hand the objects over.
 *     The grant has to be to that identity itself: a role granted TO it is a
 *     different principal, reachable by anything that can reach the helper,
 *     and inherits the definer role's grants and the ownership of its
 *     SECURITY DEFINER functions;
 *   - the owner of the current database, which already owns the schema those
 *     objects live in. By name again — a role that merely holds the owner's
 *     privileges would, as a definer member, gain function ownership the
 *     owner's privileges alone do not confer;
 *   - a SUPERUSER member, because it is outside row security and every
 *     privilege check with or without the membership, so revoking it would
 *     change nothing.
 *
 * Nothing here depends on what the CALLER holds, so a superuser running the
 * check sees the same deviations a restricted migrate role does.
 */
export async function readUnintendedDefinerMembers(
  db: OpenShapeForgeDatabase,
  roles: readonly string[],
): Promise<UnintendedDefinerMember[]> {
  const names = roles.map((role) => sql.lit(identifier(role)));
  if (names.length === 0) return [];
  const result = await sql<UnintendedDefinerMember>`
    select role.rolname as role, member.rolname as member
    from pg_auth_members am
    join pg_roles role on role.oid = am.roleid
    join pg_roles member on member.oid = am.member
    where role.rolname in (${sql.join(names)})
      and not member.rolsuper
      and member.rolname <> current_user
      and member.oid <> coalesce(
        (select datdba from pg_database where datname = current_database()), 0)
    order by role.rolname, member.rolname
  `.execute(db);
  return result.rows;
}

async function readRoles(db: OpenShapeForgeDatabase): Promise<Map<string, RoleRow>> {
  const names = DATABASE_ROLES.map((role) => sql.lit(identifier(role.name)));
  if (names.length === 0) return new Map();
  const result = await sql<RoleRow>`
    select r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole,
      r.rolcreatedb, r.rolreplication, r.rolinherit,
      (pg_has_role(current_user, r.rolname, 'USAGE')
        and pg_has_role(current_user, r.rolname, 'SET')) as member,
      exists (select 1 from pg_auth_members am
        where am.roleid = r.oid
          and am.member = (select cu.oid from pg_roles cu where cu.rolname = current_user)) as direct
    from pg_roles r
    where r.rolname in (${sql.join(names)})
  `.execute(db);
  return new Map(result.rows.map((row) => [row.rolname, row]));
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
 *   - the migrate identity holds every role it must hand objects over to by a
 *     DIRECT grant, or is a superuser and needs none. A membership that only
 *     exists through a third role means that role is a member too, and the
 *     rule below is what refuses it;
 *   - the only members OF a definer role are the migrate identity itself and
 *     the owner of this database, by {@link readUnintendedDefinerMembers}.
 *     Every other member inherits the definer role's narrow grants, OWNS its
 *     SECURITY DEFINER functions (ownership is resolved with
 *     `has_privs_of_role`) AND is matched by the policies written `TO` it. A
 *     second member is a second holder of those grants; the record-action
 *     fence bounds its writes (its exemption is the table owner's privileges,
 *     not a role name) but nothing stops it replacing a function body, so the
 *     contract is that it does not exist. Superusers are accepted because they
 *     are outside row security and privilege checks regardless of any
 *     membership.
 *
 * Deviations are reported with the `revoke` that fixes them and never revoked
 * here: this runs as the migrate role, which is deliberately not a role
 * administrator, and a membership an operator created is theirs to remove.
 */
export async function verifyDatabaseRoles(db: OpenShapeForgeDatabase): Promise<void> {
  const rows = await readRoles(db);
  const identity = await readMigrateIdentity(db);
  const current = identity.user;
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
    // A superuser hands the objects over without a grant. Otherwise the grant
    // must name the migrate identity itself: holding the role through a third
    // role makes that role a member, which the member scan below refuses.
    if (role.migratorMember && !identity.superuser) {
      const grant = `grant ${identifier(role.name)} to ${identifier(current)} with inherit true, set true;`;
      if (!row.direct && !row.member) {
        problems.push(`migrate role ${current} is not a member of ${role.name}`);
      } else if (!row.direct) {
        problems.push(
          `migrate role ${current} holds ${role.name} only through another role, ` +
            `not as a direct member`,
        );
        remedies.push(grant);
      } else if (!row.member) {
        problems.push(
          `migrate role ${current} is a member of ${role.name} without INHERIT and SET`,
        );
        remedies.push(grant);
      }
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
  for (const row of await readUnintendedDefinerMembers(db, [...definers])) {
    problems.push(
      `role ${row.member} is a member of definer role ${row.role} and is neither the ` +
        `migrate role ${current} nor this database's owner ${identity.databaseOwner ?? "(unknown)"}`,
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
      // `member` is the capability and `direct` is the grant the contract
      // requires: an indirect membership satisfies pg_has_role and would leave
      // provisioning idempotent against a contract verifyDatabaseRoles refuses.
      const membership = await sql<{ member: boolean; direct: boolean; superuser: boolean }>`
        select (pg_has_role(${migrator}, ${name}, 'USAGE')
          and pg_has_role(${migrator}, ${name}, 'SET')) as member,
          exists (select 1 from pg_auth_members am
            join pg_roles role on role.oid = am.roleid
            join pg_roles member on member.oid = am.member
            where role.rolname = ${name} and member.rolname = ${migrator}) as direct,
          (select rolsuper from pg_roles where rolname = ${migrator}) as superuser
      `.execute(admin);
      const row = membership.rows[0];
      if (row && !(row.member && row.direct) && !row.superuser) {
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
