// SPDX-License-Identifier: BUSL-1.1
/**
 * Every statement that touches platform.inbound_endpoints and
 * platform.inbound_deliveries.
 *
 * Nothing here decides anything. Admission's order of steps is in
 * inbound-admission.ts; this file is the Postgres half of its store port, and
 * the registration reads and writes a live tenant session makes.
 *
 * Two sessions, deliberately different:
 *
 *  - `withCredentialResolutionSession` for admission. A tenant, no user —
 *    the one caller that cannot have one, because the identity is what it is
 *    trying to establish. Strictly narrower than a bypass: RLS stays on and the
 *    tenant GUC is set, so the callback sees exactly one tenant's rows. The
 *    tenant comes from `app.inbound_endpoint_tenant`, a point lookup, never
 *    from the request.
 *  - `withDbSession` for registration, revocation and listing, which always
 *    happen inside a live verified tenant session.
 *
 * `recordDelivery` is the atomicity promise of the port: the receipt row and
 * the platform.jobs row that will dispatch it are inserted in ONE transaction.
 * A duplicate is an `on conflict do nothing` that returns the earlier row —
 * the earlier delivery is the truth, whatever became of it, which is the whole
 * point of a delivery key.
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withCredentialResolutionSession, withDbSession } from "../db/session.js";
import { enqueueJob } from "../jobs/store.js";
import type { DB } from "../generated/db/types.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { INBOUND_DISPATCH_KIND } from "../jobs/inbound/kind.js";
import type {
  InboundAdmissionEndpoint, InboundAdmissionStore, InboundAdmissionTransaction,
  RecordInboundDeliveryInput,
} from "./inbound-admission.js";
import {
  DEFAULT_INBOUND_IDENTITY, serializeInboundIdentityFields, storedInboundIdentity,
  type InboundIdentityProfile,
} from "./inbound-identity.js";
import { boundInboundEndpointGateWait, inboundEndpointGateKey } from "./inbound-endpoint-gate.js";

/** The registration row, as every read in this file projects it. */
export type EndpointRow = {
  id: string;
  tenant_id: string;
  endpoint_key: string;
  signature_header: string;
  signature_algorithm: string;
  signature_encoding: string;
  signature_prefix: string | null;
  identity_source: string;
  identity_fields: string | null;
  identity_event_type_path: string | null;
  unsigned_delivery_id_header: string | null;
  unsigned_event_type_header: string | null;
  max_body_bytes: number;
  secret_ciphertext: string;
  secret_key_id: string;
  secret_algorithm: string;
  service_identity_id: string;
  operation_id: string;
  operation_input_field: string;
  status: string;
  created_by: string;
  created_at: string | Date;
  revoked_at: string | Date | null;
  revoked_reason: string | null;
};

const ENDPOINT_COLUMNS = [
  "id", "tenant_id", "endpoint_key", "signature_header", "signature_algorithm",
  "signature_encoding", "signature_prefix", "identity_source", "identity_fields",
  "identity_event_type_path", "unsigned_delivery_id_header", "unsigned_event_type_header",
  "max_body_bytes", "secret_ciphertext", "secret_key_id", "secret_algorithm",
  "service_identity_id", "operation_id", "operation_input_field", "status",
  "created_by", "created_at", "revoked_at", "revoked_reason",
] as const;

/**
 * The stored signature envelope. The casts are the one place a row's text
 * columns become the bounded contract types; the database check constraints and
 * `normalizeInboundSignatureScheme` are what make them sound, and admission
 * normalises again before any HMAC runs.
 */
function signatureOf(row: EndpointRow): InboundAdmissionEndpoint["signature"] {
  return {
    header: row.signature_header,
    algorithm: row.signature_algorithm as InboundAdmissionEndpoint["signature"]["algorithm"],
    encoding: row.signature_encoding as InboundAdmissionEndpoint["signature"]["encoding"],
    ...(row.signature_prefix ? { prefix: row.signature_prefix } : {}),
  };
}

function unsignedHeadersOf(row: EndpointRow): { deliveryId: string | null; eventType: string | null } {
  return { deliveryId: row.unsigned_delivery_id_header, eventType: row.unsigned_event_type_header };
}

/**
 * The admission projection of a registration row, secret still sealed.
 *
 * `undefined` when the row's identity profile no longer normalises — a stored
 * source this host does not implement, or paths that are no longer paths.
 * Admission refuses such a row rather than guessing how its deliveries are
 * identified, because every guess available here is one of the two failures
 * inbound-identity.ts exists to prevent.
 */
