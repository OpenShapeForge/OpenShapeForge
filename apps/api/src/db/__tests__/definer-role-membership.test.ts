// SPDX-License-Identifier: BUSL-1.1
/**
 * WHO the membership contract admits as a member of a definer role.
 *
 * The contract says "the migrate identity and this database's owner". It was
 * enforced with `pg_has_role(current_user, <member>, 'USAGE')`, which is not an
 * identity test: it is true for every role granted TO the migrate role, and
 * true for every role when the caller is a superuser. So a helper role granted
 * to the migrate role AND granted a definer role passed the contract — and a
 * member of the record-action resolver inherits its column grants, is matched
 * by the policies written `TO` it, and OWNS its SECURITY DEFINER functions,
 * because ownership is resolved with `has_privs_of_role`. With `CREATE` on
 * schema `app` from the same membership it can replace
 * `app.record_action_allows` and answer every record action itself.
 *
 * Neither question stops at a direct grant, and that is the second half of
 * this file. The two roles the contract admits are ordinary roles: a third
 * role granted the DATABASE OWNER reaches the definer role through it and
 * replaces the same function without ever being its member, and a direct
 * grant carrying neither INHERIT nor SET satisfies `pg_has_role` whenever
 * that third path supplies the privilege. So the contract walks the
 * membership graph outwards from each definer role, and reads the migrate
 * identity's own grant off the EDGE.
 *
 * Every case here runs against a real PostgreSQL cluster as a restricted
 * migrate role — NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE — and once as the
 * superuser, because that is the caller the old predicate was weakest for.
 * Two databases with DIFFERENT owners share the cluster, because the definer
 * roles are cluster-wide while "this database's owner" is not.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { databaseRole, verifyDatabaseRoles, DATABASE_ROLES } from "../database-roles.js";
import { runMigrationChain } from "../migration-chain.js";
import { applyRecordActionsMigration } from "../migrations/record-actions.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 240_000;
const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
const migrateRole = `osf_member_migrate_${suffix}`;
const helperRole = `osf_member_helper_${suffix}`;
const ownerRole = `osf_member_owner_${suffix}`;
/** The attacker: granted an ADMITTED role, never the definer role itself. */
const indirectRole = `osf_member_indirect_${suffix}`;
const scratch = `definer_members_${suffix}`;
const ownedScratch = `definer_members_owned_${suffix}`;
const MIGRATE_PASSWORD = "definer-members";
const RESOLVER_ROLE = databaseRole("recordActionResolver").name;

let server: SQL;
let migrate: DatabaseRuntime;
let superuser: DatabaseRuntime;
let migrateOnOwnedDatabase: DatabaseRuntime;
let indirectOnOwnedDatabase: DatabaseRuntime;

