// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { __resetSessionResolverForTests, resolveSessionContext } from "./identity.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";

test("real JWT verification admits only a configured service client without person enrollment", async () => {
  const keys = ["OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI", "OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER",
    "OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE", "OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES",
    "OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [{ ...jwk, kid: "automatic-test", alg: "RS256", use: "sig" }] }) });
  const tenant = "11111111-1111-4111-8111-111111111111";
  let personStoreAccess = 0;
  const db = new Proxy({}, { get() { personStoreAccess++; throw new Error("Person enrollment store must not be accessed for the configured automatic account."); } }) as OpenShapeForgeDatabase;
  try {
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI = server.url.href;
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER = "https://issuer.example.test";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE = "api";
    process.env.OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES = "automatic,web";
    process.env.OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES = JSON.stringify([{ tenantId: tenant, clientId: "automatic", clientSecret: "local-only" }]);
    __resetSessionResolverForTests();
    const mint = (azp: string) => {
      const issued = Math.floor(Date.now() / 1000);
      const payload = { tid: tenant, azp, preferred_username: "service-account-automatic",
        resource_access: { api: { roles: ["Relations.All.ReadWrite"] } }, iss: "https://issuer.example.test",
        aud: "api", sub: "22222222-2222-4222-8222-222222222222", iat: issued, exp: issued + 120 };
      const body = [Buffer.from(JSON.stringify({ alg: "RS256", kid: "automatic-test" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url")].join(".");
      return `${body}.${sign("RSA-SHA256", Buffer.from(body), pair.privateKey).toString("base64url")}`;
    };
    const session = await resolveSessionContext(new Headers({ authorization: `Bearer ${await mint("automatic")}` }), { db });
    expect(session.tenantId).toBe(tenant);
    expect(session.roles).toContain("Relations.All.ReadWrite");
    expect(session.relation).toBeNull();
    expect(personStoreAccess).toBe(0);
    await resolveSessionContext(new Headers({ authorization: `Bearer ${await mint("web")}` }), { db });
    expect(personStoreAccess).toBeGreaterThan(0);
  } finally {
    server.stop(true);
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    __resetSessionResolverForTests();
  }
});