export function endpointOf(row: EndpointRow): InboundAdmissionEndpoint | undefined {
  const identity = storedInboundIdentity(row);
  if (!identity) return undefined;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    endpointKey: row.endpoint_key,
    signature: signatureOf(row),
    storedSecret: {
      ciphertext: row.secret_ciphertext, keyId: row.secret_key_id, algorithm: row.secret_algorithm,
    },
    identity,
    unsignedHeaders: unsignedHeadersOf(row),
    maxBodyBytes: row.max_body_bytes,
    status: row.status === "active" ? "active" : "revoked",
    serviceIdentityId: row.service_identity_id,
    dispatch: { operationId: row.operation_id, inputField: row.operation_input_field },
    createdBy: row.created_by,
  };
}

export type EndpointSummary = {
  id: string; tenantId: string; endpointKey: string;
  signature: InboundAdmissionEndpoint["signature"];
  identity: InboundIdentityProfile;
  unsignedHeaders: { deliveryId: string | null; eventType: string | null };
  dispatch: { operationId: string; inputField: string };
  maxBodyBytes: number; status: "active" | "revoked";
  createdAt: string; revokedAt: string | null; revokedReason: string | null;
};

/** What an owner may see: everything except the sealed secret and the identity. */
export function endpointSummaryOf(row: EndpointRow): EndpointSummary {
  return {
    id: row.id, tenantId: row.tenant_id, endpointKey: row.endpoint_key,
    signature: signatureOf(row),
    // A summary is a report, so a row whose profile no longer normalises is
    // shown as the default rather than hidden; admission is where an
    // unusable profile has to be a refusal.
    identity: storedInboundIdentity(row) ?? DEFAULT_INBOUND_IDENTITY,
    unsignedHeaders: unsignedHeadersOf(row),
    dispatch: { operationId: row.operation_id, inputField: row.operation_input_field },
    maxBodyBytes: row.max_body_bytes,
    status: row.status === "active" ? "active" : "revoked",
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    revokedReason: row.revoked_reason,
  };
}

export type InsertEndpointInput = {
  /**
   * Minted by the caller, not by the database. The secret's AAD binds it to
   * tenant + endpoint id, so the id has to exist before the secret is sealed;
   * a database default would force either a second transaction or a window in
   * which the stored ciphertext is bound to the wrong scope.
   */
  id: string;
  tenantId: string;
  createdBy: string;
  endpointKey: string;
  signature: InboundAdmissionEndpoint["signature"];
  storedSecret: InboundAdmissionEndpoint["storedSecret"];
  identity: InboundIdentityProfile;
  unsignedHeaders: { deliveryId: string | null; eventType: string | null };
  maxBodyBytes: number;
  serviceIdentityId: string;
  dispatch: { operationId: string; inputField: string };
};

export async function insertInboundEndpoint(
  trx: Transaction<DB>, input: InsertEndpointInput,
): Promise<EndpointSummary> {
  const row = await sql<EndpointRow>`
    insert into platform.inbound_endpoints (
      id, tenant_id, endpoint_key, signature_header, signature_algorithm, signature_encoding,
      signature_prefix, identity_source, identity_fields, identity_event_type_path,
      unsigned_delivery_id_header, unsigned_event_type_header, max_body_bytes,
      secret_ciphertext, secret_key_id, secret_algorithm,
      service_identity_id, operation_id, operation_input_field, created_by
    ) values (
      ${input.id}::uuid,
      ${input.tenantId}::uuid, ${input.endpointKey}, ${input.signature.header}, ${input.signature.algorithm},
      ${input.signature.encoding}, ${input.signature.prefix ?? null},
      ${input.identity.source}, ${serializeInboundIdentityFields(input.identity.fields)},
      ${input.identity.eventTypePath},
      ${input.unsignedHeaders.deliveryId}, ${input.unsignedHeaders.eventType}, ${input.maxBodyBytes},
      ${input.storedSecret.ciphertext}, ${input.storedSecret.keyId}, ${input.storedSecret.algorithm},
      ${input.serviceIdentityId}, ${input.dispatch.operationId}, ${input.dispatch.inputField},
      ${input.createdBy}::uuid
    )
    returning ${sql.join(ENDPOINT_COLUMNS.map((column) => sql.ref(column)))}
  `.execute(trx);
  const inserted = row.rows[0];
  if (!inserted) throw new Error("The inbound endpoint registration was not stored.");
  return endpointSummaryOf(inserted);
}

