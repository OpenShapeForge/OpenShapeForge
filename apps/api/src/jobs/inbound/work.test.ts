// SPDX-License-Identifier: BUSL-1.1
/**
 * Opening a sealed delivery payload, and the envelope the Operation receives.
 *
 * The claim fence and the live-endpoint recheck are SQL and are proved against
 * a real database (db/__tests__/inbound-deliveries.test.ts). What is answerable
 * here is the part a database cannot be asked to fail on demand: that a payload
 * which cannot be opened produces a NAMED recovery error rather than an empty
 * dispatch, and that the error says whether retrying could ever help.
 */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DurableAuthorityError } from "../../operations/durable-worker.js";
import { INBOUND_BODY_FIELD, inboundBodyScope } from "../../modules/inbound-admission.js";
import { encryptSecret, keyringFromEnv } from "../../platform/secrets.js";
import { inboundDeliveryEnvelope, openInboundDeliveryBody, type DeliveryWorkRow } from "./work.js";

const keyring = keyringFromEnv(`work-test:${Buffer.alloc(32, 7).toString("base64")}`)!;
const other = keyringFromEnv(`work-test:${Buffer.alloc(32, 8).toString("base64")}`)!;
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000b2";
const ENDPOINT = "00000000-0000-4000-8000-0000000000c3";
const DELIVERY = "00000000-0000-4000-8000-0000000000e5";
const BODY = Buffer.from('{ "webhookEvent": "jira:issue_updated", "issue": { "id": "10021" } }');

function row(overrides: Partial<DeliveryWorkRow> = {}): DeliveryWorkRow {
  const tenantId = overrides.tenant_id ?? TENANT;
  const endpointId = overrides.endpoint_id ?? ENDPOINT;
  const id = overrides.id ?? DELIVERY;
  const sealed = encryptSecret(
    keyring, inboundBodyScope(tenantId, endpointId, id), INBOUND_BODY_FIELD,
    BODY.toString("base64"),
  );
  return {
    id, tenant_id: tenantId, endpoint_id: endpointId, endpoint_key: "jira-admin",
    service_identity_id: "fixture-service-identity",
    operation_id: "integrations.jira.receiveAdminEvent", operation_input_field: "delivery",
    idempotency_key: `inbound.${endpointId}.${"a".repeat(64)}`,
    event_type: "jira:issue_updated",
    unsigned_provider_delivery_id: "atl-delivery-1",
    unsigned_event_type: "jira:issue_deleted",
    body_sha256: "b".repeat(64), body_ciphertext: sealed.ciphertext,
    body_key_id: sealed.keyId, body_algorithm: sealed.algorithm, body_purged_at: null,
    received_at: "2026-10-30T10:00:00.000Z", contract_fingerprint: null,
    dispatch_attempt: null, dispatch_state: "none",
    ...overrides,
  };
}

function authority(work: () => void): DurableAuthorityError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DurableAuthorityError);
    return error as DurableAuthorityError;
  }
  throw new Error("expected the payload to be refused");
}

test("the payload opens under the row's own tenant, endpoint and receipt", () => {
  expect(Buffer.from(openInboundDeliveryBody(keyring, row()), "base64").equals(BODY)).toBe(true);
});

test("a ciphertext lifted onto another row does not open, and says so terminally", () => {
  const sealed = row();
  for (const moved of [
    { ...sealed, tenant_id: OTHER_TENANT },
    { ...sealed, endpoint_id: randomUUID() },
    { ...sealed, id: randomUUID() },
  ]) {
    const error = authority(() => openInboundDeliveryBody(keyring, moved));
    expect(error.code).toBe("INBOUND_BODY_UNREADABLE");
    // Terminal: no retry turns a wrong scope into the right one, and retrying
    // forever would hide the tampering rather than report it.
    expect(error.retryable).toBe(false);
    // The message carries no ciphertext, no key id and no payload.
    expect(error.message).not.toContain(sealed.body_ciphertext!);
    expect(error.message).not.toContain("10021");
  }
});

test("a key this host no longer holds is a terminal, named recovery error", () => {
  const error = authority(() => openInboundDeliveryBody(other, row()));
  expect(error.code).toBe("INBOUND_BODY_UNREADABLE");
  expect(error.retryable).toBe(false);
});

test("no keyring at all is RETRYABLE: the host is misconfigured, not the row", () => {
  const error = authority(() => openInboundDeliveryBody(undefined, row()));
  expect(error.code).toBe("INBOUND_BODY_KEY_UNAVAILABLE");
  // Restoring the key makes this very attempt succeed, so the delivery stays
  // open rather than being settled as failed.
  expect(error.retryable).toBe(true);
});

test("a payload retention removed is refused, never dispatched as an empty body", () => {
  const purged = row({
    body_ciphertext: null, body_key_id: null, body_algorithm: null,
    body_purged_at: "2026-11-30T10:00:00.000Z",
  });
  const error = authority(() => openInboundDeliveryBody(keyring, purged));
  expect(error.code).toBe("INBOUND_BODY_PURGED");
  expect(error.retryable).toBe(false);
  // A half-purged row — the shape a failed purge would leave — is refused too,
  // rather than decrypting a ciphertext whose key columns are gone.
  expect(authority(() => openInboundDeliveryBody(keyring, row({ body_key_id: null }))).code)
    .toBe("INBOUND_BODY_PURGED");
});

test("the envelope separates the signed event name from the unsigned headers", () => {
  const envelope = inboundDeliveryEnvelope(row(), BODY.toString("base64"));
  // The body said `jira:issue_updated`; the header claimed a deletion.
  expect(envelope.eventType).toBe("jira:issue_updated");
  expect(envelope.unsigned).toEqual({
    providerDeliveryId: "atl-delivery-1", eventType: "jira:issue_deleted",
  });
  // There is no top-level `providerDeliveryId` a consumer could mistake for
  // authenticated material.
  expect(Object.hasOwn(envelope, "providerDeliveryId")).toBe(false);
  expect(Buffer.from(envelope.body, "base64").equals(BODY)).toBe(true);
  // No registration internals and no ciphertext reach a plugin.
  const serialized = JSON.stringify(envelope);
  expect(serialized).not.toContain(row().body_ciphertext!);
  expect(serialized).not.toContain("service-identity");
});
