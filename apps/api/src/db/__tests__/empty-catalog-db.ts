// SPDX-License-Identifier: BUSL-1.1
/** Test-only empty stored-tool catalogue. Keeps routing tests independent of PostgreSQL. */
import { Kysely, PostgresDialect } from 'kysely';
import type { OpenShapeForgeDatabase } from '../connection.js';

export function emptyCatalogDatabase(): OpenShapeForgeDatabase {
  const connection = { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} };
  return new Kysely({ dialect: new PostgresDialect({ pool: { connect: async () => connection, end: async () => {} } as never }) }) as OpenShapeForgeDatabase;
}