function url(database: string, role?: { username: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (role) {
    parsed.username = role.username;
    parsed.password = role.password;
  }
  return parsed.toString();
}

beforeAll(async () => {
  for (const name of [migrateRole, helperRole, ownerRole, indirectRole, scratch, ownedScratch]) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe identifier ${name}`);
  }
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(
    `create role ${migrateRole} login password '${MIGRATE_PASSWORD}' ` +
      "nosuperuser nobypassrls nocreaterole nocreatedb",
  );
  await server.unsafe(`create role ${helperRole} nologin nosuperuser nobypassrls`);
  await server.unsafe(`create role ${ownerRole} nologin nosuperuser nobypassrls`);
  await server.unsafe(
    `create role ${indirectRole} login password '${MIGRATE_PASSWORD}' ` +
      "nosuperuser nobypassrls nocreaterole nocreatedb",
  );
  // The expected deployment shape: the host grants each definer role to the
  // migrate identity ITSELF, with INHERIT and SET.
  for (const role of DATABASE_ROLES) {
    if (role.migratorMember) {
      await server.unsafe(`grant ${role.name} to ${migrateRole} with inherit true, set true`);
    }
  }
  await server.unsafe(`create database "${scratch}" owner ${migrateRole}`);
  await server.unsafe(`create database "${ownedScratch}" owner ${ownerRole}`);
  // A deployment whose migrate identity is NOT the database owner. It needs
  // CREATE to build the schema; it is still not the owner of the database.
  await server.unsafe(
    `grant create, connect, temporary on database "${ownedScratch}" to ${migrateRole}`,
  );
  migrate = createDatabaseRuntime({
    databaseUrl: url(scratch, { username: migrateRole, password: MIGRATE_PASSWORD }),
    maxConnections: 2,
  });
  superuser = createDatabaseRuntime({ databaseUrl: url(scratch), maxConnections: 1 });
  migrateOnOwnedDatabase = createDatabaseRuntime({
    databaseUrl: url(ownedScratch, { username: migrateRole, password: MIGRATE_PASSWORD }),
    maxConnections: 2,
  });
  indirectOnOwnedDatabase = createDatabaseRuntime({
    databaseUrl: url(ownedScratch, { username: indirectRole, password: MIGRATE_PASSWORD }),
    maxConnections: 1,
  });
  // A clean install on both, so the function bodies the attacks try to
  // replace are the real ones.
  await migrate.db.connection().execute((conn) => runMigrationChain(conn));
  await migrateOnOwnedDatabase.db.connection().execute((conn) => runMigrationChain(conn));
}, TEST_TIMEOUT);

afterAll(async () => {
  await migrate?.close();
  await superuser?.close();
  await migrateOnOwnedDatabase?.close();
  await indirectOnOwnedDatabase?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  await server?.unsafe(`drop database if exists "${ownedScratch}" with (force)`);
  for (const role of DATABASE_ROLES) {
    await server?.unsafe(`revoke ${role.name} from ${migrateRole}`).catch(() => undefined);
    await server?.unsafe(`revoke ${role.name} from ${helperRole}`).catch(() => undefined);
    await server?.unsafe(`revoke ${role.name} from ${ownerRole}`).catch(() => undefined);
    await server?.unsafe(`revoke ${role.name} from ${indirectRole}`).catch(() => undefined);
  }
  await server?.unsafe(`revoke ${helperRole} from ${migrateRole}`).catch(() => undefined);
  await server?.unsafe(`revoke ${ownerRole} from ${migrateRole}`).catch(() => undefined);
  await server?.unsafe(`revoke ${ownerRole} from ${indirectRole}`).catch(() => undefined);
  await server?.unsafe(`revoke ${migrateRole} from ${indirectRole}`).catch(() => undefined);
  await server?.unsafe(`revoke ${helperRole} from ${indirectRole}`).catch(() => undefined);
  await server?.unsafe(`drop role if exists ${helperRole}`);
  await server?.unsafe(`drop role if exists ${indirectRole}`);
  await server?.unsafe(`drop role if exists ${ownerRole}`);
  await server?.unsafe(`drop role if exists ${migrateRole}`);
  await server?.close();
}, TEST_TIMEOUT);

/** `grant <resolver> to <helper>` plus `grant <helper> to <migrate>`. */
async function withHelperMembership(work: () => Promise<void>): Promise<void> {
  await server.unsafe(`grant ${helperRole} to ${migrateRole} with inherit true, set true`);
  await server.unsafe(`grant ${RESOLVER_ROLE} to ${helperRole} with inherit true, set true`);
  try {
    await work();
  } finally {
    await server.unsafe(`revoke ${RESOLVER_ROLE} from ${helperRole}`);
    await server.unsafe(`revoke ${helperRole} from ${migrateRole}`);
  }
}

test("a helper role the migrate role inherits is not the migrate identity", async () => {
  await withHelperMembership(async () => {
    const error = await migrate.db.connection()
      .execute((conn) => verifyDatabaseRoles(conn))
      .then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain("Database role contract is not satisfied");
    expect(error?.message).toContain(
      `role ${helperRole} is a member of definer role ${RESOLVER_ROLE}`,
    );
    expect(error?.message).toContain(`revoke ${RESOLVER_ROLE} from ${helperRole};`);
    // The migrate identity is a member too, and must NOT be reported.
    expect(error?.message).not.toContain(`revoke ${RESOLVER_ROLE} from ${migrateRole};`);
    // Nothing was revoked on the way to the refusal: the contract fails closed
    // and names the statement, it does not repair a membership an operator made.
    const still = await migrate.db.connection().execute((conn) =>
      sql<{ present: boolean }>`
        select exists (select 1 from pg_auth_members am
          join pg_roles role on role.oid = am.roleid
          join pg_roles member on member.oid = am.member
         where role.rolname = ${RESOLVER_ROLE} and member.rolname = ${helperRole}) as present
      `.execute(conn));
    expect(still.rows[0]?.present).toBe(true);
    // And the chain refuses rather than running on past it.
    await expect(migrate.db.connection().execute((conn) => runMigrationChain(conn)))
      .rejects.toThrow(`role ${helperRole} is a member of definer role ${RESOLVER_ROLE}`);
  });
  await migrate.db.connection().execute((conn) => verifyDatabaseRoles(conn));
}, TEST_TIMEOUT);

test("the record-action step refuses the same membership when it is called directly", async () => {
  await withHelperMembership(async () => {
    await migrate.db.connection().execute(async (conn) => {
      const failure = await applyRecordActionsMigration(conn, [])
        .then(() => undefined, (caught: unknown) => caught as Error);
      expect(failure?.message).toContain(
        `The record-action resolver role ${RESOLVER_ROLE} cannot be used: ${helperRole} is a member of it`,
      );
      expect(failure?.message).toContain(`revoke ${RESOLVER_ROLE} from ${helperRole};`);
      expect(failure?.message).toContain("replace their bodies");
    });
  });
  await migrate.db.connection().execute((conn) => applyRecordActionsMigration(conn, []));
}, TEST_TIMEOUT);

test("a superuser caller reports the same deviation rather than admitting every member", async () => {
  await withHelperMembership(async () => {
    const identity = await superuser.db.connection().execute((conn) =>
      sql<{ user: string; superuser: boolean }>`
        select current_user as "user",
          (select rolsuper from pg_roles where rolname = current_user) as superuser
      `.execute(conn));
    expect(identity.rows[0]?.superuser).toBe(true);
    await expect(superuser.db.connection().execute((conn) => verifyDatabaseRoles(conn)))
      .rejects.toThrow(`role ${helperRole} is a member of definer role ${RESOLVER_ROLE}`);
    await expect(superuser.db.connection().execute((conn) => applyRecordActionsMigration(conn, [])))
      .rejects.toThrow(`${helperRole} is a member of it`);
  });
}, TEST_TIMEOUT);

/**
 * Why the refusal is not pedantic. With the membership in place the helper
 * holds the resolver's privileges, which includes ownership of the two
 * SECURITY DEFINER functions and `CREATE` on schema `app` — so it replaces
 * the authorization body with `select true` and every record action is
 * allowed. The gate above is what stands between a deployment and this.
 */
test("a member of the resolver can replace the lookup it owns", async () => {
  await withHelperMembership(async () => {
    await migrate.db.connection().execute(async (conn) => {
      const reach = await sql<{ owns: boolean; creates: boolean }>`
        select pg_has_role(${helperRole}, ${RESOLVER_ROLE}, 'USAGE') as owns,
          has_schema_privilege(${helperRole}, 'app', 'CREATE') as creates
      `.execute(conn);
      expect(reach.rows[0]).toEqual({ owns: true, creates: true });

      await sql.raw(`set role ${helperRole}`).execute(conn);
      const acting = await sql<{ user: string }>`select current_user as "user"`.execute(conn);
      expect(acting.rows[0]?.user).toBe(helperRole);
      // Not the migrate role, and not the resolver: a third principal.
      await sql.raw(`
        create or replace function app.record_action_allows(entity text, record_key text, action text)
        returns boolean language sql volatile security definer
        set search_path = pg_catalog, pg_temp as $$ select true $$
      `).execute(conn);
      await sql.raw(`set role ${RESOLVER_ROLE}`).execute(conn);
      const asResolver = await sql<{ user: string }>`select current_user as "user"`.execute(conn);
      expect(asResolver.rows[0]?.user).toBe(RESOLVER_ROLE);
      await sql`reset role`.execute(conn);
      const owner = await sql<{ owner: string; replaced: boolean }>`
        select r.rolname as owner, p.prosrc like '%select true%' as replaced
          from pg_proc p join pg_roles r on r.oid = p.proowner
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and p.proname = 'record_action_allows'
      `.execute(conn);
      expect(owner.rows[0]).toEqual({ owner: RESOLVER_ROLE, replaced: true });
      expect((await sql<{ allowed: boolean }>`
        select app.record_action_allows('Nothing', 'nokey', 'start') as allowed
      `.execute(conn)).rows[0]?.allowed).toBe(true);
    });
  });
  // Revoked, the step installs the real body again and the lookup answers no.
  await migrate.db.connection().execute(async (conn) => {
    await applyRecordActionsMigration(conn, []);
    expect((await sql<{ allowed: boolean }>`
      select app.record_action_allows('Nothing', 'nokey', 'start') as allowed
    `.execute(conn)).rows[0]?.allowed).toBe(false);
  });
}, TEST_TIMEOUT);

/**
 * The shapes a deployment is supposed to have. The migrate identity's own
 * membership has to be a DIRECT grant: held through a group, that group is a
 * member of the definer role as well, with everything the test above shows.
 */
test("the intended memberships pass and an indirect one does not", async () => {
  // The database owner, by name, on a database the migrate role does not own.
  await server.unsafe(`grant ${RESOLVER_ROLE} to ${ownerRole} with inherit true, set true`);
  try {
    await migrateOnOwnedDatabase.db.connection().execute((conn) => verifyDatabaseRoles(conn));
    // The same membership on the database the MIGRATE role owns is not the
    // owner's, and is reported.
    await expect(migrate.db.connection().execute((conn) => verifyDatabaseRoles(conn)))
      .rejects.toThrow(`role ${ownerRole} is a member of definer role ${RESOLVER_ROLE}`);
  } finally {
    await server.unsafe(`revoke ${RESOLVER_ROLE} from ${ownerRole}`);
  }

  // Membership through a group instead of a direct grant.
  await server.unsafe(`revoke ${RESOLVER_ROLE} from ${migrateRole}`);
  await server.unsafe(`grant ${RESOLVER_ROLE} to ${helperRole} with inherit true, set true`);
  await server.unsafe(`grant ${helperRole} to ${migrateRole} with inherit true, set true`);
  try {
    const error = await migrate.db.connection()
      .execute((conn) => verifyDatabaseRoles(conn))
      .then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain(
      `migrate role ${migrateRole} holds ${RESOLVER_ROLE} only through another role`,
    );
    expect(error?.message).toContain(
      `grant ${RESOLVER_ROLE} to ${migrateRole} with inherit true, set true;`,
    );
    expect(error?.message).toContain(`revoke ${RESOLVER_ROLE} from ${helperRole};`);
    await migrate.db.connection().execute(async (conn) => {
      const failure = await applyRecordActionsMigration(conn, [])
        .then(() => undefined, (caught: unknown) => caught as Error);
      expect(failure?.message).toContain(`${helperRole} is a member of it`);
    });
    // Without the helper's definer membership the migrate role holds nothing
    // at all, which is the plain missing-grant case.
    await server.unsafe(`revoke ${RESOLVER_ROLE} from ${helperRole}`);
    const missing = await migrate.db.connection()
      .execute((conn) => verifyDatabaseRoles(conn))
      .then(() => undefined, (caught: unknown) => caught as Error);
    expect(missing?.message).toContain(
      `migrate role ${migrateRole} is not a member of ${RESOLVER_ROLE}`,
    );
    await migrate.db.connection().execute(async (conn) => {
      const failure = await applyRecordActionsMigration(conn, [])
        .then(() => undefined, (caught: unknown) => caught as Error);
      expect(failure?.message).toContain(
        `The migrate identity ${migrateRole} cannot install the record-action lookup`,
      );
    });
  } finally {
    await server.unsafe(`revoke ${RESOLVER_ROLE} from ${helperRole}`).catch(() => undefined);
    await server.unsafe(`revoke ${helperRole} from ${migrateRole}`);
    await server.unsafe(`grant ${RESOLVER_ROLE} to ${migrateRole} with inherit true, set true`);
  }
  await migrate.db.connection().execute((conn) => verifyDatabaseRoles(conn));
}, TEST_TIMEOUT);

/**
 * `pg_has_role` answers for the whole membership GRAPH, so it cannot tell a
 * direct grant that carries INHERIT and SET from a direct grant that carries
 * neither while a third role supplies the privilege. Here the migrate
 * identity reaches the resolver through the database owner, and its own
 * direct edge is inert — the shape the member scan exists to surface, and the
 * one the old predicate accepted.
 */
test("a direct grant without INHERIT and SET is not the membership the contract needs", async () => {
  await server.unsafe(`grant ${RESOLVER_ROLE} to ${ownerRole} with inherit true, set true`);
  await server.unsafe(`grant ${ownerRole} to ${migrateRole} with inherit true, set true`);
  await server.unsafe(`grant ${RESOLVER_ROLE} to ${migrateRole} with inherit false, set false`);
  try {
    const state = await migrateOnOwnedDatabase.db.connection().execute((conn) =>
      sql<{ hasRole: boolean; inherits: boolean; sets: boolean }>`
        select (pg_has_role(current_user, ${RESOLVER_ROLE}, 'USAGE')
            and pg_has_role(current_user, ${RESOLVER_ROLE}, 'SET')) as "hasRole",
          am.inherit_option as inherits, am.set_option as sets
          from pg_auth_members am
          join pg_roles role on role.oid = am.roleid
          join pg_roles member on member.oid = am.member
         where role.rolname = ${RESOLVER_ROLE} and member.rolname = current_user
      `.execute(conn));
    // The old predicate is satisfied; the edge it claims to be reading is not.
    expect(state.rows[0]).toEqual({ hasRole: true, inherits: false, sets: false });

    const error = await migrateOnOwnedDatabase.db.connection()
      .execute((conn) => verifyDatabaseRoles(conn))
      .then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain(
      `migrate role ${migrateRole} is a member of ${RESOLVER_ROLE} without INHERIT and SET`,
    );
    expect(error?.message).toContain(
      `grant ${RESOLVER_ROLE} to ${migrateRole} with inherit true, set true;`,
    );
    await migrateOnOwnedDatabase.db.connection().execute(async (conn) => {
      const failure = await applyRecordActionsMigration(conn, [])
        .then(() => undefined, (caught: unknown) => caught as Error);
      expect(failure?.message).toContain(
        `it is a member of ${RESOLVER_ROLE} without INHERIT and SET`,
      );
    });
    // Nothing was revoked or re-granted on the way to the refusal.
    const untouched = await migrateOnOwnedDatabase.db.connection().execute((conn) =>
      sql<{ inherits: boolean }>`
        select am.inherit_option as inherits from pg_auth_members am
          join pg_roles role on role.oid = am.roleid
          join pg_roles member on member.oid = am.member
         where role.rolname = ${RESOLVER_ROLE} and member.rolname = ${migrateRole}
      `.execute(conn));
    expect(untouched.rows[0]?.inherits).toBe(false);
  } finally {
    await server.unsafe(`grant ${RESOLVER_ROLE} to ${migrateRole} with inherit true, set true`);
    await server.unsafe(`revoke ${ownerRole} from ${migrateRole}`);
    await server.unsafe(`revoke ${RESOLVER_ROLE} from ${ownerRole}`);
  }
  await migrateOnOwnedDatabase.db.connection().execute((conn) => verifyDatabaseRoles(conn));
}, TEST_TIMEOUT);

/**
 * The transitive case, and why it is not theoretical. `ownerRole` owns this
 * database, so its membership of the resolver is admitted. A role granted
 * `ownerRole` is not a member of the resolver and never appears in a direct
 * scan of `pg_auth_members` — and still runs `set role` straight to the
 * resolver and replaces the function it owns.
 */
test("a role that reaches the database owner replaces the lookup through it", async () => {
  await server.unsafe(`grant ${RESOLVER_ROLE} to ${ownerRole} with inherit true, set true`);
  await server.unsafe(`grant ${ownerRole} to ${indirectRole} with inherit true, set true`);
  try {
    // Not a member of the resolver by any direct grant.
    const direct = await migrateOnOwnedDatabase.db.connection().execute((conn) =>
      sql<{ present: boolean }>`
        select exists (select 1 from pg_auth_members am
          join pg_roles role on role.oid = am.roleid
          join pg_roles member on member.oid = am.member
         where role.rolname = ${RESOLVER_ROLE} and member.rolname = ${indirectRole}) as present
      `.execute(conn));
    expect(direct.rows[0]?.present).toBe(false);

    // The attack, on its own connection as the attacker.
    await indirectOnOwnedDatabase.db.connection().execute(async (conn) => {
      await sql.raw(`set role ${RESOLVER_ROLE}`).execute(conn);
      expect((await sql<{ user: string }>`select current_user as "user"`.execute(conn)).rows[0]?.user)
        .toBe(RESOLVER_ROLE);
      await sql.raw(`
        create or replace function app.record_action_allows(entity text, record_key text, action text)
        returns boolean language sql volatile security definer
        set search_path = pg_catalog, pg_temp as $$ select true $$
      `).execute(conn);
      await sql`reset role`.execute(conn);
    });
    const replaced = await migrateOnOwnedDatabase.db.connection().execute((conn) =>
      sql<{ owner: string; allowed: boolean }>`
        select r.rolname as owner,
          app.record_action_allows('Nothing', 'nokey', 'start') as allowed
          from pg_proc p join pg_roles r on r.oid = p.proowner
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and p.proname = 'record_action_allows'
      `.execute(conn));
    expect(replaced.rows[0]).toEqual({ owner: RESOLVER_ROLE, allowed: true });

    // And what the contract now says about it, naming the path and the one
    // revoke that cuts it — which is NOT a revoke of the resolver.
    const error = await migrateOnOwnedDatabase.db.connection()
      .execute((conn) => verifyDatabaseRoles(conn))
      .then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain(
      `role ${indirectRole} can act as definer role ${RESOLVER_ROLE} through ` +
        `${RESOLVER_ROLE} <- ${ownerRole} <- ${indirectRole}`,
    );
    expect(error?.message).toContain(`revoke ${ownerRole} from ${indirectRole};`);
    expect(error?.message).not.toContain(`revoke ${RESOLVER_ROLE} from ${ownerRole};`);
    await migrateOnOwnedDatabase.db.connection().execute(async (conn) => {
      const failure = await applyRecordActionsMigration(conn, [])
        .then(() => undefined, (caught: unknown) => caught as Error);
      expect(failure?.message).toContain(`${indirectRole} is a member of it`);
      expect(failure?.message).toContain(`revoke ${ownerRole} from ${indirectRole};`);
    });
  } finally {
    await server.unsafe(`revoke ${ownerRole} from ${indirectRole}`);
    await server.unsafe(`revoke ${RESOLVER_ROLE} from ${ownerRole}`);
  }
  // Cut, the step reinstalls the real body and the lookup answers no again.
  await migrateOnOwnedDatabase.db.connection().execute(async (conn) => {
    await applyRecordActionsMigration(conn, []);
    expect((await sql<{ allowed: boolean }>`
      select app.record_action_allows('Nothing', 'nokey', 'start') as allowed
    `.execute(conn)).rows[0]?.allowed).toBe(false);
  });
}, TEST_TIMEOUT);

/**
 * The same walk on the other admitted root. A role granted the MIGRATE
 * identity reaches every definer role the migrate identity holds, and the
 * superuser caller sees it too.
 */
test("a role that reaches the migrate identity reaches every definer role", async () => {
  await server.unsafe(`grant ${migrateRole} to ${indirectRole} with inherit true, set true`);
  try {
    for (const runtime of [migrate, superuser]) {
      const error = await runtime.db.connection()
        .execute((conn) => verifyDatabaseRoles(conn))
        .then(() => undefined, (caught: unknown) => caught as Error);
      expect(error?.message).toContain(
        `role ${indirectRole} can act as definer role ${RESOLVER_ROLE} through ` +
          `${RESOLVER_ROLE} <- ${migrateRole} <- ${indirectRole}`,
      );
      for (const role of DATABASE_ROLES.filter((candidate) => candidate.migratorMember)) {
        expect(error?.message).toContain(`can act as definer role ${role.name}`);
      }
      // One revoke cuts every one of those paths, and it is said once.
      const revoke = `revoke ${migrateRole} from ${indirectRole};`;
      expect((error?.message ?? "").split(revoke).length - 1).toBe(1);
    }
    await migrate.db.connection().execute(async (conn) => {
      const failure = await applyRecordActionsMigration(conn, [])
        .then(() => undefined, (caught: unknown) => caught as Error);
      expect(failure?.message).toContain(`${indirectRole} is a member of it`);
    });
  } finally {
    await server.unsafe(`revoke ${migrateRole} from ${indirectRole}`);
  }
  await migrate.db.connection().execute((conn) => verifyDatabaseRoles(conn));
}, TEST_TIMEOUT);

/**
 * ADMIN OPTION alone is a path: the member grants the role to ITSELF with
 * INHERIT and SET and is then the definer role. So the walk does not look at
 * what an edge carries — any edge on the way to a definer role is refused.
 */
test("a membership carrying only ADMIN OPTION is a path and is refused", async () => {
  await server.unsafe(
    `grant ${RESOLVER_ROLE} to ${indirectRole} with admin option, inherit false, set false`,
  );
  try {
    const error = await migrate.db.connection()
      .execute((conn) => verifyDatabaseRoles(conn))
      .then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain(
      `role ${indirectRole} is a member of definer role ${RESOLVER_ROLE}`,
    );
    expect(error?.message).toContain(`revoke ${RESOLVER_ROLE} from ${indirectRole};`);
    // Why it is refused rather than classified as inert.
    const attacker = createDatabaseRuntime({
      databaseUrl: url(scratch, { username: indirectRole, password: MIGRATE_PASSWORD }),
      maxConnections: 1,
    });
    try {
      await attacker.db.connection().execute(async (conn) => {
        await sql.raw(
          `grant ${RESOLVER_ROLE} to ${indirectRole} with inherit true, set true`,
        ).execute(conn);
        await sql.raw(`set role ${RESOLVER_ROLE}`).execute(conn);
        expect((await sql<{ user: string }>`select current_user as "user"`.execute(conn))
          .rows[0]?.user).toBe(RESOLVER_ROLE);
      });
    } finally {
      await attacker.close();
    }
  } finally {
    // Two grants now exist: the administrator's and the one the attacker made
    // itself. A revoke only removes the caller's own, so both are named.
    await server.unsafe(
      `revoke ${RESOLVER_ROLE} from ${indirectRole} granted by ${indirectRole}`,
    );
    await server.unsafe(`revoke ${RESOLVER_ROLE} from ${indirectRole}`);
  }
  await migrate.db.connection().execute((conn) => verifyDatabaseRoles(conn));
}, TEST_TIMEOUT);

/**
 * THE SUPPORTED TOPOLOGY, and what it costs.
 *
 * Roles are cluster-wide: the definer roles are named once in the manifest
 * and shared by every OpenShapeForge database on the cluster. "This
 * database's owner" is not — so two OpenShapeForge databases with DIFFERENT
 * owners each refuse the other's owner, and that is the policy rather than an
 * oversight: admitting any database owner would admit whoever a CREATEDB role
 * made one. A deployment that puts two of them on one cluster gives them one
 * owner and one migrate identity, or one cluster each. The refusal says so,
 * so it is not mistaken for a broken grant.
 */
test("two databases with different owners on one cluster must share one owner", async () => {
  await server.unsafe(`grant ${RESOLVER_ROLE} to ${ownerRole} with inherit true, set true`);
  try {
    // Legitimate where ownerRole owns the database.
    await migrateOnOwnedDatabase.db.connection().execute((conn) => verifyDatabaseRoles(conn));
    // Refused on the sibling database, with the topology spelled out.
    const error = await migrate.db.connection()
      .execute((conn) => verifyDatabaseRoles(conn))
      .then(() => undefined, (caught: unknown) => caught as Error);
    expect(error?.message).toContain(
      `role ${ownerRole} is a member of definer role ${RESOLVER_ROLE}`,
    );
    expect(error?.message).toContain(`${ownerRole} owns another database on this cluster`);
    expect(error?.message).toContain(
      "every OpenShapeForge database sharing a cluster must share one owner and one migrate " +
        "identity, or be given its own cluster",
    );
    expect(error?.message).toContain(`revoke ${RESOLVER_ROLE} from ${ownerRole};`);
  } finally {
    await server.unsafe(`revoke ${RESOLVER_ROLE} from ${ownerRole}`);
  }
}, TEST_TIMEOUT);

/**
 * The baseline the walk must not break: the deployment shape the host
 * provisions, plus memberships that exist but do not reach a definer role.
 * Both databases pass, and the record-action step installs.
 */
test("the provisioned shape and unrelated memberships pass on both databases", async () => {
  // A group with no definer membership, and a role in it. Nothing on the way
  // to a definer role, so nothing to report.
  await server.unsafe(`grant ${helperRole} to ${indirectRole} with inherit true, set true`);
  try {
    for (const runtime of [migrate, migrateOnOwnedDatabase, superuser]) {
      await runtime.db.connection().execute((conn) => verifyDatabaseRoles(conn));
    }
    for (const runtime of [migrate, migrateOnOwnedDatabase]) {
      await runtime.db.connection().execute(async (conn) => {
        await applyRecordActionsMigration(conn, []);
        expect((await sql<{ allowed: boolean }>`
          select app.record_action_allows('Nothing', 'nokey', 'start') as allowed
        `.execute(conn)).rows[0]?.allowed).toBe(false);
      });
    }
  } finally {
    await server.unsafe(`revoke ${helperRole} from ${indirectRole}`);
  }
}, TEST_TIMEOUT);
