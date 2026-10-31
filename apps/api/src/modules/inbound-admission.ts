// SPDX-License-Identifier: BUSL-1.1
/**
 * Admission of an authenticated inbound provider delivery.
 *
 * This is the one code path in the API an unauthenticated stranger reaches
 * with a body, so the order of its steps IS the security argument:
 *
 *   bound the bytes
 *     → resolve a candidate registration from the explicit endpoint id
 *       → read that registration under its own tenant
 *         → verify the HMAC over the exact bytes
 *           → read the delivery's identity from those VERIFIED bytes
 *             → seal the payload to tenant + endpoint + receipt
 *               → persist the receipt AND the dispatch work in ONE transaction
 *                 → only then answer "accepted"
 *
 * Nothing before the verification writes anything, and nothing after it
 * decides the tenant: the tenant comes from the registration row the signature
 * proved possession of, never from the URL and never from a header. The URL's
 * endpoint id selects a candidate and proves nothing — a stranger holding it
 * gets the same answer as a stranger who guessed it.
 *
 * Nor does a header decide WHICH event this is. The delivery key is derived
 * from signed material only (modules/inbound-identity.ts); the two headers a
 * registration may name are retained beside the receipt as correlation
 * material, under names that say so, and reach the Operation under
 * `envelope.unsigned`. A captured delivery replayed with a different id is
 * therefore the same key and the same duplicate, and a burned id cannot
 * suppress a distinct authentic body.
 *
 * The answer is deliberately coarse. `rejected` covers an unknown endpoint, a
 * revoked one, a key mismatch, an absent header, a malformed digest and a
 * forged signature without distinguishing them, so the route cannot be turned
 * into a registration oracle. `unavailable` is reserved for the host's own
 * problems (no keyring, no database, a payload that could not be sealed, a
 * failed write) and never answers a delivery that was in fact admitted.
 *
 * Crash and failure behaviour. The receipt and the queued dispatch commit
 * together or not at all, which is what makes a lost acknowledgement safe: the
 * provider retries, the unique delivery key matches, and the answer is
 * `duplicate` with no second dispatch. A write that fails is never `accepted`
 * — the caller is told nothing was kept, which is true. This bounds repetition;
 * it does not promise an exactly-once external effect, because the dispatched
 * Operation's own effect is outside this transaction (see jobs/inbound/).
 */
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeInboundAdmission, RuntimeInboundSignatureScheme } from "@openshapeforge/plugin-runtime";
import { decryptSecret, encryptSecret, type SecretKeyring, type StoredSecret } from "../platform/secrets.js";
import {
  INBOUND_MAX_BODY_BYTES, normalizeInboundSignatureScheme, verifyInboundSignature,
} from "../platform/inbound-signature.js";
import { readSignedDeliveryIdentity, type InboundIdentityProfile } from "./inbound-identity.js";

/** The AAD field name the endpoint secret is sealed under. */
export const INBOUND_SECRET_FIELD = "inbound-signing-secret";

/** The AAD field name a retained delivery payload is sealed under. */
export const INBOUND_BODY_FIELD = "inbound-delivery-body";

/**
 * The AAD scope one retained payload is bound to: its tenant, its endpoint and
 * its own receipt. All three, so a ciphertext lifted out of this row opens
 * nowhere else — not under another tenant, not under another endpoint of the
 * same tenant, and not under another delivery of the same endpoint. The worker
 * rebuilds this from the row it read under its claim, so a row whose scope
 * columns were tampered with fails to open rather than decrypting into
 * someone else's dispatch.
 */
export function inboundBodyScope(tenantId: string, endpointId: string, deliveryId: string): string {
  return `${tenantId}:${endpointId}:${deliveryId}`;
}

/** Public, lowercase, dotted provider family: `jira-admin`, `github.app`. */
export const INBOUND_ENDPOINT_KEY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Metadata headers are retained verbatim but bounded; they are never authority. */
const MAX_METADATA_BYTES = 200;

/**
 * A lookup that threw, told apart from a lookup that found nothing. The two
 * must answer differently — the host's own fault is `unavailable` and
 * retryable, an unknown endpoint is a flat refusal — and `undefined` cannot
 * carry both.
 *
 * A tagged result rather than a sentinel value. A `Symbol` sentinel is widened
 * to `symbol` when it is returned from a callback, and `found === LOOKUP_FAILED`
 * then narrows nothing: every later use of the tenant stays `string | symbol`,
 * which is a type error where a tenant id is required and, worse, a `symbol`
 * that only the `UUID.test` below happens to stop. The discriminant makes the
 * two outcomes structurally distinct instead.
 */
type EndpointTenantLookup =
  | { failed: true }
  | { failed: false; tenantId: string | undefined };

