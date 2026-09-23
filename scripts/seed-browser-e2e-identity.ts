// SPDX-License-Identifier: BUSL-1.1
/**
 * Admit the real Keycloak identity used by the browser authentication suite.
 *
 * Login and organization admission are separate production boundaries. The
 * browser suite tests the authorization-code login, so it prepares admission
 * explicitly through the same test-only helper used by the API transport
 * suites instead of weakening the runtime boundary.
 */
import {
  createDatabaseRuntime,
  readMigrateDatabaseUrl,
} from "../apps/api/src/db/connection.js";
import {
  getKeycloakToken,
  seedKeycloakTokenPeople,
} from "../apps/api/src/graphql/__tests__/e2e/keycloak.js";

const token = await getKeycloakToken();
if (!token) {
  throw new Error("The browser E2E Keycloak identity could not obtain a token.");
}

const runtime = createDatabaseRuntime({
  databaseUrl: readMigrateDatabaseUrl(),
  maxConnections: 1,
});

try {
  await seedKeycloakTokenPeople(runtime.db, [token]);
  console.log("Browser E2E identity admitted.");
} finally {
  await runtime.close();
}
