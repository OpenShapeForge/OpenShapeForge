// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { keyringFromEnv } from "../platform/secrets.js";
import { createWebhookSecretServices, WEBHOOK_MAX_BODY_BYTES } from "./webhook-secrets.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const credentialId = "00000000-0000-4000-8000-000000000003";
const definitionId = "00000000-0000-4000-8000-000000000009";
const session = { tenantId, userId: "00000000-0000-4000-8000-000000000002", credential: "bearer" } as TrustedSessionContext;
const secret = "synthetic-unit-fixture-secret-value-123456";
const now = new Date("2026-10-03T12:00:00Z");
const timestamp = String(Math.floor(now.getTime() / 1000));
const eventId = "delivery-fixture-1";
const body = Buffer.from('{ "amount": 42 }');
const signature = (bytes = body, id = eventId, time = timestamp) => createHmac("sha256", secret).update(`${time}.${id}.`).update(bytes).digest("hex");
const services = createWebhookSecretServices({
  acceptsSession: (candidate) => candidate === session,
  keyring: keyringFromEnv(`test:${Buffer.alloc(32, 5).toString("base64")}`)!,
  clock: () => now,
  serviceIdentity: () => "fixture-service-identity",
  runVerified: async (verified, work) => work(verified),
});

test("HMAC verifier authenticates the exact bytes and signed event id without exposing the secret", async () => {
  const storedSecret = await services.seal(session, { credentialId, definitionId, secret });
  expect(JSON.stringify(storedSecret)).not.toContain(secret);
  const request = { tenantId, credentialId, definitionId, storedSecret, timestamp, eventId, signature: signature(), body };
  expect(await services.verify(request)).toBe(true);
  expect(await services.verify({ ...request, body: Buffer.from('{"amount":42}') })).toBe(false);
  expect(await services.verify({ ...request, eventId: "other-delivery" })).toBe(false);
  expect(await services.verify({ ...request, signature: "z".repeat(64) })).toBe(false);
  expect(await services.verify({ ...request, signature: "0".repeat(64) })).toBe(false);
  expect(await services.verify({ ...request, timestamp: `${timestamp},${timestamp}` })).toBe(false);
  expect(await services.verify({ ...request, body: Buffer.alloc(WEBHOOK_MAX_BODY_BYTES + 1) })).toBe(false);
});

test("the timestamp window rejects stale and future signatures; AAD refuses tenant and row substitution", async () => {
  const storedSecret = await services.seal(session, { credentialId, definitionId, secret });
  const request = { tenantId, credentialId, definitionId, storedSecret, timestamp, eventId, signature: signature(), body };
  for (const seconds of [-301, 301]) {
    const time = String(Number(timestamp) + seconds);
    expect(await services.verify({ ...request, timestamp: time, signature: signature(body, eventId, time) })).toBe(false);
  }
  const edge = String(Number(timestamp) - 300);
  expect(await services.verify({ ...request, timestamp: edge, signature: signature(body, eventId, edge) })).toBe(true);
  expect(await services.verify({ ...request, tenantId: "00000000-0000-4000-8000-000000000004" })).toBe(false);
  expect(await services.verify({ ...request, credentialId: "00000000-0000-4000-8000-000000000005" })).toBe(false);
  expect(await services.verify({ ...request, definitionId: "00000000-0000-4000-8000-000000000008" })).toBe(false);
  expect(await services.verify({ ...request, storedSecret: { ...storedSecret, ciphertext: "corrupt" } })).toBe(false);
});

test("sealing requires the actual verified live session and configured at-rest encryption", async () => {
  await expect(services.seal({ ...session }, { credentialId, definitionId, secret })).rejects.toThrow("live verified");
  await expect(services.seal(session, { credentialId, definitionId, secret: "short" })).rejects.toThrow("32 and 4096");
});

test("verified signature scope derives provenance from ciphertext and strips issuer authority", async () => {
  const storedSecret = await services.seal(session, { credentialId, definitionId, secret });
  const request = { tenantId, credentialId, definitionId, storedSecret, timestamp, eventId, signature: signature(), body };
  expect(await services.withVerifiedSignature(request, async (verified) => ({
    ...verified, session: { ...verified.session },
  }))).toMatchObject({
    definitionId, serviceIdentityId: "fixture-service-identity",
    session: { tenantId, userId: session.userId, roles: [], groups: [], scope: "self" },
  });
  let invoked = false;
  expect(await services.withVerifiedSignature({ ...request, signature: "0".repeat(64) }, async () => { invoked = true; })).toBeUndefined();
  expect(invoked).toBe(false);
});