/**
 * Revoke, idempotently. The update is conditional on the row still being
 * active, so a concurrent second revocation does not overwrite the first
 * one's reason; either way the current row is returned.
 *
 * This is one half of the dispatch gate (./inbound-endpoint-gate.ts): the
 * status write happens under the `(tenant, endpoint)` lock, so a queued
 * dispatch's final mark either sees this revocation or has already committed
 * its own attempt. The other half is `markInboundOperationDispatch`
 * (jobs/inbound/work.ts).
 */
export async function revokeInboundEndpoint(
  trx: Transaction<DB>, input: { id: string; reason: string | null },
): Promise<EndpointSummary | undefined> {
  // Before the write and before any row lock, so nothing is held while waiting
  // for it. The pair comes off the registration row read THROUGH the tenant
  // policy, so another tenant's id takes no lock at all — and then matches no
  // row below either, which is the same refusal this surface already gave.
  await boundInboundEndpointGateWait(trx);
  await sql`
    select pg_advisory_xact_lock(${inboundEndpointGateKey(sql`e.tenant_id`, sql`e.id`)})
      from platform.inbound_endpoints e
     where e.id = ${input.id}::uuid and e.tenant_id = app.current_tenant()
  `.execute(trx);
  // `tenant_id = app.current_tenant()` beside the policy, not instead of it.
  // The policy is what enforces the fence; spelling it here as well means a
  // statement that somehow ran without the policy still cannot reach another
  // tenant's registration, and it says out loud what the row is scoped by.
  await sql`
    update platform.inbound_endpoints
       set status = 'revoked', revoked_at = now(), revoked_reason = ${input.reason},
           updated_at = now()
     where id = ${input.id}::uuid and tenant_id = app.current_tenant() and status = 'active'
  `.execute(trx);
  const current = await sql<EndpointRow>`
    select ${sql.join(ENDPOINT_COLUMNS.map((column) => sql.ref(column)))}
      from platform.inbound_endpoints
     where id = ${input.id}::uuid and tenant_id = app.current_tenant()
  `.execute(trx);
  const row = current.rows[0];
  return row ? endpointSummaryOf(row) : undefined;
}

export async function listInboundEndpoints(
  trx: Transaction<DB>, filter: { endpointKey?: string },
): Promise<readonly EndpointSummary[]> {
  const rows = await sql<EndpointRow>`
    select ${sql.join(ENDPOINT_COLUMNS.map((column) => sql.ref(column)))}
      from platform.inbound_endpoints
     where tenant_id = app.current_tenant()
       and (${filter.endpointKey ?? null}::text is null or endpoint_key = ${filter.endpointKey ?? null})
     order by created_at desc, id
     limit 500
  `.execute(trx);
  return rows.rows.map(endpointSummaryOf);
}

/**
 * The receipt and its dispatch work, in one statement pair inside one
 * transaction.
 *
 * The payload arrives already sealed (`sealedBody`): the keyring lives in
 * admission, so nothing in this file — no statement, no parameter the driver
 * logs, no test fixture built against this port — ever holds a provider's bytes
 * in the clear.
 *
 * The job's actor is the verified user who REGISTERED the endpoint, with the
 * `trusted-context` credential the enqueue already demands. That identity is
 * queue bookkeeping: it fences the handler's database session to this tenant,
 * which is all the handler needs. It is emphatically NOT the authority the
 * dispatched Operation runs under — that is the organization service identity
 * on the row, re-authorized live by the durable broker, which is the only
 * thing in this path that can authorize a machine write.
 */
