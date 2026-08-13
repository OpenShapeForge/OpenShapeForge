// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import manifest from "../../generated/db/manifest.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../connection.js";

/**
 * Provisions the second restricted runtime role, `openshapeforge_worker`, and
 * grants it exactly the tables a background worker touches — no more.
 *
 * WHY THIS EXISTS
 * ---------------
 * A queue table declaring `workerAccess` emits a policy disjunct that admits a
 * worker across every tenant. Until #223 the only thing that disjunct compared
 * was `app.current_worker_role()`, which reads the `app.worker_role` GUC — and
 * anything holding a connection can set a GUC. The API process and the worker
 * process connected as the SAME `openshapeforge_app` role, so PostgreSQL could
 * not tell them apart: anything that reached SQL execution through the API
 * could widen its own session to every tenant's command queue, schedules and
 * fire ledger by naming the role. The policy could not be read as an
 * authorization statement on its own.
 *
 * The emitted disjunct now leads with `current_user = 'openshapeforge_worker'`,
 * which is a fact about the CONNECTION rather than about the session's
 * variables. This module is what makes that role exist, and — just as
 * importantly — what makes sure the app role can never become it: no
 * membership is ever granted, so `SET ROLE openshapeforge_worker` from the app
 * role is refused by PostgreSQL. That refusal is the property being bought, so
 * `GRANT openshapeforge_worker TO openshapeforge_app` must never be added here
 * as a convenience.
 *
 * THE ROLE NAME IS NOT REPEATED
 * -----------------------------
 * It is read from the generated manifest, which the compiler wrote from the
 * same constant it interpolated into every policy. A role the policies name but
 * nothing creates, or a role created under a name no policy compares against,
 * both fail silently — the queue simply reads as empty — so the two cannot be
 * allowed to drift.
 *
 * WHY NOT THE APP ROLE'S GRANTS
 * -----------------------------
 * `applyAppRoleGrants` sweeps DML over every table in every managed schema, so
 * a new entity is covered without a bespoke migration. That is right for a role
 * that fronts a GraphQL surface over the whole model and wrong for a poll loop:
 * a worker that drains a queue has no business reading `platform.connector_secrets`
 * or `platform.api_keys`, neither of which carries a tenant predicate to stop
 * it. So the worker's grants are enumerated from the manifest instead
 * ({@link workerGrantedTables}), and a table that never says a worker needs it
 * is never granted.
 *
 * NO DEFAULT PRIVILEGES, deliberately. `ALTER DEFAULT PRIVILEGES` is what makes
 * the app role's sweep future-proof; giving the worker the same would auto-grant
 * it every table generated from that day on, which is precisely the sweep this
 * module exists to avoid. New tables reach the worker by declaring `workerDml`
 * and being picked up by the next migrate, which re-runs the enumeration.
 *
 * PASSWORD OWNERSHIP
 * ------------------
 * Identical contract to the app role's: operator-owned, read from
 * OPENSHAPEFORGE_WORKER_PASSWORD, applied only at role creation, rotated only
 * when OPENSHAPEFORGE_WORKER_PASSWORD_ROTATE=1 is set for a single migrate run.
 * It must stay consistent with the password in
 * OPENSHAPEFORGE_WORKER_DATABASE_URL.
 */

/** The restricted worker runtime role, as the emitted policies name it. */
export const WORKER_ROLE: string = manifest.workerDatabaseRole;

/**
 * The local-dev-only default password for {@link WORKER_ROLE}. It matches the
 * OPENSHAPEFORGE_WORKER_DATABASE_URL in apps/api/.env.example and the scratch
 * tests so local work is frictionless. It is NEVER accepted in production —
 * {@link readWorkerRolePassword} fails closed there.
 */
export const DEV_WORKER_ROLE_PASSWORD_DEFAULT = "openshapeforge_worker";

/**
 * Resolve the password to provision {@link WORKER_ROLE} with. Operator-owned:
 * it must match the password embedded in OPENSHAPEFORGE_WORKER_DATABASE_URL.
 *
 * Fails closed in production exactly as `readAppRolePassword` does. The dev
 * default is never silently used there, so the worker's credential can never
 * collapse to a source-published constant equal to the role name.
 */
