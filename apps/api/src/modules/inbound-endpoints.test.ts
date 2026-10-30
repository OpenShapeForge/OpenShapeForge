// SPDX-License-Identifier: BUSL-1.1
/**
 * The registration surface: who may register, what a registration may say, and
 * what comes back.
 *
 * The negatives carry the weight, and the heaviest of them is authorization. A
 * registration says "these bytes make the organization's service identity run
 * that Operation", so this surface must refuse a machine principal, a session
 * without the integration-administration capability, and an Operation the
 * caller could not invoke itself — on top of refusing another tenant, a
 * downgraded hash, a raised body ceiling and any read of the secret.
 */
import { expect, test } from "bun:test";
import type {
  RuntimeInboundEndpointRegistration, RuntimeOperationDefinition,
} from "@openshapeforge/plugin-runtime";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { API_KEY_MANAGE_ROLE } from "../auth/api-key/ceiling.js";
import { CONNECTOR_ADMIN_ROLE, CONNECTOR_READER_ROLE } from "../connectors/authorization.js";
import { decryptSecret, keyringFromEnv } from "../platform/secrets.js";
import { INBOUND_MAX_BODY_BYTES } from "../platform/inbound-signature.js";
import { INBOUND_SECRET_FIELD } from "./inbound-admission.js";
import { serializeInboundIdentityFields } from "./inbound-identity.js";
import { createInboundEndpointServices, normalizeInboundRegistration } from "./inbound-endpoints.js";
import {
  endpointSummaryOf, type EndpointRow, type EndpointSummary, type InsertEndpointInput,
} from "./inbound-store.js";

const keyring = keyringFromEnv(`test:${Buffer.alloc(32, 4).toString("base64")}`)!;
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000d4";
const SECRET = "synthetic-unit-fixture-inbound-secret-0123456789";
const OPERATION = "integrations.jira.receiveAdminEvent";

/** What production hands this surface: a person, holding the integration role. */
const session = {
  tenantId: TENANT, userId: USER, credential: "bearer", principalKind: "person",
  roles: [CONNECTOR_ADMIN_ROLE], groups: [], scope: "tenant",
} as unknown as TrustedSessionContext;

/** Keyed, as the durable broker requires, with a distinct key input field. */
const operation = {
  id: OPERATION, intent: "receiveAdminEvent", name: "Receive", description: "",
  input: {}, output: {},
  effects: { data: "write", external: "none" },
  reliability: { idempotency: { mode: "keyed", inputField: "idempotencyKey" } },
} as unknown as RuntimeOperationDefinition;

const registration: RuntimeInboundEndpointRegistration = {
  endpointKey: "jira-admin",
  signature: { header: "X-Hub-Signature", algorithm: "sha256", encoding: "hex", prefix: "sha256=" },
  secret: SECRET,
  identity: { source: "body-digest", eventTypePath: "webhookEvent" },
  unsignedHeaders: {
    deliveryId: "X-Atlassian-Webhook-Identifier",
    eventType: "X-Atlassian-Webhook-Event",
  },
  dispatch: { operationId: OPERATION, inputField: "delivery" },
};

/** The row the store would have written, projected the way the store projects it. */
function rowOf(input: InsertEndpointInput): EndpointSummary {
  return endpointSummaryOf({
    id: input.id, tenant_id: input.tenantId, endpoint_key: input.endpointKey,
    signature_header: input.signature.header, signature_algorithm: input.signature.algorithm,
    signature_encoding: input.signature.encoding, signature_prefix: input.signature.prefix ?? null,
    identity_source: input.identity.source,
    identity_fields: serializeInboundIdentityFields(input.identity.fields),
    identity_event_type_path: input.identity.eventTypePath,
    unsigned_delivery_id_header: input.unsignedHeaders.deliveryId,
    unsigned_event_type_header: input.unsignedHeaders.eventType,
    max_body_bytes: input.maxBodyBytes, secret_ciphertext: input.storedSecret.ciphertext,
    secret_key_id: input.storedSecret.keyId, secret_algorithm: input.storedSecret.algorithm,
    service_identity_id: input.serviceIdentityId, operation_id: input.dispatch.operationId,
    operation_input_field: input.dispatch.inputField, status: "active", created_by: input.createdBy,
    created_at: "2026-10-30T10:00:00.000Z", revoked_at: null, revoked_reason: null,
  } satisfies EndpointRow);
}