async function recordDelivery(
  trx: Transaction<DB>, input: RecordInboundDeliveryInput,
): Promise<{ deliveryId: string; created: boolean }> {
  const inserted = await sql<{ id: string }>`
    insert into platform.inbound_deliveries (
      id, tenant_id, endpoint_id, endpoint_key, service_identity_id, operation_id,
      operation_input_field, idempotency_key, event_type,
      unsigned_provider_delivery_id, unsigned_event_type,
      body_sha256, body_bytes, body_ciphertext, body_key_id, body_algorithm
    ) values (
      ${input.deliveryId}::uuid,
      ${input.endpoint.tenantId}::uuid, ${input.endpoint.id}::uuid, ${input.endpoint.endpointKey},
      ${input.endpoint.serviceIdentityId}, ${input.endpoint.dispatch.operationId},
      ${input.endpoint.dispatch.inputField}, ${input.idempotencyKey}, ${input.eventType},
      ${input.unsignedProviderDeliveryId}, ${input.unsignedEventType},
      ${input.bodySha256}, ${input.bodyBytes},
      ${input.sealedBody.ciphertext}, ${input.sealedBody.keyId}, ${input.sealedBody.algorithm}
    )
    on conflict (tenant_id, endpoint_id, idempotency_key) do nothing
    returning id
  `.execute(trx);
  const created = inserted.rows[0];
  if (!created) {
    const existing = await sql<{ id: string }>`
      select id from platform.inbound_deliveries
       where tenant_id = ${input.endpoint.tenantId}::uuid and endpoint_id = ${input.endpoint.id}::uuid
         and idempotency_key = ${input.idempotencyKey}
    `.execute(trx);
    const row = existing.rows[0];
    if (!row) throw new Error("An inbound delivery conflicted with a row that cannot be read.");
    return { deliveryId: row.id, created: false };
  }
  const job = await enqueueJob(trx, {
    tenantId: input.endpoint.tenantId,
    actorId: input.endpoint.createdBy,
    actorSession: { credential: "trusted-context", scope: "self", roles: [], groups: [], relationGroupIds: [] },
    kind: INBOUND_DISPATCH_KIND,
    payload: { deliveryId: created.id },
    // The same key at both levels: a second enqueue of this delivery can never
    // become a second dispatch, whatever happened to the first job.
    deliveryKey: input.idempotencyKey,
    subject: { entity: "InboundDelivery", id: created.id },
  });
  await sql`
    update platform.inbound_deliveries set dispatch_job_id = ${job.id}::uuid, updated_at = now()
     where id = ${created.id}::uuid
  `.execute(trx);
  return { deliveryId: created.id, created: true };
}

/** The Postgres half of the admission store port. */
export function createInboundAdmissionStore(db: OpenShapeForgeDatabase): InboundAdmissionStore {
  return {
    tenantForEndpoint: async (endpointId) => {
      const result = await sql<{ tenant_id: string | null }>`
        select app.inbound_endpoint_tenant(${endpointId}::uuid) as tenant_id
      `.execute(db);
      return result.rows[0]?.tenant_id ?? undefined;
    },
    withTenant: (tenantId, work) =>
      withCredentialResolutionSession(db, tenantId, (trx) => {
        const transaction: InboundAdmissionTransaction = {
          readEndpoint: async (endpointId) => {
            const rows = await sql<EndpointRow>`
              select ${sql.join(ENDPOINT_COLUMNS.map((column) => sql.ref(column)))}
                from platform.inbound_endpoints
               where id = ${endpointId}::uuid and tenant_id = app.current_tenant()
            `.execute(trx);
            const row = rows.rows[0];
            return row ? endpointOf(row) : undefined;
          },
          recordDelivery: (input) => recordDelivery(trx, input),
        };
        return work(transaction);
      }),
  };
}

/**
 * The registration port the host service writes through. Named rather than
 * inferred so the service states what it needs and a test can supply it.
 */
export type InboundEndpointStore = {
  insert(session: TrustedSessionContext, input: InsertEndpointInput): Promise<EndpointSummary>;
  /** `undefined` when no row with that id is visible to this tenant session. */
  revoke(session: TrustedSessionContext, input: { id: string; reason: string | null }): Promise<EndpointSummary | undefined>;
  list(session: TrustedSessionContext, filter: { endpointKey?: string }): Promise<readonly EndpointSummary[]>;
};

/** Registration reads and writes, always inside a live verified tenant session. */
export function inboundEndpointWriter(db: OpenShapeForgeDatabase): InboundEndpointStore {
  return {
    insert: (session: TrustedSessionContext, input: InsertEndpointInput) =>
      withDbSession(db, session, (trx) => insertInboundEndpoint(trx, input)),
    revoke: (session: TrustedSessionContext, input: { id: string; reason: string | null }) =>
      withDbSession(db, session, (trx) => revokeInboundEndpoint(trx, input)),
    list: (session: TrustedSessionContext, filter: { endpointKey?: string }) =>
      withDbSession(db, session, (trx) => listInboundEndpoints(trx, filter)),
  };
}
