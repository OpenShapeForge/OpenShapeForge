// SPDX-License-Identifier: BUSL-1.1

export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000";
export const E2E_USERNAME = process.env.E2E_KEYCLOAK_USERNAME ?? "tenant-a-admin";

function passwordFor(username: string): string {
  const key = `E2E_USER_PASSWORD_${username.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
  return process.env[key] ?? "test";
}

export const E2E_PASSWORD =
  process.env.E2E_KEYCLOAK_PASSWORD ?? passwordFor(E2E_USERNAME);