type ServiceOverrides = {
  serviceIdentity?: () => string | undefined;
  /** Default mirrors production: only THIS live capability object is accepted. */
  acceptsSession?: (session: TrustedSessionContext) => boolean;
  /** Core's authorization-checked catalog lookup, as the caller sees it. */
  resolveOperation?: (
    session: TrustedSessionContext, operationId: string,
  ) => Promise<RuntimeOperationDefinition | undefined>;
};

function services(overrides: ServiceOverrides = {}) {
  const inserted: InsertEndpointInput[] = [];
  const revoked: { id: string; reason: string | null }[] = [];
  const resolved: { operationId: string; roles: readonly string[] }[] = [];
  return {
    inserted, revoked, resolved,
    api: createInboundEndpointServices({
      acceptsSession: overrides.acceptsSession ?? ((candidate) => candidate === session),
      serviceIdentity: overrides.serviceIdentity ?? (() => "fixture-service-identity"),
      resolveOperation: overrides.resolveOperation ?? (async (candidate, operationId) => {
        resolved.push({ operationId, roles: candidate.roles });
        return operationId === OPERATION ? operation : undefined;
      }),
      keyring,
      store: {
        insert: async (_session, input) => { inserted.push(input); return rowOf(input); },
        revoke: async (_session, input) => {
          revoked.push(input);
          const first = inserted[0];
          if (!first) return undefined;
          return {
            ...rowOf(first), status: "revoked" as const,
            revokedAt: "2026-10-30T11:00:00.000Z", revokedReason: input.reason,
          };
        },
        list: async () => inserted.map(rowOf),
      },
    }),
  };
}

test("a live tenant session registers an endpoint and gets back its public path, never the secret", async () => {
  const { api, inserted } = services();
  const endpoint = await api.register(session, registration);
  expect(endpoint.tenantId).toBe(TENANT);
  expect(endpoint.path).toBe(`/api/inbound/jira-admin/${endpoint.id}`);
  expect(endpoint.status).toBe("active");
  // Header names arrive as HTTP actually delivers them: lowercase.
  expect(endpoint.signature.header).toBe("x-hub-signature");
  expect(endpoint.unsignedHeaders.deliveryId).toBe("x-atlassian-webhook-identifier");
  expect(endpoint.identity).toEqual({ source: "body-digest", eventTypePath: "webhookEvent" });
  // Nothing in the answer, or in anything stored, is the plaintext.
  expect(JSON.stringify(endpoint)).not.toContain(SECRET);
  expect(JSON.stringify(inserted[0])).not.toContain(SECRET);
  // There is no read API at all; the only way back is the host keyring, and
  // the AAD binds the ciphertext to this exact tenant and endpoint.
  expect(decryptSecret(keyring, `${TENANT}:${endpoint.id}`, INBOUND_SECRET_FIELD, inserted[0]!.storedSecret)).toBe(SECRET);
  expect(() => decryptSecret(keyring, `${TENANT}:${USER}`, INBOUND_SECRET_FIELD, inserted[0]!.storedSecret)).toThrow();
  // The registering user is recorded as provenance; the dispatch identity is
  // the organization's, and is not a value the plugin supplied.
  expect(inserted[0]?.createdBy).toBe(USER);
  expect(inserted[0]?.serviceIdentityId).toBe("fixture-service-identity");
});

test("registration requires a live verified tenant session and never a grant", async () => {
  // The live-capability fence alone would refuse every object below, so it is
  // opened here: what is being proved is that the session's OWN fields are
  // checked too, and a capability grant is refused by name.
  const { api, inserted } = services({ acceptsSession: () => true });
  for (const candidate of [
    { ...session, tenantId: null },
    { ...session, userId: null },
    { ...session, credential: "grant" },
    { ...session, tenantId: "not-a-uuid" },
    { ...session, userId: "not-a-uuid" },
  ] as TrustedSessionContext[]) {
    await expect(api.register(candidate, registration)).rejects.toThrow(/live verified|verified tenant and user/);
  }
  expect(inserted).toHaveLength(0);

  // And the fence itself still refuses a session object core did not mint.
  const fenced = services();
  await expect(fenced.api.register({ ...session } as TrustedSessionContext, registration))
    .rejects.toThrow(/live verified/);
});