/** The registration as the store holds it. The secret is sealed, not readable. */
export type InboundAdmissionEndpoint = {
  id: string;
  tenantId: string;
  endpointKey: string;
  signature: RuntimeInboundSignatureScheme;
  storedSecret: StoredSecret;
  /** How this provider's deliveries are identified, from signed material only. */
  identity: InboundIdentityProfile;
  /** Headers retained for correlation. Never authority: see inbound-identity.ts. */
  unsignedHeaders: { deliveryId: string | null; eventType: string | null };
  maxBodyBytes: number;
  status: "active" | "revoked";
  /** The organization service identity the dispatch runs under. */
  serviceIdentityId: string;
  dispatch: { operationId: string; inputField: string };
  /** The verified user who registered this endpoint; queue bookkeeping only. */
  createdBy: string;
};

/**
 * What the store is asked to keep. The payload reaches it SEALED and never as
 * plaintext: the keyring lives in admission, so no statement, parameter log or
 * store-level test fixture ever holds a provider's bytes in the clear.
 *
 * `deliveryId` is minted here rather than defaulted by the database because the
 * payload's AAD binds it. On a duplicate the minted id is simply discarded and
 * the earlier receipt's id is returned.
 */
export type RecordInboundDeliveryInput = {
  endpoint: InboundAdmissionEndpoint;
  deliveryId: string;
  /** From inside the signature, or null. The only event name with meaning. */
  eventType: string | null;
  /** Retained verbatim for correlation; not covered by the signature. */
  unsignedProviderDeliveryId: string | null;
  unsignedEventType: string | null;
  bodySha256: string;
  /** Plaintext length of the verified body, for operational bookkeeping. */
  bodyBytes: number;
  sealedBody: StoredSecret;
  idempotencyKey: string;
};

/**
 * One tenant-fenced transaction. `recordDelivery` MUST write the receipt and
 * enqueue the dispatch work inside it — the atomicity is the port's promise,
 * not something the admission logic above can arrange or get wrong.
 */
export type InboundAdmissionTransaction = {
  readEndpoint(endpointId: string): Promise<InboundAdmissionEndpoint | undefined>;
  /** `created: false` means an equal delivery key already existed: a duplicate. */
  recordDelivery(input: RecordInboundDeliveryInput): Promise<{ deliveryId: string; created: boolean }>;
};

export type InboundAdmissionStore = {
  /**
   * The one tenant this endpoint id belongs to, read before any tenant is
   * known. A point lookup answering one tenant for one id, never a list.
   */
  tenantForEndpoint(endpointId: string): Promise<string | undefined>;
  /** Resolves only after the transaction has COMMITTED. */
  withTenant<T>(tenantId: string, work: (trx: InboundAdmissionTransaction) => Promise<T>): Promise<T>;
};

export type InboundAdmissionRequest = {
  /** The provider family from the URL; must equal the registration's own. */
  endpointKey: string;
  /** The explicit endpoint id from the URL; a selector, never authority. */
  endpointId: string;
  /**
   * Read ONE named header, lowercased. A function rather than a header bag so
   * admission can only see what the registration declared — an undeclared
   * header is not merely ignored, it is unreachable from here.
   */
  header(name: string): string | undefined;
  /** The exact request bytes, unparsed. */
  body: Uint8Array;
};

export type InboundAdmissionOptions = {
  store: InboundAdmissionStore;
  keyring(): SecretKeyring | undefined;
  /** Ids and codes only. Never a header value, a digest or a payload. */
  log?(event: { code: string; endpointId?: string | undefined; tenantId?: string | undefined }): void;
};

/** Bounded, printable projection of a metadata header, or null. */
function metadata(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, "utf8") > MAX_METADATA_BYTES) return null;
  // Control characters would travel into a JSON Operation input and a log line.
  return /[\x00-\x1f\x7f]/.test(trimmed) ? null : trimmed;
}

/**
 * The stable key a delivery is deduplicated and dispatched under.
 *
 * `keySource` comes from `readSignedDeliveryIdentity` and is therefore derived
 * from the verified body and nothing else — this function takes no header value
 * and there is no overload that does, which is the structural half of the
 * guarantee that an unsigned header cannot earn a dispatch or suppress one.
 * The sources are domain-separated (`b:` / `f:`), so a digest and a field
 * identity can never collide.
 *
 * Stable across retries by construction, which is what makes it usable as the
 * Operation's idempotency key; header-safe by construction, because the durable
 * broker puts it in an HTTP header.
 */
export function inboundDeliveryKey(endpointId: string, keySource: string): string {
  return `inbound.${endpointId}.${createHash("sha256").update(keySource).digest("hex")}`;
}

