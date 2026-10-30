// SPDX-License-Identifier: BUSL-1.1
/**
 * Authenticated inbound deliveries: the host-owned side of a provider webhook.
 *
 * This is NOT the signed workflow webhook (`./webhook-secrets.js`). That
 * protocol is OpenShapeForge's own — the host mints the secret, the caller
 * signs `timestamp "." eventId "." body`, and the tenant travels in the
 * request. A third-party provider signs what IT decided to sign, and tells
 * nobody our tenant. So the two never share a scheme: a registration here
 * declares the provider's envelope, and the tenant is read from the
 * registration the signature proved possession of — never from the URL, never
 * from a header.
 *
 * What a plugin owns: the product meaning (which adapter, which provider
 * events, which subscription, how an administrator configures it) and the
 * canonical Operation an accepted delivery is dispatched to. What the host
 * owns: the secret at rest, the verification, the tenant, the durable receipt,
 * duplicate suppression and the dispatch's identity. A plugin can neither read
 * the secret back nor name a tenant other than its live session's.
 *
 * ## Only signed material identifies a delivery
 *
 * The host derives a delivery's stable key from the verified BODY and never
 * from a header (see `RUNTIME_INBOUND_IDENTITY_SOURCES`). What that buys is
 * exact: two requests are treated as the same event exactly when the provider
 * signed the same identity. What it cannot buy is a distinction the provider
 * never authenticated — if a provider re-sends a byte-identical body for a
 * genuinely new event and carries no event identity inside it, the second is
 * indistinguishable from a replay and is suppressed as a duplicate. That
 * ambiguity is the provider's, not the host's, and `body-field` is how a
 * provider that does authenticate an event identity escapes it.
 */
/**
 * The hash algorithms an inbound signature may name — the complete set.
 *
 * Explicitly bounded rather than passed through to the crypto library: the
 * registration is tenant-authored configuration, and `createHmac` accepts
 * everything OpenSSL knows, md5 and sha1 included. A provider that signs with
 * something outside this list is a gap to discuss, not a value to forward.
 */
export const RUNTIME_INBOUND_HASH_ALGORITHMS = ["sha256", "sha512"] as const;

export type RuntimeInboundHashAlgorithm = (typeof RUNTIME_INBOUND_HASH_ALGORITHMS)[number];

/** How the signature is spelled in the header: the complete set. */
export const RUNTIME_INBOUND_SIGNATURE_ENCODINGS = ["hex", "base64"] as const;

export type RuntimeInboundSignatureEncoding = (typeof RUNTIME_INBOUND_SIGNATURE_ENCODINGS)[number];

/**
 * Where a delivery's STABLE IDENTITY is read from — and the set is deliberately
 * limited to material the provider's signature covers.
 *
 * A third-party provider signs its body. It does not sign its headers, so a
 * header value is attacker-chosen on any request whose body/signature pair was
 * captured: using one as the deduplication key would let a replay with an
 * altered id earn a second dispatch, and a repeated id with a different
 * authentic body suppress a real event. Neither failure is reachable from here,
 * because no option below reads a header.
 *
 *  - `body-digest` — the digest of the exact verified bytes. Universal: it
 *    needs nothing of the provider beyond the signature itself. Two deliveries
 *    are the same event exactly when they are the same bytes.
 *  - `body-field` — declared paths INSIDE the verified JSON body. For a provider
 *    that re-sends a byte-identical body for genuinely distinct events, or that
 *    varies bytes (a changed field order, an added field) across retries of ONE
 *    event. Every value read is inside the signature, so it is as trustworthy
 *    as the payload the Operation will act on.
 */
export const RUNTIME_INBOUND_IDENTITY_SOURCES = ["body-digest", "body-field"] as const;

export type RuntimeInboundIdentitySource = (typeof RUNTIME_INBOUND_IDENTITY_SOURCES)[number];

