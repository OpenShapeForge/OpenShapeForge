// SPDX-License-Identifier: BUSL-1.1
import { test, expect } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { resolveSessionContext, __resetSessionResolverForTests } from "./identity.js";
import { stubLinkedMembershipForTests } from "./identity-link.test-support.js";
import { sessionLocale } from "../mcp/session-identity.js";

test("REST keeps verified locale across bundled session copies and rejects tampered claims", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const key = { ...await exportJWK(publicKey), kid: "locale-test", alg: "RS256" };
  const jwks = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [key] }) });
  const updates = {
    OPENSHAPEFORGE_API_VERIFY_BEARER_JWKS_URI: new URL("/jwks", jwks.url).href,
    OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER: "https://identity.example.test",
    OPENSHAPEFORGE_API_VERIFY_BEARER_AUDIENCE: "api",
    OPENSHAPEFORGE_API_VERIFY_BEARER_AUTHORIZED_PARTIES: "web",
  };
  const before = Object.fromEntries(Object.keys(updates).map(key => [key, process.env[key]]));
  Object.assign(process.env, updates); __resetSessionResolverForTests(); stubLinkedMembershipForTests();
  try {
    for (const locale of ["en-GB", "nl-NL"]) {
      const token = await new SignJWT({ tid: "tenant-a", locale, azp: "web" })
        .setProtectedHeader({ alg: "RS256", kid: "locale-test" })
        .setIssuer(updates.OPENSHAPEFORGE_API_VERIFY_BEARER_ISSUER).setAudience("api").setSubject("person-a")
        .setIssuedAt().setExpirationTime("2m").sign(privateKey);
      const session = await resolveSessionContext(new Headers({ authorization: `Bearer ${token}` }));
      expect(session.userId).toBe("person-a");
      expect(session.locale).toBe(locale);
      expect(sessionLocale({ ...session }).tag).toBe(locale.startsWith("nl") ? "nl" : "en");
      const parts = token.split(".");
      parts[1] = Buffer.from(JSON.stringify({ tid: "tenant-a", locale: "nl" })).toString("base64url");
      const rejected = await resolveSessionContext(new Headers({ authorization: `Bearer ${parts.join(".")}` }));
      expect(rejected.locale).toBeUndefined();
    }
  } finally {
    jwks.stop(true);
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    __resetSessionResolverForTests();
  }
});
