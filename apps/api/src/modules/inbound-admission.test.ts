// SPDX-License-Identifier: BUSL-1.1
/**
 * Admission, over an in-memory store that records the ORDER of what it was
 * asked to do.
 *
 * The store port is the seam on purpose: the questions this file has to answer
 * are not "does Postgres have a unique index" (that is
 * db/__tests__/inbound-deliveries.test.ts) but "is anything written before the
 * signature is verified", "is `accepted` ever returned when the write failed",
 * and "can a tenant be decided by anything other than the registration". Those
 * are answerable exactly here, and a fake store can fail in ways a real one
 * cannot be asked to on demand.
 */
import { expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import type { RuntimeInboundSignatureScheme } from "@openshapeforge/plugin-runtime";
import { decryptSecret, encryptSecret, keyringFromEnv } from "../platform/secrets.js";
import { INBOUND_MAX_BODY_BYTES } from "../platform/inbound-signature.js";
import {
  createInboundAdmission, inboundBodyScope, inboundDeliveryKey, INBOUND_BODY_FIELD,
  INBOUND_SECRET_FIELD, type InboundAdmissionEndpoint, type InboundAdmissionStore,
  type RecordInboundDeliveryInput,
} from "./inbound-admission.js";
import { normalizeInboundIdentity } from "./inbound-identity.js";

const keyring = keyringFromEnv(`test:${Buffer.alloc(32, 9).toString("base64")}`)!;
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000b2";
const ENDPOINT = "00000000-0000-4000-8000-0000000000c3";
const OWNER = "00000000-0000-4000-8000-0000000000d4";
const SECRET = "synthetic-unit-fixture-inbound-secret-0123456789";
const KEY = "jira-admin";

const jira: RuntimeInboundSignatureScheme = {
  header: "x-hub-signature", algorithm: "sha256", encoding: "hex", prefix: "sha256=",
};
const BODY = Buffer.from('{ "webhookEvent": "user_created", "user": { "accountId": "a1" } }');

function endpoint(overrides: Partial<InboundAdmissionEndpoint> = {}): InboundAdmissionEndpoint {
  const tenantId = overrides.tenantId ?? TENANT;
  const id = overrides.id ?? ENDPOINT;
  return {
    id, tenantId, endpointKey: KEY, signature: jira,
    // Sealed against the tenant and endpoint it is being read for, exactly as
    // registration seals it.
    storedSecret: encryptSecret(keyring, `${tenantId}:${id}`, INBOUND_SECRET_FIELD, SECRET),
    identity: normalizeInboundIdentity({ source: "body-digest", eventTypePath: "webhookEvent" })!,
    // Declared, retained — and, as the tests below prove, powerless.
    unsignedHeaders: {
      deliveryId: "x-atlassian-webhook-identifier",
      eventType: "x-atlassian-webhook-event",
    },
    maxBodyBytes: INBOUND_MAX_BODY_BYTES,
    status: "active",
    serviceIdentityId: "fixture-service-identity",
    dispatch: { operationId: "integrations.jira.receiveAdminEvent", inputField: "delivery" },
    createdBy: OWNER,
    ...overrides,
  };
}

const signature = (bytes: Uint8Array = BODY, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;

type Journal = string[];

type FakeStoreOptions = {
  rows: readonly InboundAdmissionEndpoint[];
  /** Which tenant the pre-authentication point lookup answers, if any. */
  tenantFor?(endpointId: string): string | undefined;
  /** Simulate a transaction that cannot commit. */
  failWrite?: boolean;
  /** Simulate the lookup itself being unavailable. */
  failLookup?: boolean;
};

function fakeStore(options: FakeStoreOptions): { store: InboundAdmissionStore; journal: Journal; recorded: RecordInboundDeliveryInput[] } {
  const journal: Journal = [];
  const recorded: RecordInboundDeliveryInput[] = [];
  const kept = new Map<string, string>();
  const store: InboundAdmissionStore = {
    tenantForEndpoint: async (endpointId) => {
      journal.push("lookup");
      if (options.failLookup) throw new Error("the lookup is unavailable");
      if (options.tenantFor) return options.tenantFor(endpointId);
      return options.rows.find((row) => row.id === endpointId)?.tenantId;
    },
    withTenant: async (tenantId, work) => {
      journal.push(`open:${tenantId}`);
      const result = await work({
        readEndpoint: async (endpointId) => {
          journal.push("read");
          // The fake fences by tenant exactly as the tenant policy does, so a
          // point lookup answering the wrong tenant finds nothing.
          return options.rows.find((row) => row.id === endpointId && row.tenantId === tenantId);
        },
        recordDelivery: async (input) => {
          journal.push("write");
          recorded.push(input);
          if (options.failWrite) throw new Error("the receipt could not be committed");
          const existing = kept.get(input.idempotencyKey);
          if (existing) return { deliveryId: existing, created: false };
          const deliveryId = randomUUID();
          kept.set(input.idempotencyKey, deliveryId);
          return { deliveryId, created: true };
        },
      });
      journal.push("commit");
      return result;
    },
  };
  return { store, journal, recorded };
}

function admission(options: FakeStoreOptions) {
  const fake = fakeStore(options);
  const logged: string[] = [];
  return {
    ...fake,
    logged,
    admit: createInboundAdmission({
      store: fake.store, keyring: () => keyring, log: (event) => logged.push(event.code),
    }),
  };
}

function request(overrides: Partial<Record<string, string>> = {}, body: Uint8Array = BODY) {
  const headers: Record<string, string | undefined> = {
    "x-hub-signature": signature(body),
    "x-atlassian-webhook-identifier": "atl-delivery-1",
    "x-atlassian-webhook-event": "user_created",
    ...overrides,
  };
  return { endpointKey: KEY, endpointId: ENDPOINT, header: (name: string) => headers[name], body };
}

test("a genuine Jira delivery is accepted, and the tenant comes from the registration", async () => {
  const { admit, journal, recorded } = admission({ rows: [endpoint()] });
  const result = await admit(request());
  expect(result.outcome).toBe("accepted");
  expect(journal).toEqual(["lookup", `open:${TENANT}`, "read", "write", "commit"]);
  expect(recorded[0]?.endpoint.tenantId).toBe(TENANT);
  // The event name came from inside the signature; the header is kept beside
  // it, under a name that says it proves nothing.
  expect(recorded[0]?.eventType).toBe("user_created");
  expect(recorded[0]?.unsignedProviderDeliveryId).toBe("atl-delivery-1");
  expect(recorded[0]?.unsignedEventType).toBe("user_created");
  // The exact bytes are what was kept — sealed, and openable only under this
  // tenant, this endpoint and this receipt.
  const sealed = recorded[0]!;
  expect(Buffer.from(decryptSecret(
    keyring, inboundBodyScope(TENANT, ENDPOINT, sealed.deliveryId), INBOUND_BODY_FIELD,
    sealed.sealedBody,
  ), "base64").equals(BODY)).toBe(true);
  expect(sealed.bodyBytes).toBe(BODY.byteLength);
});

test("the store is never handed a provider payload in the clear", async () => {
  const { admit, recorded } = admission({ rows: [endpoint()] });
  await admit(request());
  const input = recorded[0]!;
  // Serialised whole, because the point is that there is no field anywhere on
  // this input — named `body` or otherwise — carrying the plaintext.
  expect(JSON.stringify(input)).not.toContain("accountId");
  expect(JSON.stringify(input)).not.toContain(BODY.toString("base64"));
  expect(JSON.stringify(input)).not.toContain(SECRET);
});

test("a sealed payload cannot be lifted onto another tenant, endpoint or receipt", async () => {
  const { admit, recorded } = admission({ rows: [endpoint()] });
  await admit(request());
  const { deliveryId, sealedBody } = recorded[0]!;
  for (const scope of [
    inboundBodyScope(OTHER_TENANT, ENDPOINT, deliveryId),
    inboundBodyScope(TENANT, OWNER, deliveryId),
    inboundBodyScope(TENANT, ENDPOINT, randomUUID()),
  ]) {
    expect(() => decryptSecret(keyring, scope, INBOUND_BODY_FIELD, sealedBody)).toThrow();
  }
  // And not under another field of the same row either.
  expect(() => decryptSecret(
    keyring, inboundBodyScope(TENANT, ENDPOINT, deliveryId), INBOUND_SECRET_FIELD, sealedBody,
  )).toThrow();
});

test("nothing is written until the signature verifies", async () => {
  for (const headers of [
    { "x-hub-signature": signature(BODY, "another-tenants-secret-0123456789abc") },
    { "x-hub-signature": `sha256=${"0".repeat(64)}` },
    { "x-hub-signature": undefined },
    { "x-hub-signature": "sha1=deadbeef" },
  ]) {
    const { admit, journal } = admission({ rows: [endpoint()] });
    expect((await admit(request(headers))).outcome).toBe("rejected");
    // `read` happened, `write` never did: the order IS the guarantee.
    expect(journal).toEqual(["lookup", `open:${TENANT}`, "read", "commit"]);
  }
});

test("a delivery addressed to one tenant cannot be admitted into another", async () => {
  // The point lookup answers a tenant the registration does not belong to —
  // the shape a corrupted or raced registry read would have. The tenant
  // transaction then finds nothing, because the row is fenced by tenant.
  const wrong = admission({ rows: [endpoint()], tenantFor: () => OTHER_TENANT });
  expect((await wrong.admit(request())).outcome).toBe("rejected");
  expect(wrong.journal).toEqual(["lookup", `open:${OTHER_TENANT}`, "read", "commit"]);

  // And a registration that somehow reads back under the wrong tenant is
  // refused by admission itself, not only by the policy underneath it.
  const mismatched = admission({
    rows: [endpoint({ tenantId: OTHER_TENANT })], tenantFor: () => TENANT,
  });
  expect((await mismatched.admit(request())).outcome).toBe("rejected");
  expect(mismatched.journal).not.toContain("write");
});

test("the endpoint key in the URL must be the registration's own", async () => {
  const { admit, journal } = admission({ rows: [endpoint()] });
  // A well-formed key for a registration that is not this one: the row is
  // read, and then refused on the mismatch rather than admitted on the id.
  const result = await admit({ ...request(), endpointKey: "github-app" });
  expect(result.outcome).toBe("rejected");
  expect(journal).toEqual(["lookup", `open:${TENANT}`, "read", "commit"]);

  const other = admission({ rows: [endpoint({ endpointKey: "github-app" })] });
  expect((await other.admit(request())).outcome).toBe("rejected");
  expect(other.journal).not.toContain("write");
});

test("an unknown endpoint id answers exactly as a forged signature does", async () => {
  const unknown = admission({ rows: [] });
  expect(await unknown.admit(request())).toEqual({ outcome: "rejected" });
  const forged = admission({ rows: [endpoint()] });
  expect(await forged.admit(request({ "x-hub-signature": `sha256=${"1".repeat(64)}` })))
    .toEqual({ outcome: "rejected" });
});

test("a revoked registration stops admitting, with a valid signature", async () => {
  const { admit, journal } = admission({ rows: [endpoint({ status: "revoked" })] });
  expect((await admit(request())).outcome).toBe("rejected");
  expect(journal).not.toContain("write");
});

test("a repeated delivery is a duplicate, and is never kept or dispatched twice", async () => {
  const fake = fakeStore({ rows: [endpoint()] });
  const admit = createInboundAdmission({ store: fake.store, keyring: () => keyring });
  const first = await admit(request());
  const second = await admit(request());
  expect(first.outcome).toBe("accepted");
  expect(second).toEqual({ outcome: "duplicate", deliveryId: (first as { deliveryId: string }).deliveryId });
  // Both attempts reached the write; the store's delivery key is what made the
  // second one a no-op, which is precisely the contract core relies on.
  expect(fake.recorded).toHaveLength(2);
  expect(fake.recorded[0]?.idempotencyKey).toBe(fake.recorded[1]?.idempotencyKey);
});

test("a captured delivery replayed with a changed unsigned id earns no second dispatch", async () => {
  // The blocker this contract exists for. One valid body and its signature,
  // resent with every delivery id an attacker might pick — including none at
  // all. The HMAC still verifies, because the header is not in it, so the only
  // thing standing between this and an unbounded dispatch amplifier is that
  // the key does not read the header.
  const fake = fakeStore({ rows: [endpoint()] });
  const admit = createInboundAdmission({ store: fake.store, keyring: () => keyring });
  expect((await admit(request())).outcome).toBe("accepted");
  for (const spoofed of ["atl-delivery-2", "atl-delivery-3", undefined, ""]) {
    expect((await admit(request({ "x-atlassian-webhook-identifier": spoofed }))).outcome)
      .toBe("duplicate");
  }
  const keys = new Set(fake.recorded.map((input) => input.idempotencyKey));
  expect(keys.size).toBe(1);
  // The replayed ids are still RETAINED — they are correlation material, and
  // suppressing them would lose the evidence that a replay happened.
  expect(fake.recorded[1]?.unsignedProviderDeliveryId).toBe("atl-delivery-2");
});

test("one unsigned id reused across distinct valid bodies suppresses nothing", async () => {
  // The mirror failure: an attacker who learns a delivery id can no longer
  // pre-burn it so that the tenant never sees the real event under it.
  const fake = fakeStore({ rows: [endpoint()] });
  const admit = createInboundAdmission({ store: fake.store, keyring: () => keyring });
  const deleted = Buffer.from('{ "webhookEvent": "user_deleted", "user": { "accountId": "a1" } }');
  const renamed = Buffer.from('{ "webhookEvent": "user_updated", "user": { "accountId": "a1" } }');
  for (const body of [BODY, deleted, renamed]) {
    expect((await admit(request({ "x-atlassian-webhook-identifier": "atl-reused" }, body))).outcome)
      .toBe("accepted");
  }
  expect(new Set(fake.recorded.map((input) => input.idempotencyKey)).size).toBe(3);
});

test("a spoofed event-type header never becomes the delivery's event name", async () => {
  const fake = fakeStore({ rows: [endpoint()] });
  const admit = createInboundAdmission({ store: fake.store, keyring: () => keyring });
  await admit(request({ "x-atlassian-webhook-event": "user_deleted" }));
  // The body says `user_created` and the body is what was signed. The header's
  // claim is kept, clearly separated, and decides nothing.
  expect(fake.recorded[0]?.eventType).toBe("user_created");
  expect(fake.recorded[0]?.unsignedEventType).toBe("user_deleted");

  // A registration that declares no signed path gets NO event name at all,
  // rather than silently falling back to the header it also declared.
  const headerOnly = fakeStore({
    rows: [endpoint({ identity: normalizeInboundIdentity({ source: "body-digest" })! })],
  });
  const second = createInboundAdmission({ store: headerOnly.store, keyring: () => keyring });
  await second(request({ "x-atlassian-webhook-event": "user_deleted" }));
  expect(headerOnly.recorded[0]?.eventType).toBeNull();
  expect(headerOnly.recorded[0]?.unsignedEventType).toBe("user_deleted");
});

test("a signed-field identity keys distinct events apart and retries together", async () => {
  // Jira's authenticated event identity: the event name, its own timestamp and
  // the issue, all inside the body it signed.
  const fake = fakeStore({
    rows: [endpoint({
      identity: normalizeInboundIdentity({
        source: "body-field", fields: ["webhookEvent", "timestamp", "issue.id"],
        eventTypePath: "webhookEvent",
      })!,
    })],
  });
  const admit = createInboundAdmission({ store: fake.store, keyring: () => keyring });
  const event = (timestamp: number, extra: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
    timestamp, webhookEvent: "jira:issue_updated", issue: { id: "10021" }, ...extra,
  }));
  expect((await admit(request({}, event(1)))).outcome).toBe("accepted");
  // Different bytes, same signed identity: the provider's own retry.
  expect((await admit(request({}, event(1, { retryHint: "second attempt" })))).outcome)
    .toBe("duplicate");
  // A later change to the same issue is a distinct event and is kept.
  expect((await admit(request({}, event(2)))).outcome).toBe("accepted");
  expect(fake.recorded[0]?.eventType).toBe("jira:issue_updated");

  // An authentic body missing a declared identity path is refused rather than
  // keyed on a stand-in — and logged, because the profile and the payload
  // disagree.
  const broken = admission({
    rows: [endpoint({
      identity: normalizeInboundIdentity({ source: "body-field", fields: ["issue.id"] })!,
    })],
  });
  expect(await broken.admit(request({}, Buffer.from('{ "webhookEvent": "x" }'))))
    .toEqual({ outcome: "rejected" });
  expect(broken.logged).toContain("INBOUND_IDENTITY_UNREADABLE");
  expect(broken.journal).not.toContain("write");
});