/**
 * The signed-identity profile of a registration.
 *
 * Paths are dotted names of own JSON object properties (`issue.id`), at most
 * six deep; no array indexing, and `__proto__`, `constructor` and `prototype`
 * are refused outright. A value must be a string, a finite number or a boolean
 * — a declared path that is absent, or that holds an object, makes the delivery
 * unidentifiable and is REFUSED rather than keyed on a stand-in, because a
 * stand-in is exactly how two distinct events collide into one.
 */
export type RuntimeInboundDeliveryIdentity = {
  source: RuntimeInboundIdentitySource;
  /** Required and non-empty for `body-field`; rejected otherwise. At most four. */
  fields?: readonly string[];
  /**
   * Where the provider's event name lives INSIDE the signed body. The only
   * event name a plugin may route on: it is covered by the signature, unlike
   * any header a provider also happens to send it in.
   */
  eventTypePath?: string;
};

/**
 * The provider's signature envelope, as the registration declared it.
 *
 * Every field is configuration the host read from its own store. Nothing here
 * is ever taken from the request: a delivery cannot announce which header to
 * read, which algorithm to use or that it is unsigned.
 *
 * Jira Cloud's admin webhooks are `{ header: "x-hub-signature",
 * algorithm: "sha256", encoding: "hex", prefix: "sha256=" }`, signed over the
 * exact request bytes.
 */
export type RuntimeInboundSignatureScheme = {
  /** Lowercase header name carrying the signature. */
  header: string;
  algorithm: RuntimeInboundHashAlgorithm;
  encoding: RuntimeInboundSignatureEncoding;
  /** Literal prefix before the digest, e.g. `sha256=`. Compared exactly. */
  prefix?: string;
};

/**
 * What a plugin registers, under a live verified tenant session.
 *
 * The secret is the provider's shared signing secret. It is sealed with the
 * host keyring, bound to tenant and endpoint, and has no read API — rotation
 * is a new registration plus a revocation of the old one, which is also what
 * lets both secrets verify during the provider's own cut-over window.
 */
export type RuntimeInboundEndpointRegistration = {
  /**
   * The provider family, e.g. `jira-admin`. Lowercase, dot/dash separated.
   * It appears in the public URL and identifies the protocol, nothing more:
   * it is not a secret and carries no authority.
   */
  endpointKey: string;
  signature: RuntimeInboundSignatureScheme;
  /** At least 32 bytes. Never logged, never returned, never readable again. */
  secret: string;
  /**
   * How the host identifies this provider's deliveries, from signed material
   * only. Defaults to `{ source: "body-digest" }` — the universal answer, and
   * the right one for a provider whose payload already carries its own event
   * time (Jira Cloud does).
   */
  identity?: RuntimeInboundDeliveryIdentity;
  /**
   * Headers retained VERBATIM beside the receipt, purely so an operator can
   * correlate it with the provider's own console.
   *
   * Not covered by the provider's signature, therefore never the delivery key
   * and never routed on. They reach the dispatched Operation under
   * `envelope.unsigned`, where the name says what they are worth.
   */
  unsignedHeaders?: {
    /** e.g. Jira's `x-atlassian-webhook-identifier`. */
    deliveryId?: string;
    /** The provider's event name as a header. Correlation only — see `identity.eventTypePath`. */
    eventType?: string;
  };
  /**
   * The canonical Operation an accepted delivery is dispatched to, and the
   * input field the host puts its delivery envelope in. The Operation runs
   * under the organization's service identity, authorized live at dispatch;
   * naming it here grants nothing.
   */
  dispatch: { operationId: string; inputField: string };
  /** Lower the host's own ceiling for this endpoint; it can never be raised. */
  maxBodyBytes?: number;
};

export type RuntimeInboundEndpointStatus = "active" | "revoked";

