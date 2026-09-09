#!/usr/bin/env bun
// SPDX-License-Identifier: BUSL-1.1
/**
 * Restore Keycloak's stock password flows on a RUNNING loopback realm only.
 *
 * Generated realm artifacts remain passkey-only in every mode. Browser and API
 * acceptance suites still need deterministic seeded-user logins, so they make
 * this explicit, non-exportable admin mutation after importing the artifact.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal"]);

type RealmRepresentation = Record<string, unknown> & {
  browserFlow?: string;
  directGrantFlow?: string;
  registrationFlow?: string;
};

type RequiredAction = Record<string, unknown> & {
  alias?: string;
  defaultAction?: boolean;
};

export function assertLoopbackKeycloak(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`refusing to enable password login on non-loopback Keycloak ${parsed.origin}`);
  }
  return parsed.origin;
}

async function adminRequest(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/admin${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function relaxRealmForLocalPasswords(input: { baseUrl: string; token: string; realm: string }): Promise<void> {
  const baseUrl = assertLoopbackKeycloak(input.baseUrl);
  const realmPath = `/realms/${encodeURIComponent(input.realm)}`;
  const current = await adminRequest(baseUrl, input.token, "GET", realmPath);
  if (!current.ok) {
    throw new Error(`read realm ${input.realm}: ${current.status} ${await current.text()}`);
  }
  const representation = (await current.json()) as RealmRepresentation;
  representation.browserFlow = "browser";
  representation.directGrantFlow = "direct grant";
  representation.registrationFlow = "registration";
  const updated = await adminRequest(baseUrl, input.token, "PUT", realmPath, representation);
  if (!updated.ok) {
    throw new Error(`update realm ${input.realm}: ${updated.status} ${await updated.text()}`);
  }

  await disableDefaultPasskeyEnrollment(input);
}

/** Keep a seeded or federated CI identity out of the enrolment ceremony. */
export async function disableDefaultPasskeyEnrollment(input: { baseUrl: string; token: string; realm: string }): Promise<void> {
  const baseUrl = assertLoopbackKeycloak(input.baseUrl);
  const realmPath = `/realms/${encodeURIComponent(input.realm)}`;

  const actionsResponse = await adminRequest(baseUrl, input.token, "GET", `${realmPath}/authentication/required-actions`);
  if (!actionsResponse.ok) {
    throw new Error(`read required actions for ${input.realm}: ${actionsResponse.status} ${await actionsResponse.text()}`);
  }
  const actions = (await actionsResponse.json()) as RequiredAction[];
  const passkey = actions.find((action) => action.alias === "webauthn-register-passwordless" && action.defaultAction === true);
  if (passkey) {
    passkey.defaultAction = false;
    const actionUpdated = await adminRequest(
      baseUrl,
      input.token,
      "PUT",
      `${realmPath}/authentication/required-actions/webauthn-register-passwordless`,
      passkey,
    );
    if (!actionUpdated.ok) {
      throw new Error(`update required action for ${input.realm}: ${actionUpdated.status} ${await actionUpdated.text()}`);
    }
  }
}

async function adminToken(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: process.env.KC_ADMIN_USER ?? "admin",
      password: process.env.KC_ADMIN_PASSWORD ?? "admin",
    }),
  });
  if (!response.ok) {
    throw new Error(`admin token: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { access_token: string }).access_token;
}

async function main(): Promise<void> {
  const baseUrl = assertLoopbackKeycloak(process.env.KC_URL ?? "http://127.0.0.1:8181");
  const realms = process.argv.slice(2);
  if (realms.length === 0) {
    throw new Error("pass one or more local realm names");
  }
  const token = await adminToken(baseUrl);
  for (const realm of realms) {
    await relaxRealmForLocalPasswords({ baseUrl, token, realm });
    console.log(`${realm}: local password login enabled`);
  }
}

if (import.meta.main) {
  await main();
}