export function readWorkerRolePassword(env: NodeJS.ProcessEnv = process.env): string {
  const password = env.OPENSHAPEFORGE_WORKER_PASSWORD;

  if (env.NODE_ENV === "production") {
    if (!password) {
      throw new Error(
        "OPENSHAPEFORGE_WORKER_PASSWORD is required in production. It provisions the " +
          "restricted worker role whose identity the queue policies check, and must match " +
          "the password in OPENSHAPEFORGE_WORKER_DATABASE_URL. Set a strong, randomized " +
          "secret (never the dev default), distinct from OPENSHAPEFORGE_APP_PASSWORD.",
      );
    }
    if (password === DEV_WORKER_ROLE_PASSWORD_DEFAULT) {
      throw new Error(
        "OPENSHAPEFORGE_WORKER_PASSWORD is still the public dev default " +
          `('${DEV_WORKER_ROLE_PASSWORD_DEFAULT}'). This is a known, source-published ` +
          "credential for the role the queue policies trust. Set a strong, randomized secret.",
      );
    }
    return password;
  }

  return password || DEV_WORKER_ROLE_PASSWORD_DEFAULT;
}

/**
 * Whether this migrate run should ROTATE the existing worker role's password.
 * Off by default, for the reason the app role's flag is off by default: the
 * password is set only at role creation, so an operator-chosen credential is
 * never clobbered by a routine `helm upgrade`.
 */
function shouldRotateWorkerRolePassword(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.OPENSHAPEFORGE_WORKER_PASSWORD_ROTATE;
  return flag === "1" || flag === "true";
}

type ManifestWorkerTable = {
  schema: string;
  table: string;
  workerAccess?: string;
  workerDml?: boolean;
  generatedCrudEligible?: boolean;
  generatedCrud: boolean;
};

const manifestTables = manifest.tables as unknown as ManifestWorkerTable[];

/**
 * Whether the manifest describes a deployment that HAS workers at all.
 *
 * A `workerAccess` declaration is what says "some worker drains a queue here".
 * With none, no module contributes a worker, nothing will ever connect as the
 * worker role, and the correct grant is nothing — the role still exists (it is
 * cluster-wide and cheap) but holds no table. Fail-closed: a deployment that
 * removes its last worker plugin does not leave a credentialed role behind with
 * standing access to the model.
 */
const hasWorkers = manifestTables.some((table) => table.workerAccess !== undefined);

/**
 * The exact tables a worker is granted DML on, qualified and sorted so the DDL
 * order is deterministic.
 *
 * Three sources, and each is a different statement about the table:
 *
 *   - `workerAccess` — the queue a worker claims ACROSS tenants. Its policy
 *     already names the worker; withholding the grant would emit a policy for a
 *     role that cannot reach the table.
 *   - `workerDml` — everything a worker touches inside a session scoped to one
 *     tenant: its run tables, its node catalog, its trigger registry.
 *   - generated-CRUD eligibility — the business entities. Derived rather than declared
 *     because the compiler emits an `entity.<slug>.<action>` workflow node for
 *     every generated entity, so any workflow may perform CRUD against any of
 *     them; asking each entity's author to name a worker they have never heard
 *     of would be a declaration nobody could maintain. RLS is what keeps this
 *     honest — the worker is NOBYPASSRLS, so it still reads one tenant at a
 *     time.
 *
 * What is left out is the point of enumerating at all: the platform control
 * plane. `platform.tenants`, `platform.api_keys`, `platform.api_key_integrations`,
 * `platform.connector_installations`, `platform.connector_secrets`,
 * `platform.connector_entitlements`, `platform.connector_oauth_states`,
 * `platform.entity_page_configs`, `platform.org_unit`,
 * `platform.entity_field_suggestions` and the migration/audit ledgers are all
 * reachable by the app role and none of them by a worker. Several are GLOBAL
 * tables with no policy at all, where the grant is the only gate there is.
 */
export function workerGrantedTables(): string[] {
  if (!hasWorkers) {
    return [];
  }
  return manifestTables
    .filter(
      (table) =>
        table.workerAccess !== undefined ||
        table.workerDml === true ||
        (table.generatedCrudEligible === undefined
          ? table.generatedCrud === true
          : table.generatedCrudEligible === true),
    )
    .map((table) => `${table.schema}.${table.table}`)
    .sort();
}

