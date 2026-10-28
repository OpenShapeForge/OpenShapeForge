// SPDX-License-Identifier: BUSL-1.1
/**
 * The database role contract on the boundary a managed instance enforces:
 * the migrate role has neither SUPERUSER nor CREATEROLE. The chain must
 * refuse with the complete administrator remedy when the contract is not
 * met, and run to completion once the host has provisioned the roles.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import {
  DATABASE_ROLES,
  databaseRole,
  provisionDatabaseRoles,
  renderProvisioningSql,
  verifyDatabaseRoles,
  type DatabaseRoleContract,
} from "../database-roles.js";
import { runMigrationChain } from "../migration-chain.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const migratorRole = `osf_contract_migrator_${suffix}`;
const scratchDatabase = `role_contract_${suffix}`;
const migratorPassword = `contract-${suffix}`;
const TEST_TIMEOUT = 120_000;

let admin: SQL;
let adminRuntime: DatabaseRuntime;
let migrator: DatabaseRuntime;

function url(user: string, password: string, database = scratchDatabase): string {
  const next = new URL(ADMIN_URL);
  next.username = user;
  next.password = password;
  next.pathname = `/${database}`;
  return next.toString();
}

beforeAll(async () => {
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`
    create role ${migratorRole} login password '${migratorPassword}'
      nosuperuser nocreaterole nocreatedb nobypassrls;
  `);
  await admin.unsafe(`create database ${scratchDatabase} owner ${migratorRole}`);
  adminRuntime = createDatabaseRuntime({ databaseUrl: url(new URL(ADMIN_URL).username, new URL(ADMIN_URL).password), maxConnections: 1 });
  migrator = createDatabaseRuntime({ databaseUrl: url(migratorRole, migratorPassword), maxConnections: 1 });
}, TEST_TIMEOUT);

afterAll(async () => {
  await migrator?.close();
  await adminRuntime?.close();
  // Membership is cluster-wide; leave the shared roles as they were.
  await admin?.unsafe(`drop database if exists ${scratchDatabase} with (force)`);
  await admin?.unsafe(`drop role if exists ${migratorRole}`);
  await admin?.close();
});

describe("database role contract", () => {
  test("the manifest declares the app, worker and definer roles", () => {
    expect(DATABASE_ROLES.map((role) => role.key).sort()).toEqual([
      "app",
      "blueprintReader",
      "identityResolver",
      "recordActionResolver",
      "worker",
    ]);
    expect(databaseRole("blueprintReader")).toMatchObject({ login: false, migratorMember: true });
    expect(databaseRole("identityResolver")).toMatchObject({ login: false, migratorMember: true });
    // The record-action lookup's definer. Like the other two it never logs in,
    // and the migrate role must be a member to hand it the function.
    expect(databaseRole("recordActionResolver")).toMatchObject({
      login: false, migratorMember: true,
    });
    const rendered = renderProvisioningSql({ migratorRole: "some_migrator" });
    expect(rendered).toContain("create role openshapeforge_blueprint_reader nologin");
    expect(rendered).toContain(
      "grant openshapeforge_blueprint_reader to some_migrator with inherit true, set true;",
    );
    expect(rendered).not.toMatch(/password '(?!<set-by-operator>)/);
  });

  test("a restricted migrator is refused before any schema exists, with the remedy", async () => {
    const error = await migrator.db.connection().execute((db) => runMigrationChain(db)).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain("Database role contract is not satisfied");
    expect(error?.message).toContain(`migrate role ${migratorRole} is not a member of openshapeforge_blueprint_reader`);
    expect(error?.message).toContain(
      `grant openshapeforge_blueprint_reader to ${migratorRole} with inherit true, set true;`,
    );
    const schemas = await migrator.db.connection().execute((db) =>
      sql<{ n: number }>`select count(*)::int as n from pg_namespace where nspname in ('app', 'platform')`.execute(db),
    );
    expect(schemas.rows[0]?.n).toBe(0);
  }, TEST_TIMEOUT);

  test("after the host provisions the roles the restricted migrator runs the whole chain", async () => {
    const provisioned = await adminRuntime.db.connection().execute((db) =>
      provisionDatabaseRoles(db, {
        passwords: { app: "openshapeforge_app", worker: "openshapeforge_worker" },
        migratorRole,
      }),
    );
    expect(provisioned.granted).toContain(`openshapeforge_blueprint_reader -> ${migratorRole}`);
    await migrator.db.connection().execute((db) => verifyDatabaseRoles(db));
    const result = await migrator.db.connection().execute((db) => runMigrationChain(db));
    expect(result.pageConfigs).toBeDefined();
    const owner = await migrator.db.connection().execute((db) =>
      sql<{ owner: string; create: boolean }>`
        select proowner::regrole::text as owner,
          has_schema_privilege('openshapeforge_blueprint_reader', 'app', 'CREATE') as "create"
        from pg_proc where proname = 'read_blueprints'
      `.execute(db),
    );
    expect(owner.rows[0]).toEqual({ owner: "openshapeforge_blueprint_reader", create: false });
    // Provisioning again changes nothing.
    const again = await adminRuntime.db.connection().execute((db) =>
      provisionDatabaseRoles(db, { passwords: {}, migratorRole }),
    );
    expect(again.created).toEqual([]);
    expect(again.rotated).toEqual([]);
    expect(again.granted).toEqual([]);
  }, TEST_TIMEOUT);

  /**
   * The definer roles own SECURITY DEFINER functions and hold the narrow
   * grants those functions need, and RLS resolves a policy's `TO` list with
   * has_privs_of_role — so every member of a definer role inherits both. A
   * second member is therefore a second holder of the record-action resolver's
   * `update (<acl column>)`: before the fence's exemption became the table
   * owner's privileges, that member could rewrite its own tenant's ACL
   * document (verified on PostgreSQL 17.11). The contract is that it does not
   * exist, and the chain refuses with the revoke that fixes it.
   */
  test("an extra member of a definer role fails the contract with the revoke that fixes it", async () => {
    const intruder = `osf_contract_intruder_${suffix}`;
    const definer = databaseRole("recordActionResolver").name;
    await admin.unsafe(`create role ${intruder} nologin nosuperuser nobypassrls`);
    try {
      await admin.unsafe(`grant ${definer} to ${intruder}`);
      const error = await migrator.db.connection().execute((db) => verifyDatabaseRoles(db)).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
      expect(error?.message).toContain("Database role contract is not satisfied");
      expect(error?.message).toContain(
        `role ${intruder} is a member of definer role ${definer}`,
      );
      expect(error?.message).toContain(`revoke ${definer} from ${intruder};`);
      // The migrate role itself is a member and must NOT be reported: it is
      // the identity that hands the objects over.
      expect(error?.message).not.toContain(`revoke ${definer} from ${migratorRole};`);
      // And the whole chain refuses rather than running on past it.
      await expect(
        migrator.db.connection().execute((db) => runMigrationChain(db)),
      ).rejects.toThrow(`role ${intruder} is a member of definer role ${definer}`);
    } finally {
      await admin.unsafe(`revoke ${definer} from ${intruder}`).catch(() => undefined);
      await admin.unsafe(`drop role if exists ${intruder}`);
    }
    // Revoked, the contract holds again.
    await migrator.db.connection().execute((db) => verifyDatabaseRoles(db));
  }, TEST_TIMEOUT);

  /**
   * TWO OpenShapeForge DATABASES IN ONE CLUSTER
   *
   * The definer roles' member list is cluster-wide, but both things a member
   * is measured against are per database: the migrate identity the check runs
   * as, and `datdba`. So what decides whether step 0 passes in BOTH databases
   * is each definer member's standing in each of them — a superuser, or the
   * role that IS that database's migrate identity or owner, both by name —
   * and not the owners being distinct. The three configurations below are the
   * ones the comment in database-roles.ts and the section in
   * docs/migrations.md claim: distinct owners with distinct migrate identities
   * refuse symmetrically, distinct owners under ONE migrate identity pass, and
   * a second migrate identity is refused even in the database whose owner's
   * privileges it has been granted — because holding an owner's privileges is
   * not being that owner.
   *
   * What they do NOT cover: two migrate identities that each ARE the other
   * database's owner by name. The predicate admits both members in both
   * databases there, so the refusal below is a refusal of this topology and
   * not of two migrate identities as such. No test provisions that one.
   */
  test("a second migrate identity is refused in both databases; a second owner is not", async () => {
    const secondDatabase = `role_contract_second_${suffix}`;
    const secondMigrator = `osf_contract_migrator2_${suffix}`;
    const secondOwner = `osf_contract_owner2_${suffix}`;
    const secondPassword = `second-${suffix}`;
    const definers = DATABASE_ROLES.filter((role) => !role.login).map((role) => role.name);
    let second: DatabaseRuntime | undefined;
    try {
      await admin.unsafe(`
        create role ${secondMigrator} login password '${secondPassword}'
          nosuperuser nocreaterole nocreatedb nobypassrls;
        create role ${secondOwner} nologin nosuperuser nocreaterole nocreatedb nobypassrls;
        grant ${secondOwner} to ${migratorRole};
      `);
      await admin.unsafe(`create database ${secondDatabase} owner ${secondMigrator}`);
      // Each database owned by, and migrated as, its own non-superuser role.
      // Both migrators must be members of the definer roles, so each database
      // sees the other's migrator as a member that is neither the identity it
      // is connected as nor its own `datdba` — the two names it admits.
      const provisioned = await adminRuntime.db.connection().execute((db) =>
        provisionDatabaseRoles(db, { passwords: {}, migratorRole: secondMigrator }),
      );
      expect(provisioned.granted.sort()).toEqual(
        definers.map((definer) => `${definer} -> ${secondMigrator}`).sort(),
      );
      second = createDatabaseRuntime({
        databaseUrl: url(secondMigrator, secondPassword, secondDatabase),
        maxConnections: 1,
      });
      const refuse = (runtime: DatabaseRuntime): Promise<Error | undefined> =>
        runtime.db.connection().execute((db) => verifyDatabaseRoles(db)).then(
          () => undefined,
          (caught: unknown) => caught as Error,
        );
      const [here, there] = [await refuse(migrator), await refuse(second)];
      for (const definer of definers) {
        expect(here?.message).toContain(
          `role ${secondMigrator} is a member of definer role ${definer}`,
        );
        expect(here?.message).toContain(`revoke ${definer} from ${secondMigrator};`);
        expect(there?.message).toContain(
          `role ${migratorRole} is a member of definer role ${definer}`,
        );
        // Symmetric, so the remedy either error names breaks the other database.
        expect(there?.message).toContain(`revoke ${definer} from ${migratorRole};`);
      }

      // Hand the second database to a distinct OWNER and migrate it as the
      // first database's identity: the member list is back to one role, and
      // both databases satisfy the contract with owners that differ.
      await second.close();
      second = undefined;
      for (const definer of definers) {
        await admin.unsafe(`revoke ${definer} from ${secondMigrator}`);
      }
      await admin.unsafe(`alter database ${secondDatabase} owner to ${secondOwner}`);
      const shared = createDatabaseRuntime({
        databaseUrl: url(migratorRole, migratorPassword, secondDatabase),
        maxConnections: 1,
      });
      try {
        await shared.db.connection().execute((db) => verifyDatabaseRoles(db));
        const owners = await shared.db.connection().execute((db) =>
          sql<{ second: string; first: string }>`
            select (select datdba::regrole::text from pg_database
                      where datname = current_database()) as second,
              (select datdba::regrole::text from pg_database
                 where datname = ${scratchDatabase}) as first
          `.execute(db),
        );
        expect(owners.rows[0]).toEqual({ second: secondOwner, first: migratorRole });
      } finally {
        await shared.close();
      }
      await migrator.db.connection().execute((db) => verifyDatabaseRoles(db));

      // Two migrate identities do NOT coexist by each holding the owner
      // privileges of its own database. Admittance is the owner's IDENTITY,
      // not its privileges: a role that merely holds them would, as a definer
      // member, gain ownership of the SECURITY DEFINER functions those
      // privileges alone do not confer. So granting the second database's
      // owner to the second migrator accounts for neither migrator in the
      // other's database, and both refuse — symmetrically, as above.
      await admin.unsafe(`grant ${secondOwner} to ${secondMigrator}`);
      for (const definer of definers) {
        await admin.unsafe(`grant ${definer} to ${secondMigrator} with inherit true, set true`);
      }
      second = createDatabaseRuntime({
        databaseUrl: url(secondMigrator, secondPassword, secondDatabase),
        maxConnections: 1,
      });
      // `migratorRole` holds secondOwner's privileges too, by the grant in
      // this test's setup, and is still refused in the database secondOwner
      // owns. Holding them is not being it.
      expect((await refuse(second))?.message).toContain(
        `role ${migratorRole} is a member of definer role ${definers[0]}`,
      );
      expect((await refuse(migrator))?.message).toContain(
        `role ${secondMigrator} is a member of definer role ${definers[0]}`,
      );
    } finally {
      await second?.close();
      for (const definer of definers) {
        await admin.unsafe(`revoke ${definer} from ${secondMigrator}`).catch(() => undefined);
      }
      await admin.unsafe(`drop database if exists ${secondDatabase} with (force)`);
      await admin.unsafe(`revoke ${secondOwner} from ${migratorRole}`).catch(() => undefined);
      await admin.unsafe(`drop role if exists ${secondMigrator}`);
      await admin.unsafe(`drop role if exists ${secondOwner}`);
    }
  }, TEST_TIMEOUT);

  /**
   * Attributes no policy can compensate for. BYPASSRLS and SUPERUSER are
   * outside row security; CREATEROLE, CREATEDB and REPLICATION let a role
   * widen its own reach without an administrator; and a definer role that
   * INHERITS another role runs its SECURITY DEFINER bodies with whatever that
   * role holds.
   */
  test("an unsafe attribute or an inherited role fails the contract", async () => {
    const definer = databaseRole("recordActionResolver").name;
    const parent = `osf_contract_parent_${suffix}`;
    const cases: Array<{ apply: string; undo: string; expected: string; remedy?: string }> = [
      { apply: `alter role ${definer} createrole`, undo: `alter role ${definer} nocreaterole`,
        expected: `role ${definer} must not have CREATEROLE`,
        remedy: `alter role ${definer} nocreaterole;` },
      { apply: `alter role ${definer} createdb`, undo: `alter role ${definer} nocreatedb`,
        expected: `role ${definer} must not have CREATEDB`,
        remedy: `alter role ${definer} nocreatedb;` },
      { apply: `alter role ${definer} replication`, undo: `alter role ${definer} noreplication`,
        expected: `role ${definer} must not have REPLICATION`,
        remedy: `alter role ${definer} noreplication;` },
      { apply: `alter role ${definer} inherit`, undo: `alter role ${definer} noinherit`,
        expected: `definer role ${definer} must be NOINHERIT`,
        remedy: `alter role ${definer} noinherit;` },
      { apply: `create role ${parent} nologin; grant ${parent} to ${definer}`,
        undo: `revoke ${parent} from ${definer}; drop role ${parent}`,
        expected: `definer role ${definer} must not be a member of ${parent}`,
        remedy: `revoke ${parent} from ${definer};` },
    ];
    for (const scenario of cases) {
      await admin.unsafe(scenario.apply);
      try {
        const error = await migrator.db.connection().execute((db) => verifyDatabaseRoles(db)).then(
          () => undefined,
          (caught: unknown) => caught as Error,
        );
        expect(error?.message).toContain(scenario.expected);
        if (scenario.remedy) expect(error?.message).toContain(scenario.remedy);
      } finally {
        await admin.unsafe(scenario.undo);
      }
    }
    await migrator.db.connection().execute((db) => verifyDatabaseRoles(db));
  }, TEST_TIMEOUT);

  /**
   * THE ATTRIBUTE REMEDY, APPLIED.
   *
   * `renderProvisioningSql` only creates roles that do not exist, so a role an
   * operator already created with an unsafe attribute keeps it: the refusal
   * named the problem and the provisioning script was not the fix for it. The
   * refusal now carries one `alter role` per deviating role, listing only the
   * attributes that role must not keep — and this test runs exactly the
   * printed statement and shows the contract then holds.
   *
   * It runs against a SCRATCH role of its own rather than a declared one, by
   * substituting the contract list the way the self-grant test below does.
   * Making `openshapeforge_record_action_resolver` a cluster superuser to
   * assert a sentence about it is not worth the window in which it is one,
   * however short; a `nologin` role with no password and no membership that
   * this test creates and drops is.
   */
  test("the printed alter role repairs exactly the deviating role and nothing else", async () => {
    const unsafeRole = `osf_contract_unsafe_${suffix}`;
    const loginRole = `osf_contract_login_${suffix}`;
    const loginPassword = `login-${suffix}`;
    const contracts = DATABASE_ROLES as DatabaseRoleContract[];
    const originalContracts = [...contracts];
    const declared = originalContracts.map((role) => role.name);
    /** Every attribute the contract reads, for the roles this test must not change. */
    const attributesOf = async (names: readonly string[]) =>
      (await admin.unsafe(
        `select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
                rolcanlogin, rolinherit
           from pg_roles where rolname = any(string_to_array($1, ',')) order by rolname`,
        [names.join(",")],
      )) as Array<Record<string, unknown>>;
    try {
      // Every unsafe attribute at once on a role that cannot log in, so the one
      // statement has to carry all of them.
      await admin.unsafe(`
        create role ${unsafeRole} nologin superuser bypassrls createrole createdb
          replication inherit;
      `);
      contracts.splice(0, contracts.length, {
        key: "recordActionResolver",
        name: unsafeRole,
        login: false,
        migratorMember: false,
        purpose: "exercise the printed attribute remedy",
      });
      const before = await attributesOf(declared);

      const expectedAlter =
        `alter role ${unsafeRole} nosuperuser nobypassrls nocreaterole nocreatedb ` +
        "noreplication noinherit;";
      const error = await migrator.db.connection().execute((db) => verifyDatabaseRoles(db)).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
      expect(error?.message).toContain(`role ${unsafeRole} must not be SUPERUSER`);
      expect(error?.message).toContain(expectedAlter);
      // One statement, not one per attribute, and no other role is altered.
      expect((error?.message ?? "").split(`alter role ${unsafeRole}`).length - 1).toBe(1);
      expect((error?.message ?? "").match(/^alter role /gm)).toHaveLength(1);
      // And the refusal says which connection that statement needs.
      expect(error?.message).toContain(
        "changing SUPERUSER, REPLICATION or BYPASSRLS needs a SUPERUSER connection",
      );

      // The provisioning script is NOT the remedy: the role exists, so it is
      // left alone and the contract fails on the same attributes again.
      const provisioned = await adminRuntime.db.connection().execute((db) =>
        provisionDatabaseRoles(db, { passwords: {} }),
      );
      expect(provisioned).toMatchObject({ created: [], granted: [], unchanged: [unsafeRole] });
      expect(renderProvisioningSql()).not.toContain("alter role");
      await expect(
        migrator.db.connection().execute((db) => verifyDatabaseRoles(db)),
      ).rejects.toThrow(`role ${unsafeRole} must not be SUPERUSER`);

      // Run the printed statement verbatim, as the administrator it names.
      await admin.unsafe(expectedAlter);
      await migrator.db.connection().execute((db) => verifyDatabaseRoles(db));
      // A compliant role is not told to alter anything.
      await admin.unsafe(`alter role ${unsafeRole} createdb`);
      const again = await migrator.db.connection().execute((db) => verifyDatabaseRoles(db)).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
      // Only the attribute that is actually wrong, and no superuser caveat for it.
      expect(again?.message).toContain(`alter role ${unsafeRole} nocreatedb;`);
      expect(again?.message).not.toContain("needs a SUPERUSER connection");
      await admin.unsafe(`alter role ${unsafeRole} nocreatedb`);
      await migrator.db.connection().execute((db) => verifyDatabaseRoles(db));
      // The declared roles this test replaced are untouched by all of it.
      expect(await attributesOf(declared)).toEqual(before);

      // The login flag is part of the same statement, and carries no password:
      // a role that must stop logging in keeps the secret the host gave it.
      await admin.unsafe(
        `create role ${loginRole} login password '${loginPassword}' nosuperuser nobypassrls
           nocreaterole nocreatedb noreplication noinherit`,
      );
      contracts.splice(0, contracts.length, {
        key: "recordActionResolver",
        name: loginRole,
        login: false,
        migratorMember: false,
        purpose: "exercise the printed login remedy",
      });
      const loginError = await migrator.db.connection().execute((db) => verifyDatabaseRoles(db))
        .then(() => undefined, (caught: unknown) => caught as Error);
      expect(loginError?.message).toContain(`role ${loginRole} must not be able to log in`);
      expect(loginError?.message).toContain(`alter role ${loginRole} nologin;`);
      expect(loginError?.message).not.toContain("password");
      await admin.unsafe(`alter role ${loginRole} nologin;`);
      await migrator.db.connection().execute((db) => verifyDatabaseRoles(db));
      const secret = (await admin.unsafe(
        `select rolpassword is not null as kept from pg_authid where rolname = $1`,
        [loginRole],
      )) as Array<{ kept: boolean }>;
      expect(secret[0]?.kept).toBe(true);
    } finally {
      contracts.splice(0, contracts.length, ...originalContracts);
      await admin.unsafe(`drop role if exists ${unsafeRole}`);
      await admin.unsafe(`drop role if exists ${loginRole}`);
    }
    await migrator.db.connection().execute((db) => verifyDatabaseRoles(db));
  }, TEST_TIMEOUT);

  test("explicit password rotation uses the administrator connection", async () => {
    const rotatedAppPassword = `app-${suffix}`;
    const rotatedWorkerPassword = `worker-${suffix}`;
    try {
      const rotated = await adminRuntime.db.connection().execute((db) =>
        provisionDatabaseRoles(db, {
          passwords: { app: rotatedAppPassword, worker: rotatedWorkerPassword },
          rotatePasswords: { app: true, worker: true },
          migratorRole,
        }),
      );
      expect(rotated.rotated.sort()).toEqual([
        databaseRole("app").name,
        databaseRole("worker").name,
      ].sort());

      for (const [role, password] of [
        [databaseRole("app").name, rotatedAppPassword],
        [databaseRole("worker").name, rotatedWorkerPassword],
      ] as const) {
        const connection = new SQL(url(role, password), { max: 1 });
        try {
          expect((await connection`select current_user as "user"`)[0]?.user).toBe(role);
        } finally {
          await connection.close();
        }
      }
    } finally {
      await adminRuntime.db.connection().execute((db) =>
        provisionDatabaseRoles(db, {
          passwords: { app: "openshapeforge_app", worker: "openshapeforge_worker" },
          rotatePasswords: { app: true, worker: true },
          migratorRole,
        }),
      );
    }
  }, TEST_TIMEOUT);

  test("repairs a PostgreSQL 16+ CREATEROLE self-grant into usable membership", async () => {
    const creatorRole = `osf_contract_creator_${suffix}`;
    const childRole = `osf_contract_child_${suffix}`;
    const creatorPassword = `creator-${suffix}`;
    const contracts = DATABASE_ROLES as DatabaseRoleContract[];
    const originalContracts = [...contracts];
    let creator: DatabaseRuntime | undefined;
    try {
      await admin.unsafe(`
        create role ${creatorRole} login password '${creatorPassword}'
          createrole noinherit nosuperuser nocreatedb nobypassrls;
      `);
      creator = createDatabaseRuntime({
        databaseUrl: url(creatorRole, creatorPassword),
        maxConnections: 1,
      });
      await creator.db.connection().execute((db) =>
        sql`set createrole_self_grant = 'inherit'`.execute(db),
      );
      contracts.splice(0, contracts.length, {
        key: "blueprintReader",
        name: childRole,
        login: false,
        migratorMember: true,
        purpose: "exercise PostgreSQL CREATEROLE self-grant semantics",
      });

      const provisioned = await creator.db.connection().execute((db) =>
        provisionDatabaseRoles(db, { passwords: {}, migratorRole: creatorRole }),
      );
      expect(provisioned.created).toEqual([childRole]);
      expect(provisioned.granted).toEqual([`${childRole} -> ${creatorRole}`]);
      await creator.db.connection().execute((db) => verifyDatabaseRoles(db));
      const capabilities = await creator.db.connection().execute((db) =>
        sql<{ usage: boolean; canSet: boolean }>`
          select pg_has_role(current_user, ${childRole}, 'USAGE') as usage,
            pg_has_role(current_user, ${childRole}, 'SET') as "canSet"
        `.execute(db),
      );
      expect(capabilities.rows[0]).toEqual({ usage: true, canSet: true });
    } finally {
      contracts.splice(0, contracts.length, ...originalContracts);
      await creator?.close();
      await admin.unsafe(`drop role if exists ${childRole}`);
      await admin.unsafe(`drop role if exists ${creatorRole}`);
    }
  }, TEST_TIMEOUT);
});
