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
  key: "app" | "worker" | "blueprintReader";
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
  member: boolean;
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
      ? "login password '<set-by-operator>' nosuperuser nobypassrls"
      : "nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls";
    lines.push(`-- ${role.purpose}`);
    lines.push(
      `do $$ begin if not exists (select 1 from pg_roles where rolname = '${name}') ` +
        `then create role ${name} ${attributes}; end if; end $$;`,
    );
    if (role.migratorMember && options.migratorRole) {
      lines.push(`grant ${name} to ${identifier(options.migratorRole)};`);
    }
  }
  return lines.join("\n");
}

async function readRoles(db: OpenShapeForgeDatabase): Promise<Map<string, RoleRow>> {
  const names = DATABASE_ROLES.map((role) => sql.lit(identifier(role.name)));
  if (names.length === 0) return new Map();
  const result = await sql<RoleRow>`
    select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole,
      pg_has_role(current_user, rolname, 'USAGE') as member
    from pg_roles
    where rolname in (${sql.join(names)})
  `.execute(db);
  return new Map(result.rows.map((row) => [row.rolname, row]));
}

/**
 * Check the contract against pg_roles as the CURRENT connection. Throws one
 * error naming every deviation and the statements that fix them, so a fresh
 * environment fails once with the complete remedy rather than one role at a
 * time.
 */
export async function verifyDatabaseRoles(db: OpenShapeForgeDatabase): Promise<void> {
  const rows = await readRoles(db);
  const current = (await sql<{ user: string }>`select current_user as "user"`.execute(db)).rows[0]!.user;
  const problems: string[] = [];
  for (const role of DATABASE_ROLES) {
    const row = rows.get(role.name);
    if (!row) {
      problems.push(`role ${role.name} (${role.key}) does not exist`);
      continue;
    }
    if (row.rolsuper) problems.push(`role ${role.name} must not be SUPERUSER`);
    if (row.rolbypassrls) problems.push(`role ${role.name} must not have BYPASSRLS`);
    if (row.rolcanlogin !== role.login) {
      problems.push(`role ${role.name} must ${role.login ? "" : "not "}be able to log in`);
    }
    if (role.migratorMember && !row.member) {
      problems.push(`migrate role ${current} is not a member of ${role.name}`);
    }
  }
  if (problems.length === 0) return;
  throw new Error(
    "Database role contract is not satisfied:\n" +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      "\n\nRoles are cluster-wide and are provisioned by the host, not by this migration. " +
      "Run apps/api/src/db/provision-roles.ts with OPENSHAPEFORGE_ADMIN_DATABASE_URL, " +
      "or execute as an administrator:\n\n" +
      renderProvisioningSql({ migratorRole: current }),
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
          nosuperuser nobypassrls
        `.execute(admin);
      } else {
        await sql`
          create role ${sql.ref(name)} nologin nosuperuser nocreatedb
          nocreaterole noinherit nobypassrls
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
        select pg_has_role(${migrator}, ${name}, 'USAGE') as member,
          (select rolsuper from pg_roles where rolname = ${migrator}) as superuser
      `.execute(admin);
      const row = membership.rows[0];
      if (row && !row.member && !row.superuser) {
        await sql`grant ${sql.ref(name)} to ${sql.ref(migrator)}`.execute(admin);
        result.granted.push(`${name} -> ${migrator}`);
      }
    }
  }
  return result;
}