/** Distinct schemas the granted tables live in, for the USAGE grants. */
function workerGrantedSchemas(): string[] {
  return [
    ...new Set(workerGrantedTables().map((qualified) => qualified.split(".")[0]!)),
  ].sort();
}

/**
 * Every schema the manifest declares a table in — the scope of the revoke that
 * precedes the grants.
 *
 * Wider than {@link workerGrantedSchemas} on purpose. Revoking only where the
 * worker is currently granted would leave a stale grant behind exactly when it
 * matters most: a deployment that drops its last worker plugin, or a schema
 * whose last `workerDml` table loses the declaration, would keep privileges
 * nothing declares any more.
 */
const MANIFEST_SCHEMAS: readonly string[] = [
  ...new Set(manifestTables.map((table) => table.schema)),
]
  .filter((schema) => schema !== "app")
  .sort();

/**
 * Create/repair the worker role. Runs FIRST in the chain alongside
 * {@link applyAppRoleMigration}, so nothing it touches is guaranteed to exist
 * yet — every grant is issued by {@link applyWorkerRoleGrants} after the schema
 * steps instead, and only the role itself and the CONNECT grant land here.
 */
export async function applyWorkerRoleMigration(db: OpenShapeForgeDatabase) {
  const workerRolePassword = readWorkerRolePassword();

  // 1. Create the role if absent. Same contract as the app role: the password
  //    is set ONLY here, at first creation, so a routine migrate cannot clobber
  //    an operator-chosen credential or downgrade it to a known value.
  //    NOSUPERUSER + NOBYPASSRLS are load-bearing here too — a worker that
  //    bypassed RLS would read every tenant's business data, which is the
  //    outcome `workerAccess` was introduced to avoid.
  await sql`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = ${sql.lit(WORKER_ROLE)}) then
        create role ${sql.ref(WORKER_ROLE)}
          login password ${sql.lit(workerRolePassword)}
          nosuperuser nobypassrls;
      end if;
    end
    $$;
  `.execute(db);

  // Repair the load-bearing attributes if they have drifted — a tampered or
  // hand-created role — but only then.
  //
  // `pg_authid` is CLUSTER-wide, so an unconditional ALTER ROLE on every
  // migrate would make concurrent scratch databases rewrite the same tuple
  // and collide with `tuple concurrently updated`. Like the app-role repair,
  // reading `pg_roles` first limits writes to first creation and actual drift;
  // routine migrations remain read-only at the role-catalog boundary.
  await sql`
    do $$
    begin
      if exists (
        select 1 from pg_roles
        where rolname = ${sql.lit(WORKER_ROLE)}
          and (not rolcanlogin or rolsuper or rolbypassrls)
      ) then
        execute format('alter role %I login nosuperuser nobypassrls', ${sql.lit(WORKER_ROLE)});
      end if;
    end
    $$;
  `.execute(db);

  if (shouldRotateWorkerRolePassword()) {
    await sql`alter role ${sql.ref(WORKER_ROLE)} login password ${sql.lit(workerRolePassword)}`.execute(
      db,
    );
  }

  // 2. CONNECT on the database itself. Stock PostgreSQL grants it to PUBLIC;
  //    managed providers revoke it, leaving a role able to authenticate but not
  //    connect. Same reasoning, and same statement, as the app role's.
  await sql`
    do $$
    begin
      execute format('grant connect on database %I to %I', current_database(), ${sql.lit(WORKER_ROLE)});
    end
    $$;
  `.execute(db);
}

/**
 * Grant the worker role exactly {@link workerGrantedTables}, plus the schema
 * USAGE those tables need and USAGE/EXECUTE on the `app` helper schema.
 *
 * Runs AFTER the generated schema, for the reason `applyAppRoleGrants` does:
 * `GRANT` only covers objects that exist at grant time. Idempotent, and re-run
 * on every migrate, which is what picks up a table that newly declares
 * `workerDml` without a bespoke migration.
 *
 * REVOKE-then-GRANT rather than GRANT alone. A table that STOPS declaring
 * `workerDml` — or an entity that stops being CRUD-generated, or a whole plugin
 * that is removed — must lose the grant, and a plain sweep would leave it in
 * place forever. `revoke all` names the worker role, so it can never touch the
 * app role's privileges, and it runs over every schema the manifest reaches
 * rather than only the ones currently granted.
 */