/** A registration as its owner sees it: never the secret, never its ciphertext. */
export type RuntimeInboundEndpoint = {
  id: string;
  tenantId: string;
  endpointKey: string;
  /**
   * The path this endpoint is reached on, relative to the API root. Public and
   * stable; it selects a candidate registration and proves nothing.
   */
  path: string;
  signature: RuntimeInboundSignatureScheme;
  /** Null means the stored identity profile is unusable and admission is refused. */
  identity: RuntimeInboundDeliveryIdentity | null;
  unsignedHeaders: { deliveryId: string | null; eventType: string | null };
  dispatch: { operationId: string; inputField: string };
  maxBodyBytes: number;
  status: RuntimeInboundEndpointStatus;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
};

/**
 * The delivery envelope the host hands the dispatched Operation.
 *
 * `body` is base64 of the exact verified bytes — the host neither parses nor
 * interprets the payload beyond the identity paths the registration declared,
 * so a provider's own content shape stays the plugin's business.
 *
 * The split between `eventType` and `unsigned` is the whole point of this type.
 * `eventType` was read from inside the signature and may decide what happens.
 * `unsigned` was not, and may not: it is correlation material a stranger
 * holding one captured delivery can set to anything.
 */
export type RuntimeInboundDeliveryEnvelope = {
  deliveryId: string;
  endpointId: string;
  endpointKey: string;
  /** From `identity.eventTypePath` inside the verified body, or null. */
  eventType: string | null;
  /** Never signed. Correlation only; routing on these is a vulnerability. */
  unsigned: {
    providerDeliveryId: string | null;
    eventType: string | null;
  };
  receivedAt: string;
  bodySha256: string;
  body: string;
};

/**
 * Host-owned registration of authenticated inbound endpoints. There is
 * deliberately no `verify` and no secret read: admission is the host's HTTP
 * path, so a plugin cannot be handed bytes and asked whether they are genuine.
 */
/** Connection-backed registration performed inside a canonical lifecycle Operation. */
export type RuntimeInboundConnectionRegistration = Omit<RuntimeInboundEndpointRegistration, "secret"> & {
  connectionId: string;
  secretField: string;
  /** Stable per lifecycle intent; a repeated key must name the same endpoint and configuration. */
  idempotencyKey: string;
};
export type RuntimeInboundConnectionRevocation = {
  connectionId: string;
  endpointId: string;
};

export type RuntimeInboundEndpointServices<Session> = {
  /**
   * Verify the exact active endpoint and Connection's confidential signing value without exposing it.
   * The host holds a Connection share lock in the caller's canonical Operation transaction.
   */
  connectionIsCurrent(session: Session, input: { connectionId: string; endpointId: string }): Promise<boolean>;
  registerForConnection(session: Session, input: RuntimeInboundConnectionRegistration): Promise<RuntimeInboundEndpoint>;
  revokeForConnection(session: Session, input: RuntimeInboundConnectionRevocation): Promise<RuntimeInboundEndpoint>;
  /** A live verified tenant session registers for its own tenant and no other. */
  register(session: Session, input: RuntimeInboundEndpointRegistration): Promise<RuntimeInboundEndpoint>;
  /**
   * Stop admitting deliveries for this registration. Idempotent: an already
   * revoked endpoint is reported as it is. Revocation takes effect for the
   * next delivery; it never withdraws an accepted receipt, and the queued
   * dispatch of an accepted delivery is not retracted by it.
   */
  revoke(session: Session, input: { id: string; reason?: string }): Promise<RuntimeInboundEndpoint>;
  list(session: Session, filter?: { endpointKey?: string }): Promise<readonly RuntimeInboundEndpoint[]>;
};

/**
 * The host's answer to a delivery. `rejected` is deliberately reason-free:
 * the route answers an unknown endpoint and a bad signature identically, so a
 * stranger cannot enumerate registrations.
 */
export type RuntimeInboundAdmission =
  | { outcome: "accepted"; deliveryId: string }
  | { outcome: "duplicate"; deliveryId: string }
  | { outcome: "rejected" }
  | { outcome: "unavailable" };
