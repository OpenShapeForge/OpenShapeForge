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
    expect(databaseRole("recordActionResolver")).toMatchObject({ login: false, migratorMember: true });
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
   * is each definer member's standing in each of them — superuser, a role the
   * connected migrate identity inherits, or a holder of that database's owner
   * privileges — and not the owners being distinct. The three configurations
   * below are the ones the comment in database-roles.ts and the section in
   * docs/migrations.md claim: distinct owners with distinct migrate identities
   * refuse symmetrically, distinct owners under one migrate identity pass, and
   * a second migrate identity is accepted by the database whose owner
   * privileges it holds while the other still refuses it.
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
      // sees the other's migrator as a member it can account for neither as
      // its own migrate identity nor as a holder of its owner's privileges.
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

      // Two migrate identities do coexist where each holds the owner
      // privileges of every database involved: granted the second database's
      // owner, the second migrator is accounted for there — while the FIRST
      // database still refuses it, because it holds none of ITS owner's
      // privileges. Owner privileges per database, not one owner for all.
      await admin.unsafe(`grant ${secondOwner} to ${secondMigrator}`);
      for (const definer of definers) {
        await admin.unsafe(`grant ${definer} to ${secondMigrator} with inherit true, set true`);
      }
      second = createDatabaseRuntime({
        databaseUrl: url(secondMigrator, secondPassword, secondDatabase),
        maxConnections: 1,
      });
      await second.db.connection().execute((db) => verifyDatabaseRoles(db));
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
    const cases: Array<{ apply: string; undo: string; expected: string }> = [
      { apply: `alter role ${definer} createrole`, undo: `alter role ${definer} nocreaterole`,
        expected: `role ${definer} must not have CREATEROLE` },
      { apply: `alter role ${definer} createdb`, undo: `alter role ${definer} nocreatedb`,
        expected: `role ${definer} must not have CREATEDB` },
      { apply: `alter role ${definer} replication`, undo: `alter role ${definer} noreplication`,
        expected: `role ${definer} must not have REPLICATION` },
      { apply: `alter role ${definer} inherit`, undo: `alter role ${definer} noinherit`,
        expected: `definer role ${definer} must be NOINHERIT` },
      { apply: `create role ${parent} nologin; grant ${parent} to ${definer}`,
        undo: `revoke ${parent} from ${definer}; drop role ${parent}`,
        expected: `definer role ${definer} must not be a member of ${parent}` },
    ];
    for (const scenario of cases) {
      await admin.unsafe(scenario.apply);
      try {
        const error = await migrator.db.connection().execute((db) => verifyDatabaseRoles(db)).then(
          () => undefined,
          (caught: unknown) => caught as Error,
        );
        expect(error?.message).toContain(scenario.expected);
      } finally {
        await admin.unsafe(scenario.undo);
      }
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