export async function applyWorkerRoleGrants(db: OpenShapeForgeDatabase) {
  const granted = workerGrantedTables();

  // USAGE and EXECUTE on `app`. Guarded on the schema existing, like every
  // other grant issued before the schema steps have certainly run. Read-only
  // helpers — they read GUCs — so this hands the worker no authority it does
  // not already have; it is here so a worker-side query naming `app.…` behaves
  // the same as an API-side one (#295).
  await sql`
    do $$
    begin
      if exists (select 1 from information_schema.schemata where schema_name = 'app') then
        execute format('grant usage on schema app to %I', ${sql.lit(WORKER_ROLE)});
        execute format('grant execute on all functions in schema app to %I', ${sql.lit(WORKER_ROLE)});
        execute format(
          'alter default privileges in schema app grant execute on functions to %I',
          ${sql.lit(WORKER_ROLE)}
        );
      end if;
    end
    $$;
  `.execute(db);

  // Drop every table privilege the worker holds, everywhere the manifest
  // reaches, before re-granting — so the enumeration below is the whole truth
  // rather than a high-water mark, and a table that stops declaring `workerDml`
  // actually loses the grant. Scoped to the worker role, so the app role's
  // sweep is never touched.
  for (const schema of MANIFEST_SCHEMAS) {
    await sql`
      do $$
      begin
        if exists (select 1 from information_schema.schemata where schema_name = ${sql.lit(schema)}) then
          execute format('revoke all on all tables in schema %I from %I', ${sql.lit(schema)}, ${sql.lit(WORKER_ROLE)});
          execute format('revoke all on all sequences in schema %I from %I', ${sql.lit(schema)}, ${sql.lit(WORKER_ROLE)});
        end if;
      end
      $$;
    `.execute(db);
  }

  // USAGE only where the worker actually holds something. A schema it can name
  // but holds no table in is a schema it has no business naming.
  for (const schema of workerGrantedSchemas()) {
    await sql`
      do $$
      begin
        if exists (select 1 from information_schema.schemata where schema_name = ${sql.lit(schema)}) then
          execute format('grant usage on schema %I to %I', ${sql.lit(schema)}, ${sql.lit(WORKER_ROLE)});
        end if;
      end
      $$;
    `.execute(db);
  }

  for (const qualified of granted) {
    const [schema, table] = qualified.split(".") as [string, string];
    await sql`
      do $$
      begin
        if to_regclass(${sql.lit(`${schema}.${table}`)}) is not null then
          execute format(
            'grant select, insert, update, delete on %I.%I to %I',
            ${sql.lit(schema)}, ${sql.lit(table)}, ${sql.lit(WORKER_ROLE)}
          );
        end if;
      end
      $$;
    `.execute(db);

    // Sequences OWNED BY a column of a granted table, and only those. Identity
    // columns do not need this (PostgreSQL treats an identity sequence as part
    // of the table), but a `serial`-shaped default would, and the join keeps
    // the grant tied to tables the worker already holds rather than sweeping a
    // schema.
    await sql`
      do $$
      declare
        seq record;
      begin
        for seq in
          select sequence_ns.nspname as schema_name, sequence_class.relname as sequence_name
          from pg_class as sequence_class
          join pg_namespace as sequence_ns on sequence_ns.oid = sequence_class.relnamespace
          join pg_depend as dependency
            on dependency.objid = sequence_class.oid
           and dependency.classid = 'pg_class'::regclass
           and dependency.deptype = 'a'
          where sequence_class.relkind = 'S'
            and dependency.refobjid = to_regclass(${sql.lit(`${schema}.${table}`)})
        loop
          execute format(
            'grant usage, select on sequence %I.%I to %I',
            seq.schema_name, seq.sequence_name, ${sql.lit(WORKER_ROLE)}
          );
        end loop;
      end
      $$;
    `.execute(db);
  }
}