test("only a session the deployment classified as a PERSON may configure an endpoint", async () => {
  // The ladder this closes: a machine principal holding the integration role
  // registers a webhook pointing at an Operation only the service identity may
  // run, then triggers it. The carrier is checked before any role, so a service
  // principal holding every role does not learn that roles were consulted.
  const { api, inserted, resolved } = services({ acceptsSession: () => true });
  for (const candidate of [
    { ...session, principalKind: "service" },
    // Absence proves nothing and is refused: a trusted-context bundle from a
    // producer that signs no principal class reaches this surface never.
    { ...session, principalKind: undefined },
    { ...session, credential: "api-key", principalKind: "person" },
    { ...session, credential: "control-bearer", principalKind: "person" },
  ] as TrustedSessionContext[]) {
    await expect(api.register(candidate, registration)).rejects.toThrow(/verified person/);
    await expect(api.revoke(candidate, { id: USER })).rejects.toThrow(/verified person/);
    await expect(api.list(candidate)).rejects.toThrow(/verified person/);
  }
  expect(inserted).toHaveLength(0);
  // Nothing was even resolved: the refusal precedes the catalog lookup.
  expect(resolved).toHaveLength(0);
});

test("every surface requires the canonical integration-administration capability", async () => {
  const { api, inserted } = services({ acceptsSession: () => true });
  for (const roles of [
    [],
    [CONNECTOR_READER_ROLE],
    // Reading the catalog is not administering it, and neither is holding an
    // unrelated platform role — no ad hoc inbound role is accepted in place of
    // the established one.
    [API_KEY_MANAGE_ROLE],
    ["Platform.Inbound.Manage"],
  ]) {
    const candidate = { ...session, roles } as unknown as TrustedSessionContext;
    await expect(api.register(candidate, registration)).rejects.toThrow(/administer connectors/);
    await expect(api.revoke(candidate, { id: USER })).rejects.toThrow(/administer connectors/);
    await expect(api.list(candidate)).rejects.toThrow(/administer connectors/);
  }
  expect(inserted).toHaveLength(0);
});

test("a webhook can only be bound to an Operation this caller may itself invoke", async () => {
  // The escalation the binding closes: an integration administrator naming any
  // Operation id and having the organization's service identity run it. Core's
  // catalog lookup runs under the CALLER's session, so an Operation it may not
  // invoke does not resolve — and an unknown id answers identically, so the
  // surface is not a catalog oracle.
  const { api, inserted, resolved } = services();
  await expect(api.register(session, {
    ...registration, dispatch: { operationId: "platform.tenants.delete", inputField: "delivery" },
  })).rejects.toThrow(/may itself invoke/);
  expect(resolved.map((entry) => entry.operationId)).toEqual(["platform.tenants.delete"]);
  // The lookup was made with the caller's own roles, not a widened set.
  expect(resolved[0]?.roles).toEqual([CONNECTOR_ADMIN_ROLE]);
  expect(inserted).toHaveLength(0);

  // A lookup that throws is a refusal, not an exception that escapes as a
  // successful registration path.
  const broken = services({ resolveOperation: async () => { throw new Error("catalog down"); } });
  await expect(broken.api.register(session, registration)).rejects.toThrow(/may itself invoke/);
  expect(broken.inserted).toHaveLength(0);

  // And a provider answering a DIFFERENT Operation than the one asked for is
  // refused rather than silently bound to whatever came back.
  const mismatched = services({ resolveOperation: async () => operation });
  await expect(mismatched.api.register(session, {
    ...registration, dispatch: { operationId: "something.else", inputField: "delivery" },
  })).rejects.toThrow(/may itself invoke/);
  expect(mismatched.inserted).toHaveLength(0);
});

test("the bound Operation must be able to recognise a repeated delivery", async () => {
  const unkeyed = (idempotency: unknown) => services({
    resolveOperation: async () => ({
      ...operation, reliability: { idempotency },
    } as unknown as RuntimeOperationDefinition),
  });
  for (const idempotency of [
    { mode: "none" },
    { mode: "natural" },
    // Keyed in name only: without the input field the broker has no key to
    // bind, so such a registration would strand on its first worker crash.
    { mode: "keyed" },
    { mode: "keyed", inputField: "  " },
  ]) {
    const { api, inserted } = unkeyed(idempotency);
    await expect(api.register(session, registration)).rejects.toThrow(/idempotency\.mode: keyed/);
    expect(inserted).toHaveLength(0);
  }

  // And the envelope must not land on the Operation's own key field, where it
  // would overwrite the delivery key the broker just bound.
  const { api, inserted } = services();
  await expect(api.register(session, {
    ...registration, dispatch: { operationId: OPERATION, inputField: "idempotencyKey" },
  })).rejects.toThrow(/must differ/);
  expect(inserted).toHaveLength(0);
});

