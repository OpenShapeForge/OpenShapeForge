// SPDX-License-Identifier: BUSL-1.1
/**
 * The host service a plugin registers an inbound endpoint through.
 *
 * Shaped like `createWebhookSecretServices`, and for the same reasons: the
 * keyring stays in core, the sealed secret has no read API, and the tenant is
 * the live session's — never an argument. What is deliberately different is
 * that there is no `verify` a plugin may call. Admission is the host's own HTTP
 * path (http/inbound-routes.ts), so a plugin is never handed bytes and asked
 * whether they are genuine; a plugin that could answer that question would be a
 * second place where a tenant can be decided.
 *
 * ## Why this surface is gated like credential administration
 *
 * A registration is not an ordinary tenant write. It says: when a stranger
 * presents bytes carrying this HMAC, run THAT canonical Operation under the
 * ORGANIZATION'S SERVICE IDENTITY. Left to any authenticated session with a
 * free choice of Operation id, that is privilege escalation with extra steps —
 * the exact shape `auth/api-key/ceiling.ts` exists to refuse. So three
 * established controls apply, each closing a different door, and all of them
 * before anything is stored:
 *
 *  1. **A verified person.** The deployment must have classified the principal
 *     as a person (`isVerifiedPersonSession`, the same rule and the same code
 *     as API key management). A machine principal that holds the integration
 *     role would otherwise climb its own ladder: register a webhook, point it
 *     at an Operation only the service identity may run, trigger it.
 *  2. **The canonical integration-administration capability**,
 *     `Platform.ConnectorAdmin` via `requireConnectorAdmin` — the role that
 *     already governs "hand credentials for another system to the platform and
 *     decide what it may reach". No new role is invented here; an inbound
 *     endpoint is that act, from the other direction.
 *  3. **Operation binding: nobody delegates what they cannot invoke.** The
 *     named Operation is resolved through core's own catalog UNDER THE
 *     CALLER'S SESSION (`resolveOperation` → `ModulePlatformRuntime`'s
 *     authorization-checked lookup). An Operation the caller may not invoke
 *     does not resolve, so it cannot be bound — the role rule of
 *     `assertMayGrantRoles`, applied to Operations. It must also declare keyed
 *     idempotency, because the broker treats a reclaimed non-repeatable write
 *     as an uncertain repeat and refuses it.
 *
 * `revoke` and `list` are gated identically: revocation is a denial-of-service
 * lever, and the list names the providers a tenant works with.
 *
 * Everything a registration declares is validated here BEFORE it is stored, and
 * the database checks the same vocabulary again (db/migrations/inbound.ts). The
 * duplication is intentional: the admitted hash algorithms are the one
 * configuration value that would otherwise be forwarded straight into
 * `createHmac`, which accepts md5 and sha1 without complaint.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  RuntimeInboundEndpoint, RuntimeInboundEndpointRegistration, RuntimeInboundEndpointServices,
  RuntimeOperationDefinition, RuntimeConnectionResolution,
} from "@openshapeforge/plugin-runtime";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { isVerifiedPersonSession } from "../auth/api-key/ceiling.js";
import { requireConnectorAdmin } from "../connectors/authorization.js";
import { decryptSecret, encryptSecret, keyringFromEnv, type SecretKeyring } from "../platform/secrets.js";
import {
  INBOUND_MAX_BODY_BYTES, normalizeInboundHeaderName, normalizeInboundSignatureScheme,
} from "../platform/inbound-signature.js";
import { INBOUND_ENDPOINT_KEY, INBOUND_SECRET_FIELD } from "./inbound-admission.js";
import { normalizeInboundIdentity, type InboundIdentityProfile } from "./inbound-identity.js";
import { inboundEndpointPath } from "../http/inbound-path.js";
import { endpointSummaryOf, type EndpointRow, type EndpointSummary, type InboundEndpointStore, type InsertEndpointInput } from "./inbound-store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;
const INPUT_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4096;
const MAX_REASON_LENGTH = 500;

export type InboundEndpointServiceOptions = {
  /** The live-capability check every other platform service uses. */
  acceptsSession(session: TrustedSessionContext): boolean;
  /** The organization's configured service identity, or nothing. */
  serviceIdentity(tenantId: string): string | undefined;
  /**
   * Core's own Operation catalog lookup, resolved UNDER THE CALLER'S OWN
   * authorization: `undefined` both for an Operation that does not exist and
   * for one this session may not invoke, which are the same refusal here. This
   * is what stops a caller binding a webhook to an Operation it could not call
   * itself and having the service identity call it instead.
   */
  resolveOperation(
    session: TrustedSessionContext, operationId: string,
  ): Promise<RuntimeOperationDefinition | undefined>;
  store: InboundEndpointStore;
  /** Core supplies these only on the canonical Operation transaction. */
  managed?: {
    activeTransaction(session: TrustedSessionContext): boolean;
    connection(session: TrustedSessionContext, id: string): Promise<RuntimeConnectionResolution>;
    find(session: TrustedSessionContext, registrationKey: string): Promise<EndpointRow | undefined>;
    findConnection(session: TrustedSessionContext, input: { id: string; connectionId: string }): Promise<EndpointRow | undefined>;
    insert(session: TrustedSessionContext, input: InsertEndpointInput): Promise<EndpointSummary | undefined>;
    revoke(session: TrustedSessionContext, input: { id: string; connectionId: string }): Promise<EndpointSummary | undefined>;
  };
  keyring?: SecretKeyring;
};

