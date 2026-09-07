// SPDX-License-Identifier: BUSL-1.1
/** Explicit runtime options win; otherwise deployments may cap the DB pool. */
export function readDatabasePoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.OPENSHAPEFORGE_DB_MAX_CONNECTIONS;
  if (value === undefined) return 10;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("OPENSHAPEFORGE_DB_MAX_CONNECTIONS must be a positive integer.");
  }
  return Number(value);
}