export function createInboundAdmission(options: InboundAdmissionOptions) {
  const log = options.log ?? (() => undefined);

  return async function admit(request: InboundAdmissionRequest): Promise<RuntimeInboundAdmission> {
    if (typeof request.endpointKey !== "string" || request.endpointKey.length > 64 ||
      !INBOUND_ENDPOINT_KEY.test(request.endpointKey) || !UUID.test(request.endpointId ?? "")) {
      return { outcome: "rejected" };
    }
    if (!(request.body instanceof Uint8Array) || request.body.byteLength > INBOUND_MAX_BODY_BYTES) {
      return { outcome: "rejected" };
    }
    // A host without the keyring can neither verify nor keep anything. Said
    // before the lookup, so the answer discloses nothing about registrations.
    const keyring = options.keyring();
    if (!keyring) {
      log({ code: "INBOUND_KEYRING_MISSING" });
      return { outcome: "unavailable" };
    }

    const found: EndpointTenantLookup = await options.store
      .tenantForEndpoint(request.endpointId)
      .then((tenantId) => ({ failed: false as const, tenantId }), () => {
        log({ code: "INBOUND_LOOKUP_FAILED", endpointId: request.endpointId });
        return { failed: true as const };
      });
    if (found.failed) return { outcome: "unavailable" };
    if (!found.tenantId || !UUID.test(found.tenantId)) return { outcome: "rejected" };
    // A const, so the narrowing survives into the callback below: a `let`
    // loses it at the function boundary and every use becomes `string |
    // undefined`.
    const tenantId: string = found.tenantId;

    try {
      return await options.store.withTenant(tenantId, async (trx) => {
        const endpoint = await trx.readEndpoint(request.endpointId);
        // The tenant and the endpoint key are re-checked against the row that
        // was actually read: the point lookup bypasses the tenant policy for
        // its own statement, so nothing downstream may assume it agreed.
        if (!endpoint || endpoint.tenantId !== tenantId || endpoint.id !== request.endpointId ||
          endpoint.endpointKey !== request.endpointKey || endpoint.status !== "active") {
          return { outcome: "rejected" } as const;
        }
        const scheme = normalizeInboundSignatureScheme(endpoint.signature);
        if (!scheme) {
          log({ code: "INBOUND_SCHEME_INVALID", endpointId: endpoint.id, tenantId });
          return { outcome: "rejected" } as const;
        }
        let secret: string;
        try {
          secret = decryptSecret(keyring, `${tenantId}:${endpoint.id}`, INBOUND_SECRET_FIELD, endpoint.storedSecret);
        } catch {
          // A row sealed under a key this host no longer has. Reported as an
          // ordinary refusal rather than a distinguishable configuration
          // answer: the caller must not learn that the endpoint exists.
          log({ code: "INBOUND_SECRET_UNREADABLE", endpointId: endpoint.id, tenantId });
          return { outcome: "rejected" } as const;
        }
        const verified = verifyInboundSignature({
          scheme, secret, body: request.body,
          presented: request.header(scheme.header),
          maxBodyBytes: endpoint.maxBodyBytes,
        });
        if (!verified) return { outcome: "rejected" } as const;

        // Everything below reads VERIFIED bytes. The identity, and therefore
        // the delivery key, comes from them; the two unsigned headers are read
        // afterwards and go nowhere near it.
        const bodySha256 = createHash("sha256").update(request.body).digest("hex");
        const identity = readSignedDeliveryIdentity(endpoint.identity, request.body, bodySha256);
        if (!identity) {
          // A declared identity path this authentic body does not carry. Said
          // as an ordinary refusal so the route stays a non-oracle, and logged,
          // because it means the registration's profile and the provider's
          // payload disagree — an operator question, not a tenant one.
          log({ code: "INBOUND_IDENTITY_UNREADABLE", endpointId: endpoint.id, tenantId });
          return { outcome: "rejected" } as const;
        }
        const deliveryId = randomUUID();
        let sealedBody: StoredSecret;
        try {
          sealedBody = encryptSecret(
            keyring, inboundBodyScope(tenantId, endpoint.id, deliveryId), INBOUND_BODY_FIELD,
            Buffer.from(request.body).toString("base64"),
          );
        } catch {
          // The host can verify but not seal: its own problem, and answering
          // `accepted` for a payload nothing could keep would be a lie.
          log({ code: "INBOUND_BODY_SEAL_FAILED", endpointId: endpoint.id, tenantId });
          return { outcome: "unavailable" } as const;
        }
        const recorded = await trx.recordDelivery({
          endpoint, deliveryId, eventType: identity.eventType,
          unsignedProviderDeliveryId: endpoint.unsignedHeaders.deliveryId
            ? metadata(request.header(endpoint.unsignedHeaders.deliveryId)) : null,
          unsignedEventType: endpoint.unsignedHeaders.eventType
            ? metadata(request.header(endpoint.unsignedHeaders.eventType)) : null,
          bodySha256, bodyBytes: request.body.byteLength, sealedBody,
          idempotencyKey: inboundDeliveryKey(endpoint.id, identity.keySource),
        });
        return {
          outcome: recorded.created ? "accepted" : "duplicate", deliveryId: recorded.deliveryId,
        } as const;
      });
    } catch {
      // The receipt and its work commit together; a failure here means NEITHER
      // was kept, so the only honest answer is that nothing was accepted.
      log({ code: "INBOUND_PERSIST_FAILED", endpointId: request.endpointId, tenantId });
      return { outcome: "unavailable" };
    }
  };
}

export type InboundAdmission = ReturnType<typeof createInboundAdmission>;