function view(summary: EndpointSummary): RuntimeInboundEndpoint {
  return {
    id: summary.id,
    tenantId: summary.tenantId,
    endpointKey: summary.endpointKey,
    path: inboundEndpointPath(summary.endpointKey, summary.id),
    signature: summary.signature,
    identity: summary.identity ? {
      source: summary.identity.source,
      ...(summary.identity.fields.length > 0 ? { fields: summary.identity.fields } : {}),
      ...(summary.identity.eventTypePath ? { eventTypePath: summary.identity.eventTypePath } : {}),
    } : null,
    unsignedHeaders: summary.unsignedHeaders,
    dispatch: summary.dispatch,
    maxBodyBytes: summary.maxBodyBytes,
    status: summary.status,
    createdAt: summary.createdAt,
    revokedAt: summary.revokedAt,
    revokedReason: summary.revokedReason,
  };
}

/**
 * The normalised registration, or a refusal naming WHAT is wrong without ever
 * echoing the secret. A validation message is read by the plugin author, so it
 * says which field; it never contains a value from the input.
 */
export function normalizeInboundRegistration(input: RuntimeInboundEndpointRegistration): {
  endpointKey: string;
  signature: NonNullable<ReturnType<typeof normalizeInboundSignatureScheme>>;
  identity: InboundIdentityProfile;
  unsignedHeaders: { deliveryId: string | null; eventType: string | null };
  maxBodyBytes: number;
  dispatch: { operationId: string; inputField: string };
} {
  if (!input || typeof input !== "object") throw new Error("An inbound endpoint registration is required.");
  const endpointKey = typeof input.endpointKey === "string" ? input.endpointKey.trim() : "";
  if (endpointKey.length === 0 || endpointKey.length > 64 || !INBOUND_ENDPOINT_KEY.test(endpointKey)) {
    throw new Error("endpointKey must be a lowercase dotted provider family of at most 64 characters.");
  }
  const signature = normalizeInboundSignatureScheme(input.signature);
  if (!signature) {
    throw new Error(
      "signature must name a lowercase header, one of the admitted hash algorithms, " +
        "a hex or base64 encoding, and at most a 32-character printable prefix.",
    );
  }
  if (typeof input.secret !== "string") throw new Error("secret must be the provider's shared signing secret.");
  const secretBytes = Buffer.byteLength(input.secret, "utf8");
  if (secretBytes < MIN_SECRET_BYTES || secretBytes > MAX_SECRET_BYTES) {
    throw new Error(`secret must be between ${MIN_SECRET_BYTES} and ${MAX_SECRET_BYTES} bytes.`);
  }
  const identity = normalizeInboundIdentity(input.identity);
  if (!identity) {
    throw new Error(
      "identity must name a supported signed-identity source: 'body-digest' with no fields, " +
        "or 'body-field' with one to four distinct dotted paths into the signed JSON body. " +
        "An optional eventTypePath is one such path. No source reads a header, because a " +
        "provider's signature does not cover one.",
    );
  }
  const unsignedHeaders: { deliveryId: string | null; eventType: string | null } =
    { deliveryId: null, eventType: null };
  if (input.unsignedHeaders !== undefined) {
    if (!input.unsignedHeaders || typeof input.unsignedHeaders !== "object") {
      throw new Error("unsignedHeaders must name the correlation headers to retain.");
    }
    for (const field of ["deliveryId", "eventType"] as const) {
      const declared = input.unsignedHeaders[field];
      if (declared === undefined) continue;
      const header = normalizeInboundHeaderName(declared);
      if (!header) throw new Error(`unsignedHeaders.${field} must be a lowercase HTTP header name.`);
      unsignedHeaders[field] = header;
    }
  }
  const dispatch = input.dispatch;
  if (!dispatch || typeof dispatch !== "object" || !OPERATION_ID.test(dispatch.operationId ?? "") ||
    !INPUT_FIELD.test(dispatch.inputField ?? "")) {
    throw new Error("dispatch must name a canonical Operation id and the input field its delivery envelope goes in.");
  }
  let maxBodyBytes = INBOUND_MAX_BODY_BYTES;
  if (input.maxBodyBytes !== undefined) {
    if (!Number.isInteger(input.maxBodyBytes) || input.maxBodyBytes <= 0) {
      throw new Error("maxBodyBytes must be a positive integer.");
    }
    // Lowered, never raised: the host's ceiling is what the verifier will hash.
    maxBodyBytes = Math.min(input.maxBodyBytes, INBOUND_MAX_BODY_BYTES);
  }
  return {
    endpointKey, signature, identity, unsignedHeaders, maxBodyBytes,
    dispatch: { operationId: dispatch.operationId, inputField: dispatch.inputField },
  };
}

