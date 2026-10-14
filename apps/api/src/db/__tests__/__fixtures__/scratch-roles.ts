// SPDX-License-Identifier: BUSL-1.1
/**
 * The cluster-wide database roles a scratch test database needs.
 *
 * The shared development cluster has them already — the host provisions them
 * once, outside the migration chain (db/database-roles.ts) — so most db tests
 * just create a database and migrate. A test given its OWN disposable cluster
 * has an empty `pg_roles`, and the chain correctly refuses to migrate into it.
 *
 * So call this first, with an administrator connection to the scratch
 * database: it runs the same owner helper `db:provision-roles` runs, with the
 * same operator-owned passwords the runtime URLs are built from, and is
 * idempotent on a cluster that already has them. Roles are cluster-wide, so
 * nothing here drops them again.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../../connection.js";
import { provisionDatabaseRoles } from "../../database-roles.js";
import { readAppRolePassword } from "../../migrations/app-role.js";
import { readWorkerRolePassword } from "../../migrations/worker-role.js";

export async function ensureScratchDatabaseRoles(
  admin: OpenShapeForgeDatabase,
): Promise<{ app: string; worker: string }> {
  const passwords = { app: readAppRolePassword(), worker: readWorkerRolePassword() };
  const migratorRole = (await sql<{ user: string }>`select current_user as "user"`.execute(admin))
    .rows[0]!.user;
  await provisionDatabaseRoles(admin, { passwords, migratorRole });
  return passwords;
}
