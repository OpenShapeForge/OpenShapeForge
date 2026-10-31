// SPDX-License-Identifier: BUSL-1.1
/**
 * A delivery's identity, read only from material the provider signed.
 *
 * This file exists because the obvious implementation is wrong in a way that
 * reads fine. A provider webhook carries a convenient delivery id in a header —
 * Jira sends `X-Atlassian-Webhook-Identifier` — and keying duplicate
 * suppression on it looks like exactly what it is for. It is not: the provider's
 * HMAC covers the BODY. The header is not in the signature, so anyone who ever
 * captured one valid delivery can resend those exact bytes with that exact
 * signature and any id they like. Two failures follow from one mistake:
 *
 *   - a captured delivery replayed with a FRESH id is a new key, so it is
 *     admitted and dispatched again, however many times the attacker likes;
 *   - a genuine new delivery whose id the attacker has already burned is a
 *     duplicate, so it is silently suppressed — a delete event, say, that the
 *     tenant never processes.
 *
 * Nothing here reads a header. The two admitted sources are the digest of the
 * verified bytes and declared paths inside the verified JSON body, and both are
 * inside the signature by construction.
 *
 * ## What this cannot do
 *
 * Only the provider can authenticate an event identity. `body-digest` says two
 * deliveries are the same event exactly when they are the same bytes; a
 * provider that re-sends byte-identical bodies for distinct events, and signs
 * no event identity, is irreducibly ambiguous and the second delivery is
 * suppressed. `body-field` escapes that, but only where the provider actually
 * puts an identity in the payload. Neither is a general solution, and this
 * module claims none.
 */
import type { RuntimeInboundDeliveryIdentity, RuntimeInboundIdentitySource } from "@openshapeforge/plugin-runtime";
import { RUNTIME_INBOUND_IDENTITY_SOURCES } from "@openshapeforge/plugin-runtime";

/**
 * One dotted path of own JSON object property names. No array indexing, no
 * commas — the serialized column form joins paths with one, and a comma inside
 * a path would move the boundary between two of them.
 */
export const INBOUND_IDENTITY_PATH =
  /^[A-Za-z_][A-Za-z0-9_-]{0,63}(\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,5}$/;

/** Segments that name the prototype chain rather than data. Never walked. */
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

const MAX_IDENTITY_FIELDS = 4;
/** An identity value longer than this is a payload, not an identifier. */
const MAX_IDENTITY_VALUE_LENGTH = 200;
/** A value from the body that is retained as the delivery's event name. */
export const MAX_SIGNED_EVENT_TYPE_LENGTH = 200;

/** The normalised profile, as a registration stores it and admission reads it. */
export type InboundIdentityProfile = {
  source: RuntimeInboundIdentitySource;
  /** Non-empty only for `body-field`, in the order the key is built from. */
  fields: readonly string[];
  eventTypePath: string | null;
};

export const DEFAULT_INBOUND_IDENTITY: InboundIdentityProfile = {
  source: "body-digest", fields: [], eventTypePath: null,
};

function path(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!INBOUND_IDENTITY_PATH.test(trimmed)) return undefined;
  return trimmed.split(".").some((segment) => RESERVED_SEGMENTS.has(segment)) ? undefined : trimmed;
}

/**
 * The profile, or `undefined` for anything this host will not store. Returns
 * rather than throws: registration turns it into a named refusal naming the
 * field, admission turns it into an ordinary rejection, and both are refusals.
 */
export function normalizeInboundIdentity(input: unknown): InboundIdentityProfile | undefined {
  if (input === undefined || input === null) return DEFAULT_INBOUND_IDENTITY;
  if (typeof input !== "object") return undefined;
  const candidate = input as Partial<RuntimeInboundDeliveryIdentity>;
  const source = candidate.source;
  if (!(RUNTIME_INBOUND_IDENTITY_SOURCES as readonly unknown[]).includes(source)) return undefined;
  let eventTypePath: string | null = null;
  if (candidate.eventTypePath !== undefined) {
    const parsed = path(candidate.eventTypePath);
    if (!parsed) return undefined;
    eventTypePath = parsed;
  }
  if (source === "body-digest") {
    // An unused `fields` would read as if it were in force. Refused, so a
    // profile never claims an identity the key does not actually use.
    if (candidate.fields !== undefined) return undefined;
    return { source: "body-digest", fields: [], eventTypePath };
  }
  const declared = candidate.fields;
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > MAX_IDENTITY_FIELDS) {
    return undefined;
  }
  const fields: string[] = [];
  for (const entry of declared) {
    const parsed = path(entry);
    // A repeated path would weight one value twice and identify nothing more.
    if (!parsed || fields.includes(parsed)) return undefined;
    fields.push(parsed);
  }
  return { source: "body-field", fields, eventTypePath };
}

