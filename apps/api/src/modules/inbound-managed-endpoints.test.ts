// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { RuntimeConnectionResolution, RuntimeInboundConnectionRegistration, RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { keyringFromEnv } from "../platform/secrets.js";
import { createInboundEndpointServices } from "./inbound-endpoints.js";
import { endpointSummaryOf, type EndpointRow, type InsertEndpointInput } from "./inbound-store.js";
import { serializeInboundIdentityFields } from "./inbound-identity.js";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000a2";
const CONNECTION = "00000000-0000-4000-8000-0000000000a3";
const SECRET = "synthetic-signing-secret-only-for-unit-tests";
const session = { tenantId: TENANT, userId: USER, credential: "bearer", principalKind: "service", organizationServiceIdentityId: "configured-service", roles: ["Platform.InboundEndpointManage"], groups: [], scope: "tenant" } as TrustedSessionContext;
const registration: RuntimeInboundConnectionRegistration = {
  connectionId: CONNECTION, secretField: "webhookSigningSecret", endpointKey: "jira-cloud",
  signature: { header: "x-hub-signature", algorithm: "sha256", encoding: "hex", prefix: "sha256=" },
  identity: { source: "body-digest", eventTypePath: "webhookEvent" },
  dispatch: { operationId: "integration.receive", inputField: "delivery" },
  idempotencyKey: "reconcile.test", expect: { endpointStatus: "inactive", endpointId: null },
};
function fixture(overrides: { active?: boolean; connection?: RuntimeConnectionResolution; authorized?: boolean } = {}) {
  let row: EndpointRow | undefined;
  const inserts: InsertEndpointInput[] = [];
  const connection = overrides.connection ?? { ok: true, connection: { connectionId: CONNECTION, adapterKey: "jira-cloud", connectionKey: "jira", transport: "rest", connectionScope: "tenant", ownerUserId: null, values: { webhookSigningSecret: SECRET }, secretKeys: ["webhookSigningSecret"], egressGrant: {} as never } };
  const api = createInboundEndpointServices({
    acceptsSession: () => true,
    serviceIdentity: () => "configured-service",
    resolveOperation: async (_session, id) => overrides.authorized === false ? undefined : ({ id, reliability: { idempotency: { mode: "keyed", inputField: "key" } } } as RuntimeOperationDefinition),
    keyring: keyringFromEnv(`test:${Buffer.alloc(32, 4).toString("base64")}`)!,
    store: { insert: async () => { throw new Error("wrong store"); }, revoke: async () => undefined, list: async () => [] },
    managed: {
      activeTransaction: () => overrides.active !== false,
      connection: async () => connection,
      find: async (_session, key) => row?.registration_key === key ? row : undefined,
      findConnection: async (_session, input) => row?.id === input.id && row.connection_id === input.connectionId ? row : undefined,
      insert: async (_session, input) => {
        inserts.push(input);
        row = { id: input.id, tenant_id: input.tenantId, endpoint_key: input.endpointKey,
          connection_id: input.connectionId!, connection_secret_field: input.connectionSecretField!, registration_key: input.registrationKey!,
          signature_header: input.signature.header, signature_algorithm: input.signature.algorithm,
          signature_encoding: input.signature.encoding, signature_prefix: input.signature.prefix ?? null,
          identity_source: input.identity.source, identity_fields: serializeInboundIdentityFields(input.identity.fields),
          identity_event_type_path: input.identity.eventTypePath, unsigned_delivery_id_header: input.unsignedHeaders.deliveryId,
          unsigned_event_type_header: input.unsignedHeaders.eventType, max_body_bytes: input.maxBodyBytes,
          secret_ciphertext: input.storedSecret.ciphertext, secret_key_id: input.storedSecret.keyId,
          secret_algorithm: input.storedSecret.algorithm, service_identity_id: input.serviceIdentityId,
          operation_id: input.dispatch.operationId, operation_input_field: input.dispatch.inputField,
          status: "active", created_by: input.createdBy, created_at: new Date(), revoked_at: null, revoked_reason: null };
        return endpointSummaryOf(row);
      },
      revoke: async (_session, input) => row && row.id === input.id && row.connection_id === input.connectionId ? { ...endpointSummaryOf(row), status: "revoked", revokedAt: new Date().toISOString() } : undefined,
    },
  });
  return { api, inserts };
}