test("the delivery key is derived from signed material and nothing else", () => {
  const bodyHash = "a".repeat(64);
  // There is no parameter for a header value: `inboundDeliveryKey` cannot be
  // handed one, which is the structural half of the guarantee above.
  expect(inboundDeliveryKey.length).toBe(2);
  // The adversarial case for domain separation: a declared field whose value is
  // exactly the body digest.
  expect(inboundDeliveryKey(ENDPOINT, `f:${JSON.stringify([["id", bodyHash]])}`))
    .not.toBe(inboundDeliveryKey(ENDPOINT, `b:${bodyHash}`));
  // Stable across retries, endpoint-scoped, and header-safe, because the
  // broker sends it as one.
  const key = inboundDeliveryKey(ENDPOINT, `b:${bodyHash}`);
  expect(key).toBe(inboundDeliveryKey(ENDPOINT, `b:${bodyHash}`));
  expect(key).not.toBe(inboundDeliveryKey(OWNER, `b:${bodyHash}`));
  expect(new Headers({ "idempotency-key": key }).get("idempotency-key")).toBe(key);
  expect(key).toMatch(/^inbound\.[0-9a-f-]{36}\.[0-9a-f]{64}$/);
});

test("a write that cannot commit is never reported as accepted", async () => {
  const { admit, journal, logged } = admission({ rows: [endpoint()], failWrite: true });
  expect(await admit(request())).toEqual({ outcome: "unavailable" });
  // `commit` is absent: the receipt and its work were both lost, which is what
  // the caller is told — so the provider retries rather than assuming delivery.
  expect(journal).toEqual(["lookup", `open:${TENANT}`, "read", "write"]);
  expect(logged).toContain("INBOUND_PERSIST_FAILED");
});