export function createInboundEndpointServices(
  options: InboundEndpointServiceOptions,
): RuntimeInboundEndpointServices<TrustedSessionContext> {
  const keyring = () => options.keyring ?? keyringFromEnv(process.env.OPENSHAPEFORGE_ELICITED_SECRET_KEYS);

  /**
   * Every surface here requires the same thing: a live verified tenant session
   * belonging to a PERSON this deployment classified as one, holding the
   * canonical integration-administration capability. Ordered so the cheapest
   * and least disclosing refusal comes first, and so a service principal that
   * holds every role never learns that roles were consulted.
   */
  const administrator = (session: TrustedSessionContext): { tenantId: string; userId: string } => {
    if (!options.acceptsSession(session) || !session.tenantId || !session.userId || session.credential === "grant") {
      throw new Error("Inbound endpoint configuration requires a live verified tenant session.");
    }
    if (!UUID.test(session.tenantId) || !UUID.test(session.userId)) {
      throw new Error("Inbound endpoint configuration requires a verified tenant and user identity.");
    }
    // The carrier rule of auth/api-key/ceiling.ts, unchanged and shared: a
    // registration binds an Operation to the organization's machine identity,
    // so a machine principal holding the role must not be able to make one.
    if (!isVerifiedPersonSession(session)) {
      throw new Error(
        "Only a verified person may configure inbound endpoints. Use an interactive session.",
      );
    }
    // Throws ConnectorAuthorizationError (403) naming the capability and
    // nothing about who holds it.
    requireConnectorAdmin(session);
    return { tenantId: session.tenantId, userId: session.userId };
  };

  /**
   * Bind the dispatch target, under the CALLER's authorization.
   *
   * Two refusals, deliberately phrased alike for the unresolvable cases: an
   * Operation that does not exist and one this caller may not invoke are the
   * same answer, so the surface is not a catalog oracle for a session that
   * holds the integration role but no Operation access.
   */
  const bindDispatch = async (
    session: TrustedSessionContext, dispatch: { operationId: string; inputField: string },
  ): Promise<void> => {
    let definition: RuntimeOperationDefinition | undefined;
    try {
      definition = await options.resolveOperation(session, dispatch.operationId);
    } catch {
      definition = undefined;
    }
    if (!definition || definition.id !== dispatch.operationId) {
      throw new Error(
        "dispatch.operationId must name a canonical Operation this session may itself invoke.",
      );
    }
    const idempotency = definition.reliability?.idempotency;
    if (idempotency?.mode !== "keyed" || typeof idempotency.inputField !== "string" ||
      idempotency.inputField.trim().length === 0) {
      // Not pedantry: without a keyed contract the durable broker refuses a
      // reclaimed write as an uncertain repeat, so such a registration would
      // accept deliveries that strand on their first worker crash.
      throw new Error(
        "dispatch.operationId must name an Operation declaring reliability.idempotency.mode: keyed, " +
          "so a repeated delivery is recognisable to it.",
      );
    }
    if (idempotency.inputField === dispatch.inputField) {
      throw new Error(
        "dispatch.inputField must differ from the Operation's idempotency input field, " +
          "or the delivery envelope would overwrite the delivery key.",
      );
    }
  };

  const managedActor = (session: TrustedSessionContext): { tenantId: string; userId: string; serviceIdentityId: string } => {
    const serviceIdentityId = session.tenantId ? options.serviceIdentity(session.tenantId) : undefined;
    if (!options.acceptsSession(session) || !session.tenantId || !UUID.test(session.tenantId) ||
        !session.userId || !UUID.test(session.userId) || session.credential !== "bearer" ||
        session.principalKind !== "service" || !serviceIdentityId ||
        session.organizationServiceIdentityId !== serviceIdentityId ||
        !session.roles.includes("Platform.InboundEndpointManage") ||
        !options.managed?.activeTransaction(session)) {
      throw new Error("Connection endpoint reconciliation requires the configured organization service identity, its inbound capability, and an active Operation transaction.");
    }
    return { tenantId: session.tenantId, userId: session.userId, serviceIdentityId };
  };

  return {
    connectionIsCurrent: async (session, input) => {
      const actor = managedActor(session);
      if (!UUID.test(input.connectionId ?? "") || !UUID.test(input.endpointId ?? "")) return false;
      const endpoint = await options.managed!.findConnection(session, { id: input.endpointId, connectionId: input.connectionId });
      if (!endpoint || endpoint.status !== "active" || !endpoint.connection_secret_field) return false;
      const resolved = await options.managed!.connection(session, input.connectionId);
      if (!resolved.ok || resolved.connection.connectionId !== input.connectionId ||
          resolved.connection.adapterKey !== endpoint.endpoint_key ||
          !resolved.connection.secretKeys.includes(endpoint.connection_secret_field)) return false;
      const currentSecret = resolved.connection.values[endpoint.connection_secret_field];
      const keys = keyring();
      if (!keys || typeof currentSecret !== "string") return false;
      try {
        const original = decryptSecret(keys, `${actor.tenantId}:${endpoint.id}`, INBOUND_SECRET_FIELD,
          { ciphertext: endpoint.secret_ciphertext, keyId: endpoint.secret_key_id, algorithm: endpoint.secret_algorithm });
        return equalSecret(currentSecret, original);
      } catch { return false; }
    },
    registerForConnection: async (session, input) => {
      const actor = managedActor(session);
      if (!UUID.test(input.connectionId ?? "") || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.secretField ?? "") ||
          typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) {
        throw new Error("Connection endpoint registration requires a Connection, a secret field and an idempotency key.");
      }
      const resolved = await options.managed!.connection(session, input.connectionId);
      if (!resolved.ok || resolved.connection.connectionId !== input.connectionId ||
          resolved.connection.adapterKey !== input.endpointKey || !resolved.connection.secretKeys.includes(input.secretField)) {
        throw new Error("The selected Connection or confidential signing field is not available to this organization.");
      }
      const secret = resolved.connection.values[input.secretField];
      if (typeof secret !== "string") throw new Error("The selected confidential signing field is not available.");
      const normalized = normalizeInboundRegistration({ ...input, secret });
      await bindDispatch(session, normalized.dispatch);
      const keys = keyring();
      if (!keys) throw new Error("Inbound endpoint secret encryption is not configured.");
      const registrationKey = createHash("sha256").update(input.idempotencyKey, "utf8").digest("hex");
      const sameRegistration = (existing: EndpointRow): RuntimeInboundEndpoint => {
        const current = endpointSummaryOf(existing);
        let oldSecret: string;
        try {
          oldSecret = decryptSecret(keys, `${actor.tenantId}:${existing.id}`, INBOUND_SECRET_FIELD,
            { ciphertext: existing.secret_ciphertext, keyId: existing.secret_key_id, algorithm: existing.secret_algorithm });
        } catch { throw new Error("The existing Connection endpoint cannot be opened."); }
        if (existing.connection_id === input.connectionId && existing.connection_secret_field === input.secretField &&
            !equalSecret(oldSecret, secret)) {
          throw new Error("The Connection signing secret has changed since this endpoint was registered.");
        }
        if (existing.connection_id !== input.connectionId || existing.connection_secret_field !== input.secretField ||
            !current.identity || current.status !== "active" ||
            JSON.stringify({ endpointKey: current.endpointKey, signature: current.signature, identity: current.identity,
              unsignedHeaders: current.unsignedHeaders, maxBodyBytes: current.maxBodyBytes, dispatch: current.dispatch }) !==
            JSON.stringify(normalized)) {
          throw new Error("The registration key is already bound to a different or invalid Connection endpoint.");
        }
        return view(current);
      };
      const existing = await options.managed!.find(session, registrationKey);
      if (existing) return sameRegistration(existing);
      const id = randomUUID();
      const stored = await options.managed!.insert(session, {
        id, tenantId: actor.tenantId, createdBy: actor.userId, connectionId: input.connectionId, connectionSecretField: input.secretField, registrationKey,
        ...normalized, serviceIdentityId: actor.serviceIdentityId,
        storedSecret: encryptSecret(keys, `${actor.tenantId}:${id}`, INBOUND_SECRET_FIELD, secret),
      });
      if (stored) return view(stored);
      // Under the default READ COMMITTED isolation, ON CONFLICT waits for a
      // winning insert to commit and the next statement can see it. Stricter
      // isolation may instead raise a serialization failure for the caller to retry.
      const winner = await options.managed!.find(session, registrationKey);
      if (!winner) throw new Error("The concurrent Connection endpoint could not be read.");
      return sameRegistration(winner);
    },
    revokeForConnection: async (session, input) => {
      managedActor(session);
      if (!UUID.test(input.connectionId ?? "") || !UUID.test(input.endpointId ?? "")) {
        throw new Error("Connection endpoint revocation requires its Connection and endpoint identifiers.");
      }
      const result = await options.managed!.revoke(session, { id: input.endpointId, connectionId: input.connectionId });
      if (!result) throw new Error("No inbound endpoint for that Connection exists in this organization.");
      return view(result);
    },
    register: async (session, input) => {
      const { tenantId, userId } = administrator(session);
      const normalized = normalizeInboundRegistration(input);
      await bindDispatch(session, normalized.dispatch);
      const keys = keyring();
      if (!keys) throw new Error("Inbound endpoint secret encryption is not configured.");
      // Without a service identity there is nothing to dispatch an accepted
      // delivery AS, so the registration is refused now rather than accepting
      // deliveries that can never be processed.
      const serviceIdentityId = options.serviceIdentity(tenantId);
      if (!serviceIdentityId) {
        throw new Error("Inbound endpoints require a configured organization service identity.");
      }
      // The id is minted here, before the secret is sealed, because the AAD
      // binds the ciphertext to tenant + endpoint: a ciphertext copied onto
      // another row fails to open. One insert, so there is no window in which
      // a stored registration cannot be opened at all.
      const id = randomUUID();
      const stored = await options.store.insert(session, {
        id, tenantId, createdBy: userId,
        endpointKey: normalized.endpointKey,
        signature: normalized.signature,
        storedSecret: encryptSecret(keys, `${tenantId}:${id}`, INBOUND_SECRET_FIELD, input.secret),
        identity: normalized.identity,
        unsignedHeaders: normalized.unsignedHeaders,
        maxBodyBytes: normalized.maxBodyBytes,
        serviceIdentityId,
        dispatch: normalized.dispatch,
      });
      return view(stored);
    },

    revoke: async (session, input) => {
      administrator(session);
      if (!input || !UUID.test(input.id ?? "")) throw new Error("Revoking an inbound endpoint requires its id.");
      if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > MAX_REASON_LENGTH)) {
        throw new Error(`An inbound endpoint revocation reason must be at most ${MAX_REASON_LENGTH} characters.`);
      }
      const revoked = await options.store.revoke(session, { id: input.id, reason: input.reason ?? null });
      // The tenant policy already fenced the read: an unknown id and another
      // tenant's id are the same answer.
      if (!revoked) throw new Error("No inbound endpoint with that id exists in this organization.");
      return view(revoked);
    },

    list: async (session, filter) => {
      administrator(session);
      const endpointKey = filter?.endpointKey;
      if (endpointKey !== undefined && !INBOUND_ENDPOINT_KEY.test(endpointKey)) {
        throw new Error("endpointKey must be a lowercase dotted provider family.");
      }
      const rows = await options.store.list(session, endpointKey === undefined ? {} : { endpointKey });
      return rows.map(view);
    },
  };
}
