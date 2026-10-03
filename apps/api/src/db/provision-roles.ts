// SPDX-License-Identifier: BUSL-1.1
/**
 * Provision the declared database roles as an ADMINISTRATOR — the host's step
 * before `db:migrate`, never part of the migration chain itself.
 *
 *   OPENSHAPEFORGE_ADMIN_DATABASE_URL=postgres://admin:...@host/db \
 *   OPENSHAPEFORGE_MIGRATE_DATABASE_URL=postgres://migrator:...@host/db \
 *     bun apps/api/src/db/provision-roles.ts
 *
 * Login roles get their password from OPENSHAPEFORGE_APP_PASSWORD and
 * OPENSHAPEFORGE_WORKER_PASSWORD (the same values the runtime connects with).
 * The migrate role — the user in OPENSHAPEFORGE_MIGRATE_DATABASE_URL, or
 * OPENSHAPEFORGE_MIGRATOR_ROLE — is granted membership of the definer roles.
 *
 * `--print` renders the statements for an operator instead of executing them.
 */
import { createDatabaseRuntime, readAdminDatabaseUrl, readMigrateDatabaseUrl } from "./connection.js";
import { provisionDatabaseRoles, renderProvisioningSql } from "./database-roles.js";
import { readAppRolePassword, shouldRotateAppRolePassword } from "./migrations/app-role.js";
import { readWorkerRolePassword, shouldRotateWorkerRolePassword } from "./migrations/worker-role.js";

function migratorRole(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.OPENSHAPEFORGE_MIGRATOR_ROLE) return env.OPENSHAPEFORGE_MIGRATOR_ROLE;
  try {
    const user = new URL(readMigrateDatabaseUrl(env)).username;
    return user ? decodeURIComponent(user) : undefined;
  } catch {
    return undefined;
  }
}

const migrator = migratorRole();

if (process.argv.includes("--print")) {
  console.log(renderProvisioningSql(migrator ? { migratorRole: migrator } : {}));
  process.exit(0);
}

// Local development and CI run the migrate role as the instance owner, so the
// migrate URL doubles as the admin connection there. A deployed host sets the
// admin URL explicitly; its migrate role cannot create roles and the attempt
// fails with Postgres' own permission error.
const adminUrl = readAdminDatabaseUrl();
if (!process.env.OPENSHAPEFORGE_ADMIN_DATABASE_URL?.trim()) {
  console.log("OPENSHAPEFORGE_ADMIN_DATABASE_URL not set; using the migrate connection as administrator.");
}

const runtime = createDatabaseRuntime({ databaseUrl: adminUrl });
try {
  const result = await runtime.db.connection().execute((db) =>
    provisionDatabaseRoles(db, {
      passwords: { app: readAppRolePassword(), worker: readWorkerRolePassword() },
      rotatePasswords: {
        app: shouldRotateAppRolePassword(),
        worker: shouldRotateWorkerRolePassword(),
      },
      ...(migrator ? { migratorRole: migrator } : {}),
    }),
  );
  for (const name of result.created) console.log(`created role ${name}`);
  for (const name of result.rotated) console.log(`rotated password for role ${name}`);
  for (const grant of result.granted) console.log(`granted ${grant}`);
  for (const name of result.unchanged) console.log(`role ${name} already present; left unchanged`);
} finally {
  await runtime.close();
}
