import { describe, expect, test } from "bun:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from "jose";
import { createBearerVerifier } from "./bearer.js";

const ALG = "RS256";
const ISSUER = "https://issuer.example/realms/openshapeforge";
const AUDIENCE = "erp-provider";
const KID = "test-key-1";

/**
 * Builds a real signing key + a local JWKS verifier key set, so
 * createBearerVerifier exercises genuine RS256 signature verification
 * (no network JWKS fetch). A second, unrelated key pair is provided so
 * tokens can be signed with a key that is NOT in the published JWKS — the
 * "wrong signature" case.
 */
async function buildKeys() {
  const trusted = await generateKeyPair(ALG, { extractable: true });
  const publicJwk = await exportJWK(trusted.publicKey);
  publicJwk.kid = KID;
  publicJwk.alg = ALG;
  const keySet: JWTVerifyGetKey = createLocalJWKSet({ keys: [publicJwk] });

  // A rogue key not present in the JWKS — used to forge a bad signature.
  const rogue = await generateKeyPair(ALG, { extractable: true });

  return { keySet, signingKey: trusted.privateKey, rogueKey: rogue.privateKey };
}

type SignOptions = {
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  signWith?: CryptoKey;
};

async function mintToken(signingKey: CryptoKey, options: SignOptions = {}): Promise<string> {
  const jwt = new SignJWT({
    realm_access: { roles: ["User"] },
  })
    .setProtectedHeader({ alg: ALG, kid: KID })
    .setSubject("user-123")
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(options.expiresIn ?? "5m");
  return jwt.sign(options.signWith ?? signingKey);
}

describe("createBearerVerifier", () => {
  test("accepts a correctly-signed token with the expected issuer and audience", async () => {
    const { keySet, signingKey } = await buildKeys();
    const verify = createBearerVerifier({ keySet, issuer: ISSUER, audience: AUDIENCE });

    const token = await mintToken(signingKey);
    const { identity, claims } = await verify(token);

    expect(identity.userId).toBe("user-123");
    expect(identity.roles).toEqual(["User"]);
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(AUDIENCE);
  });

  test("rejects a token whose signature does not verify against the JWKS", async () => {
    const { keySet, signingKey, rogueKey } = await buildKeys();
    const verify = createBearerVerifier({ keySet, issuer: ISSUER, audience: AUDIENCE });

    // Signed with a private key whose public key is NOT in the JWKS.
    const forged = await mintToken(signingKey, { signWith: rogueKey });
    await expect(verify(forged)).rejects.toThrow();
  });

  test("rejects a token with the wrong issuer", async () => {
    const { keySet, signingKey } = await buildKeys();
    const verify = createBearerVerifier({ keySet, issuer: ISSUER, audience: AUDIENCE });

    const token = await mintToken(signingKey, {
      issuer: "https://attacker.example/realms/evil",
    });
    await expect(verify(token)).rejects.toThrow();
  });

  test("rejects a token minted for a sibling client (wrong audience)", async () => {
    const { keySet, signingKey } = await buildKeys();
    const verify = createBearerVerifier({ keySet, issuer: ISSUER, audience: AUDIENCE });

    const token = await mintToken(signingKey, { audience: "some-other-client" });
    await expect(verify(token)).rejects.toThrow();
  });

  test("rejects a token that omits the audience claim when an audience is pinned", async () => {
    const { keySet, signingKey } = await buildKeys();
    const verify = createBearerVerifier({ keySet, issuer: ISSUER, audience: AUDIENCE });

    // Mint without an audience claim.
    const token = await new SignJWT({ realm_access: { roles: ["User"] } })
      .setProtectedHeader({ alg: ALG, kid: KID })
      .setSubject("user-123")
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setExpirationTime("5m")
      .sign(signingKey);

    await expect(verify(token)).rejects.toThrow();
  });

  test("rejects an expired token", async () => {
    const { keySet, signingKey } = await buildKeys();
    const verify = createBearerVerifier({ keySet, issuer: ISSUER, audience: AUDIENCE });

    // Signed with iat/exp in the past.
    const expired = await new SignJWT({ realm_access: { roles: ["User"] } })
      .setProtectedHeader({ alg: ALG, kid: KID })
      .setSubject("user-123")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(signingKey);

    await expect(verify(expired)).rejects.toThrow();
  });
});