test("managed registration resolves a confidential Connection field and never exposes it", async () => {
  const { api, inserts } = fixture();
  const first = await api.registerForConnection(session, registration);
  const again = await api.registerForConnection(session, registration);
  expect(again.id).toBe(first.id);
  expect(inserts).toHaveLength(1);
  expect(await api.connectionIsCurrent(session, { connectionId: CONNECTION, endpointId: first.id })).toBe(true);
  expect(await api.connectionIsCurrent(session, { connectionId: USER, endpointId: first.id })).toBe(false);
  expect(JSON.stringify(first)).not.toContain(SECRET);
  expect(JSON.stringify(inserts)).not.toContain(SECRET);
  await expect(api.registerForConnection(session, { ...registration, maxBodyBytes: 32 })).rejects.toThrow(/different Connection/);
  await expect(api.revokeForConnection(session, { connectionId: USER, endpointId: first.id, idempotencyKey: "pause", expect: { endpointId: first.id, endpointStatus: "active" } })).rejects.toThrow();
  const revoked = await api.revokeForConnection(session, { connectionId: CONNECTION, endpointId: first.id, idempotencyKey: "pause", expect: { endpointId: first.id, endpointStatus: "active" } });
  expect(revoked.status).toBe("revoked");
});

test("managed registration requires a live exact service session, transaction and dispatch permission", async () => {
  for (const change of [
    { credential: "api-key" }, { principalKind: "person" }, { organizationServiceIdentityId: "other" },
    { roles: [] }, { tenantId: "other" },
  ]) {
    const { api } = fixture();
    await expect(api.registerForConnection({ ...session, ...change } as TrustedSessionContext, registration)).rejects.toThrow();
  }
  await expect(fixture({ active: false }).api.registerForConnection(session, registration)).rejects.toThrow(/transaction/);
  await expect(fixture({ authorized: false }).api.registerForConnection(session, registration)).rejects.toThrow(/may itself invoke/);
});

test("managed registration refuses another Connection, provider and non-secret field", async () => {
  const good = { connectionId: CONNECTION, adapterKey: "jira-cloud", connectionKey: "jira", transport: "rest", connectionScope: "tenant" as const, ownerUserId: null, values: { webhookSigningSecret: SECRET }, secretKeys: ["webhookSigningSecret"], egressGrant: {} as never };
  for (const connection of [{ ...good, connectionId: USER }, { ...good, adapterKey: "different" }, { ...good, secretKeys: [] }]) {
    await expect(fixture({ connection: { ok: true, connection } }).api.registerForConnection(session, registration)).rejects.toThrow(/not available/);
  }
});


test("secret rotation or Connection removal refuses later delivery without exposing the secret", async () => {
  const connection: RuntimeConnectionResolution = { ok: true, connection: { connectionId: CONNECTION, adapterKey: "jira-cloud", connectionKey: "jira", transport: "rest", connectionScope: "tenant", ownerUserId: null, values: { webhookSigningSecret: SECRET }, secretKeys: ["webhookSigningSecret"], egressGrant: {} as never } };
  const { api } = fixture({ connection });
  const endpoint = await api.registerForConnection(session, registration);
  expect(await api.connectionIsCurrent(session, { connectionId: CONNECTION, endpointId: endpoint.id })).toBe(true);
  (connection.connection.values as Record<string, string>).webhookSigningSecret = "synthetic-different-rotated-secret-value";
  expect(await api.connectionIsCurrent(session, { connectionId: CONNECTION, endpointId: endpoint.id })).toBe(false);
  connection.connection.secretKeys = [];
  expect(await api.connectionIsCurrent(session, { connectionId: CONNECTION, endpointId: endpoint.id })).toBe(false);
  (connection as { ok: boolean }).ok = false;
  expect(await api.connectionIsCurrent(session, { connectionId: CONNECTION, endpointId: endpoint.id })).toBe(false);
});