/** The column form: the paths, comma-joined. `null` when there are none. */
export function serializeInboundIdentityFields(fields: readonly string[]): string | null {
  return fields.length === 0 ? null : fields.join(",");
}

/**
 * The stored column back to paths, or `undefined` when ANY entry is no longer a
 * usable path. All or nothing on purpose: dropping one unusable path would
 * silently change which values identify a delivery, which is a different
 * identity under the same registration — and the database's own check is shape
 * only, so `__proto__` reaches here as a well-formed entry.
 */
export function parseInboundIdentityFields(stored: string | null): readonly string[] | undefined {
  if (!stored) return [];
  const parsed = stored.split(",").map((entry) => path(entry));
  return parsed.every((entry): entry is string => entry !== undefined)
    ? parsed as string[] : undefined;
}

/**
 * The profile a stored registration row declares. A row whose profile no longer
 * normalises answers `undefined`, which admission refuses — a row that cannot
 * say how its deliveries are identified must not have them guessed at.
 */
export function storedInboundIdentity(
  row: { identity_source: string; identity_fields: string | null; identity_event_type_path: string | null },
): InboundIdentityProfile | undefined {
  let fields: readonly string[] | undefined;
  if (row.identity_source === "body-field") {
    fields = parseInboundIdentityFields(row.identity_fields);
    if (!fields) return undefined;
  }
  return normalizeInboundIdentity({
    source: row.identity_source as RuntimeInboundIdentitySource,
    ...(fields ? { fields } : {}),
    ...(row.identity_event_type_path ? { eventTypePath: row.identity_event_type_path } : {}),
  });
}

/** One own, scalar property reached by a dotted path, or `undefined`. */
function scalarAt(document: unknown, dotted: string): string | undefined {
  let current: unknown = document;
  for (const segment of dotted.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "string") return current;
  if (typeof current === "number") return Number.isFinite(current) ? String(current) : undefined;
  if (typeof current === "boolean") return current ? "true" : "false";
  return undefined;
}

/**
 * The event name from inside the signature, bounded and printable, or null.
 * Bounded because it travels into an Operation input and a log line, and
 * printable for the same reason an unsigned header value is filtered: a
 * newline in a log line is a forged log line.
 */
function signedEventType(payload: Record<string, unknown>, dotted: string): string | null {
  const value = scalarAt(payload, dotted);
  if (value === undefined || value.length > MAX_SIGNED_EVENT_TYPE_LENGTH) return null;
  return /[\u0000-\u001f\u007f]/.test(value) ? null : value;
}

/** The verified bytes as a JSON object, or `undefined`. Never an array. */
function document(body: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The signed identity of one verified delivery.
 *
 * `keySource` is the string the delivery key is derived from and is already
 * domain-separated: `b:` for a digest, `f:` for declared fields. The field form
 * is a JSON array of `[path, value]` pairs in the registration's declared
 * order, so it is injective — a path containing the separator cannot be spelled
 * (INBOUND_IDENTITY_PATH), and JSON escaping keeps a value containing one from
 * shifting a boundary.
 */
export type SignedDeliveryIdentity = {
  keySource: string;
  /** The event name from inside the signature, or null when none was declared. */
  eventType: string | null;
};

/**
 * Read the identity, or `undefined` when this delivery cannot be identified at
 * all — an unparseable body or a declared identity path that is absent or not
 * scalar. `undefined` is a REFUSAL, deliberately: falling back to the digest
 * would hand a provider two key spaces, and treating an absent field as a
 * stand-in value is how two distinct events collide into one receipt.
 *
 * An `eventTypePath` that cannot be read is NOT a refusal in `body-digest`
 * mode: the bytes are authentic, nothing about the key depends on it, and a
 * null event name makes a plugin that routes on it fail closed.
 */
export function readSignedDeliveryIdentity(
  profile: InboundIdentityProfile, body: Uint8Array, bodySha256: string,
): SignedDeliveryIdentity | undefined {
  // Parsed at most once, and only when the profile actually needs the body
  // read: a digest-only registration never pays for a JSON parse.
  const parsed = profile.source === "body-field" || profile.eventTypePath
    ? document(body) : undefined;
  const eventType = profile.eventTypePath && parsed
    ? signedEventType(parsed, profile.eventTypePath) : null;
  if (profile.source === "body-digest") return { keySource: `b:${bodySha256}`, eventType };
  if (!parsed) return undefined;

  const pairs: [string, string][] = [];
  for (const field of profile.fields) {
    const value = scalarAt(parsed, field);
    if (value === undefined || value.length > MAX_IDENTITY_VALUE_LENGTH) return undefined;
    pairs.push([field, value]);
  }
  return { keySource: `f:${JSON.stringify(pairs)}`, eventType };
}