test("a registration cannot downgrade its hash, raise the body ceiling or invent a dispatch target", () => {
  expect(() => normalizeInboundRegistration({
    ...registration, signature: { ...registration.signature, algorithm: "sha1" as "sha256" },
  })).toThrow(/signature/);
  expect(() => normalizeInboundRegistration({ ...registration, endpointKey: "Jira Admin" })).toThrow(/endpointKey/);
  expect(() => normalizeInboundRegistration({ ...registration, secret: "too-short" })).toThrow(/secret/);
  expect(() => normalizeInboundRegistration({
    ...registration, unsignedHeaders: { deliveryId: "bad header" },
  })).toThrow(/unsignedHeaders\.deliveryId/);
  expect(() => normalizeInboundRegistration({
    ...registration, unsignedHeaders: { eventType: "Bad Header" },
  })).toThrow(/unsignedHeaders\.eventType/);
  // No identity source reads a header, so naming one is a refusal rather than
  // a configuration the host quietly honours.
  for (const identity of [
    { source: "header" },
    { source: "body-digest", fields: ["issue.id"] },
    { source: "body-field" },
    { source: "body-field", fields: ["__proto__"] },
    { source: "body-digest", eventTypePath: "not a path" },
  ]) {
    expect(() => normalizeInboundRegistration({
      ...registration, identity: identity as never,
    })).toThrow(/identity/);
  }
  // An ABSENT identity is the documented default. Spelled as a missing
  // property rather than `identity: undefined`, which the public contract
  // declares optional and therefore does not accept as an explicit value — the
  // registration a plugin author actually writes is the one under test.
  const { identity: _identity, ...withoutIdentity } = registration;
  expect(normalizeInboundRegistration(withoutIdentity).identity)
    .toEqual({ source: "body-digest", fields: [], eventTypePath: null });
  expect(() => normalizeInboundRegistration({
    ...registration, dispatch: { operationId: "", inputField: "delivery" },
  })).toThrow(/dispatch/);
  expect(() => normalizeInboundRegistration({
    ...registration, dispatch: { operationId: "x.y", inputField: "not a field" },
  })).toThrow(/dispatch/);
  expect(() => normalizeInboundRegistration({ ...registration, maxBodyBytes: 0 })).toThrow(/maxBodyBytes/);
  // Lowered, never raised.
  expect(normalizeInboundRegistration({ ...registration, maxBodyBytes: 1024 }).maxBodyBytes).toBe(1024);
  expect(normalizeInboundRegistration({ ...registration, maxBodyBytes: INBOUND_MAX_BODY_BYTES * 8 }).maxBodyBytes)
    .toBe(INBOUND_MAX_BODY_BYTES);
});

test("an organization with no service identity cannot register an endpoint at all", async () => {
  const { api, inserted } = services({ serviceIdentity: () => undefined });
  // Refused now rather than accepting deliveries nothing could ever dispatch.
  await expect(api.register(session, registration)).rejects.toThrow(/service identity/);
  expect(inserted).toHaveLength(0);
});

test("revocation is idempotent, reason-bounded, and reports the current row", async () => {
  const { api, revoked } = services();
  const endpoint = await api.register(session, registration);
  const first = await api.revoke(session, { id: endpoint.id, reason: "Jira subscription removed" });
  expect(first.status).toBe("revoked");
  expect(first.revokedReason).toBe("Jira subscription removed");
  const again = await api.revoke(session, { id: endpoint.id });
  expect(again.status).toBe("revoked");
  expect(revoked).toHaveLength(2);
  await expect(api.revoke(session, { id: "not-a-uuid" })).rejects.toThrow();
  await expect(api.revoke(session, { id: endpoint.id, reason: "x".repeat(501) })).rejects.toThrow();
});

test("listing is tenant-scoped by the session and filters on a well-formed key", async () => {
  const { api } = services();
  await api.register(session, registration);
  expect((await api.list(session)).map((entry) => entry.endpointKey)).toEqual(["jira-admin"]);
  expect(await api.list(session, { endpointKey: "jira-admin" })).toHaveLength(1);
  await expect(api.list(session, { endpointKey: "Jira Admin" })).rejects.toThrow(/endpointKey/);
});
