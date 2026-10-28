// SPDX-License-Identifier: BUSL-1.1
/**
 * What the realm is told an integration is called.
 *
 * The catalog's contract permits a display name of 200 CODE POINTS, and
 * Keycloak's `CLIENT.NAME` holds 255 CHARACTERS where a UTF-16 code unit is one
 * character. 200 emoji are 400 units, so `POST /clients` answered 500 — which
 * a customer reads as a 502 "could not provision the identity" for a name the
 * form told them they could use, with a 'pending' row left for the reconciler.
 * Measured against Keycloak 26 (and re-measured as part of this change): 255
 * units are stored, 256 are refused with a 500.
 *
 * The realm's copy is a label; the authoritative name is the integration row,
 * which every read reports. So the name is cut to the realm's limit, and this
 * is the proof that the cut lands on a whole character and that the request
 * body carries it. That a real Keycloak then accepts the result is reported
 * separately with the task's external evidence — it cannot be asserted here,
 * where the realm is an injected `fetch`.
 */
import { expect, test } from "bun:test";
import { KeycloakAdmin, realmClientName } from "./keycloak-admin.js";

test("keeps a name the realm can hold exactly as it is", () => {
  for (const name of ["Partner portal", "回".repeat(200), "x".repeat(255), "🎉".repeat(127)]) {
    expect(realmClientName(name)).toBe(name);
  }
});

test("cuts a longer name to the realm's limit, never through a character", () => {
  // 200 emoji: 400 units, so the cut falls inside the set. 255 units is an odd
  // number of halves, so the last pair cannot be kept whole — 254 units is the
  // longest the realm can hold without storing half an emoji.
  const cut = realmClientName("🎉".repeat(200));
  expect(cut.length).toBe(254);
  expect([...cut].length).toBe(127);
  expect(cut).toBe("🎉".repeat(127));
  // A name that ends on a whole character at the limit keeps all 255 units.
  const mixed = realmClientName(`${"🎉".repeat(127)}${"x".repeat(100)}`);
  expect(mixed.length).toBe(255);
  expect(mixed).toBe(`${"🎉".repeat(127)}x`);
  // Plain text is cut at the limit itself.
  expect(realmClientName("x".repeat(400))).toBe("x".repeat(255));
});

test("sends the cut name in the create request, and the full id", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const admin = new KeycloakAdmin({
    baseUrl: "https://realm.test",
    realm: "openshapeforge",
    clientId: "provisioner",
    clientSecret: "provisioner-secret",
    apiAudience: "test-api",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/protocol/openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "token", expires_in: 300 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (init?.method === "POST" && url.endsWith("/clients")) {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(null, { status: 201 });
      }
      // The reads that follow the create are not what this test is about.
      return new Response(JSON.stringify([]), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });

  const clientId = "osf-int-6f3c0a2e-1d4b-4a7c-9e8f-0b1c2d3e4f50";
  // The create fails further on — there is no realm behind this fetch — which
  // is after the request this test reads.
  await admin.createServiceAccountClient(clientId, "🎉".repeat(200)).catch(() => undefined);
  expect(bodies).toHaveLength(1);
  // The identifier is never shortened: it is what every later call addresses
  // the client by, and it is a derived uuid rather than customer text.
  expect(bodies[0]!.clientId).toBe(clientId);
  expect((bodies[0]!.name as string).length).toBe(254);
  expect(bodies[0]!.name).toBe("🎉".repeat(127));
  expect(bodies[0]!.protocolMappers).toContainEqual({
    name: "test-api-audience", protocol: "openid-connect",
    protocolMapper: "oidc-audience-mapper", consentRequired: false,
    config: { "included.custom.audience": "test-api", "id.token.claim": "false", "access.token.claim": "true" },
  });
});