test("a host that cannot verify says so instead of refusing deliveries", async () => {
  const fake = fakeStore({ rows: [endpoint()] });
  const logged: string[] = [];
  const admit = createInboundAdmission({
    store: fake.store, keyring: () => undefined, log: (event) => logged.push(event.code),
  });
  expect(await admit(request())).toEqual({ outcome: "unavailable" });
  // Said BEFORE the lookup, so the answer discloses nothing about registrations.
  expect(fake.journal).toEqual([]);
  expect(logged).toEqual(["INBOUND_KEYRING_MISSING"]);

  const broken = admission({ rows: [endpoint()], failLookup: true });
  expect(await broken.admit(request())).toEqual({ outcome: "unavailable" });
  expect(broken.logged).toContain("INBOUND_LOOKUP_FAILED");
});

test("a secret sealed for another row cannot be opened, and that is an ordinary refusal", async () => {
  const moved = endpoint({
    // The ciphertext of the SAME secret, bound to a different endpoint id:
    // the AAD is what refuses it, not a comparison of the plaintext.
    storedSecret: encryptSecret(keyring, `${TENANT}:${OTHER_TENANT}`, INBOUND_SECRET_FIELD, SECRET),
  });
  const { admit, logged, journal } = admission({ rows: [moved] });
  expect(await admit(request())).toEqual({ outcome: "rejected" });
  expect(logged).toContain("INBOUND_SECRET_UNREADABLE");
  expect(journal).not.toContain("write");
});

test("malformed addressing and over-sized bodies are refused before any I/O", async () => {
  const { admit, journal } = admission({ rows: [endpoint()] });
  for (const endpointId of ["", "not-a-uuid", `${ENDPOINT}x`]) {
    expect((await admit({ ...request(), endpointId })).outcome).toBe("rejected");
  }
  for (const endpointKey of ["", "Jira-Admin", "jira admin", "a".repeat(65), ".jira"]) {
    expect((await admit({ ...request(), endpointKey })).outcome).toBe("rejected");
  }
  const large = Buffer.alloc(INBOUND_MAX_BODY_BYTES + 1, 3);
  expect((await admit(request({}, large))).outcome).toBe("rejected");
  expect(journal).toEqual([]);
});

test("metadata headers are bounded and never carry control characters into the envelope", async () => {
  const fake = fakeStore({ rows: [endpoint()] });
  const admit = createInboundAdmission({ store: fake.store, keyring: () => keyring });
  await admit(request({
    "x-atlassian-webhook-identifier": "x".repeat(201),
    "x-atlassian-webhook-event": "user_created\nx-injected: true",
  }));
  expect(fake.recorded[0]?.unsignedProviderDeliveryId).toBeNull();
  expect(fake.recorded[0]?.unsignedEventType).toBeNull();
  // The signed event name is unaffected: it never came from a header.
  expect(fake.recorded[0]?.eventType).toBe("user_created");
});

test("a host that can verify but not seal the payload reports its own problem", async () => {
  const fake = fakeStore({ rows: [endpoint()] });
  const logged: string[] = [];
  // A keyring whose active key is absent: `encryptSecret` throws. The delivery
  // is genuine, so refusing it as `rejected` would tell the provider to stop
  // retrying something the host simply could not keep.
  const admit = createInboundAdmission({
    store: fake.store,
    keyring: () => ({ activeKeyId: "missing", keys: keyring.keys }),
    log: (event) => logged.push(event.code),
  });
  expect(await admit(request())).toEqual({ outcome: "unavailable" });
  expect(logged).toContain("INBOUND_BODY_SEAL_FAILED");
  expect(fake.recorded).toHaveLength(0);
});
