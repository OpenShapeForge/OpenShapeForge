// SPDX-License-Identifier: BUSL-1.1
/**
 * RFC 7591 dynamic registration of ONE public OAuth client at a remote MCP
 * server's authorization server, as a step that decides nothing else.
 *
 * `native-oauth-discovery.ts` reads what a live server publishes; this module is
 * the next step and keeps the same discipline. It holds no transport: the caller
 * injects `RegistrationFetch`, so there is no `fetch` in scope here and the
 * derived request can only ever be dialled through whatever gate the caller
 * already owns (egress allow-list, address pinning, timeout, byte budget). What
 * this module contributes is the registration request the specification wants
 * for a public client, and the checks that decide whether the answer may be
 * believed.
 *
 * It registers a PUBLIC client and nothing else:
 *
 *   token_endpoint_auth_method   "none"
 *   grant_types                  authorization_code, plus refresh_token when advertised
 *   response_types               code
 *   redirect_uris                exactly the one URI the caller named
 *
 * There is no client secret anywhere in this module — none is sent, and a
 * server that answers with one has not registered what was asked for, so its
 * answer is refused rather than stored. A credential the specification does
 * allow alongside a successful registration (the RFC 7592 management token and
 * URI) is dropped from the retained metadata: this module's result is meant to
 * be persisted, and nothing persisted here may be a secret. No message, and
 * nothing returned, repeats a value a server sent under those names.
 *
 * The division of labour with `entity-oauth-profile.ts` is the same one
 * discovery draws. Here: whether the server offers a public authorization-code
 * client at all (asking for what it cannot do would register a client nothing
 * can use), and whether its answer matches the request. There: the full
 * capability judgement — PKCE `S256`, audiences, resource indicators — once a
 * client is known. This module does not re-decide any of that, so the two
 * cannot disagree about whether a server is usable.
 *
 * The authorization request, the token exchange and persistence are out of
 * scope. `RegisteredPublicClient` is the shape a caller may store; storing it,
 * and deciding for which tenant and actor, belongs to runtime wiring.
 */
import { HttpError } from "../rest/http-error.js";
import type { DiscoveredAuthorizationServer } from "./native-oauth-discovery.js";

type JsonRecord = Record<string, unknown>;

/**
 * A registration response is a client's own metadata — a few hundred bytes in
 * practice — so this budget is generous and still finite. It is passed to the
 * injected fetch, which is the side that can stop reading, and re-checked on
 * what comes back: a caller that ignores the budget must not be able to hand
 * this module an unbounded document.
 */
export const MAX_REGISTRATION_BYTES = 64 * 1024;

/**
 * A display name is shown to the person granting consent, so it is held to
 * something a consent screen can render. The bound is on the request this
 * module builds, not on a server's taste.
 */
export const MAX_CLIENT_NAME_LENGTH = 128;

/** Opaque, but an identifier this long is a malformed answer, not an identifier. */
const MAX_CLIENT_ID_LENGTH = 512;

const JSON_MEDIA_TYPE = /^application\/(?:[a-z0-9.!#$&^_-]+\+)?json$/;

/** C0, C1 and the Unicode separators; none belongs in a name or an identifier. */
const CONTROL_OR_SEPARATOR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Keys that carry, or describe, a client credential. A `client_secret` means
 * the server did not register a public client and its answer is refused. The
 * rest are dropped from the retained metadata so that persisting the result
 * cannot persist a secret.
 */
const CREDENTIAL_KEYS = [
  "client_secret",
  "client_secret_expires_at",
  "registration_access_token",
  "registration_client_uri",
] as const;

export const REQUESTED_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
export const REQUESTED_RESPONSE_TYPES = ["code"] as const;

/** RFC 7591 §2 metadata for a public client; what this module POSTs, verbatim. */
export type PublicClientRegistrationBody = {
  client_name: string;
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
  redirect_uris: string[];
  application_type: "web";
};

export type RegistrationFetchRequest = {
  /** The authorization server's own `registration_endpoint`, validated here. */
  url: string;
  /** The serialized RFC 7591 body; `application/json`, and never a credential. */
  body: string;
  /**
   * The caller must stop reading past this many bytes rather than buffer the
   * whole body and report its size afterwards.
   */
  maxResponseBytes: number;
};

/**
 * What the injected fetch must return. The caller owns the request; these are
 * the facts this module needs to decide whether the answer may be believed.
 *
 * A caller must NOT follow redirects. A registration answer is trusted because
 * of the endpoint the discovered metadata named, and a followed redirect severs
 * the answer — and the client identity it establishes — from that endpoint. A
 * caller that cannot suppress redirect following must report `redirected` or a
 * final `url`, and the answer is then refused here.
 */
export type RegistrationFetchResponse = {
  status: number;
  /** Media type without parameters, or null when the answer carried none. */
  contentType: string | null;
  /** The decoded body, already held to `maxResponseBytes`. */
  body: string;
  /** The URL the body came from, when it is not the one that was requested. */
  url?: string;
  /** Whether a redirect was followed to produce this answer. */
  redirected?: boolean;
};

export type RegistrationFetch = (
  request: RegistrationFetchRequest,
) => Promise<RegistrationFetchResponse>;

/**
 * One registered public client, in the shape a caller may persist. Every field
 * is either something this module asked for or something the server confirmed;
 * nothing here is a credential.
 */
export type RegisteredPublicClient = {
  /** The issuer the client belongs to; a client_id is worthless anywhere else. */
  issuer: string;
  /** The endpoint that issued it, so a later re-registration is traceable. */
  registrationEndpoint: string;
  clientId: string;
  /** The display name as registered, which a server may have shortened. */
  clientName: string;
  /** The exact redirect URI this client is registered for. */
  redirectUri: string;
  /** Always `none`: this module registers no other kind of client. */
  tokenEndpointAuthMethod: "none";
  grantTypes: string[];
  responseTypes: string[];
  /** The server confirmed the refresh grant, so refresh may be attempted. */
  refreshGranted: boolean;
  /** RFC 7591 `client_id_issued_at`, when the server stated one. */
  clientIdIssuedAt?: number;
  /** The server's own answer, with the credential-bearing keys removed. */
  registrationMetadata: Readonly<JsonRecord>;
};

export type RegisterPublicClientInput = {
  /** Metadata already discovered and validated by `native-oauth-discovery.ts`. */
  authorizationServer: DiscoveredAuthorizationServer;
  /** The name shown to the person granting consent. */
  clientName: string;
  /** The one callback URI, registered and later used exactly as written. */
  redirectUri: string;
};

/** The caller handed this module something that cannot be registered. */
function misconfigured(message: string): HttpError {
  return new HttpError(400, "PROVIDER_MISCONFIGURED", message);
}

/** The remote server answered with something that cannot be believed. */
function unregistrable(message: string): HttpError {
  return new HttpError(502, "OAUTH_REGISTRATION_FAILED", message);
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function parsedUrl(value: unknown): URL | undefined {
  try {
    return typeof value === "string" ? new URL(value) : undefined;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(entry => typeof entry === "string")
    ? (value as string[])
    : undefined;
}

/**
 * The redirect URI, which is both registered and later compared character for
 * character. An https URI without credentials or a fragment, and carrying no
 * wildcard: a pattern would register something broader than the one callback
 * this client is for. It is never normalized — the string registered here is
 * the string the authorization request must send.
 */
function assertRedirectUri(redirectUri: string): URL {
  const url = parsedUrl(redirectUri);
  if (url?.protocol !== "https:" || url.username || url.password || url.hash) {
    throw misconfigured("The redirect URI must be an absolute https URI without credentials or a fragment.");
  }
  if (redirectUri.includes("*") || url.href !== redirectUri) {
    throw misconfigured("The redirect URI must be registered exactly as it will be sent, without a wildcard.");
  }
  return url;
}

/**
 * Whether the server offers the client this module is about to ask for. RFC
 * 8414's defaults are the point: an omitted auth-method list means
 * `client_secret_basic` alone and an omitted grant list means no refresh, so an
 * absent list is never read as permission. Registering a client the server
 * cannot authenticate would leave an unusable client behind on both sides.
 */
function assertPublicClientSupported(metadata: Readonly<JsonRecord>): void {
  const authMethods = stringList(metadata.token_endpoint_auth_methods_supported)
    ?? ["client_secret_basic"];
  if (!authMethods.includes("none")) {
    throw new HttpError(
      400,
      "OAUTH_CLIENT_AUTH_UNSUPPORTED",
      "The authorization server does not offer public clients.",
    );
  }
  const grants = stringList(metadata.grant_types_supported) ?? ["authorization_code", "implicit"];
  if (!grants.includes("authorization_code")) {
    throw misconfigured("The authorization server does not offer the authorization_code grant.");
  }
  const responseTypes = stringList(metadata.response_types_supported);
  if (responseTypes && !responseTypes.includes("code")) {
    throw misconfigured("The authorization server does not offer the code response type.");
  }
}

/**
 * The discovered `registration_endpoint`. Discovery already held every endpoint
 * it saw to https, and checking it again here costs nothing and means this
 * module does not depend on that for the one URL it dials.
 */
function assertRegistrationEndpoint(server: DiscoveredAuthorizationServer): string {
  const endpoint = server.registrationEndpoint;
  if (endpoint === undefined) {
    throw new HttpError(
      400,
      "OAUTH_REGISTRATION_UNSUPPORTED",
      "The authorization server publishes no dynamic client registration endpoint.",
    );
  }
  const url = parsedUrl(endpoint);
  if (url?.protocol !== "https:" || url.username || url.password || url.hash) {
    throw misconfigured("The registration endpoint must be an absolute https URL without credentials or a fragment.");
  }
  return endpoint;
}

/** The display name, held to something a consent screen can render. */
function assertClientName(clientName: string): string {
  const name = clientName.trim();
  if (!name || name.length > MAX_CLIENT_NAME_LENGTH || CONTROL_OR_SEPARATOR.test(name)) {
    throw misconfigured(
      `The client name must be text of 1 to ${MAX_CLIENT_NAME_LENGTH} characters without control characters.`,
    );
  }
  return name;
}

/**
 * The RFC 7591 body for this client, exposed so a caller can show what is sent.
 *
 * `application_type` is `web` because that is what this client is: OpenID
 * Connect Dynamic Client Registration §2 gives `web` the https redirect URIs
 * and the server-side flow a gateway callback has. A native client's loopback
 * and private-use-scheme rules are a different contract, and
 * `assertRedirectUri` has already ruled those redirects out.
 */
export function publicClientRegistrationBody(
  input: RegisterPublicClientInput,
): PublicClientRegistrationBody {
  const supported = stringList(input.authorizationServer.serverMetadata.grant_types_supported)
    ?? ["authorization_code", "implicit"];
  return {
    client_name: assertClientName(input.clientName),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", ...(supported.includes("refresh_token") ? ["refresh_token"] : [])],
    response_types: [...REQUESTED_RESPONSE_TYPES],
    redirect_uris: [assertRedirectUri(input.redirectUri).href],
    application_type: "web",
  };
}

/**
 * Read the answer, and believe only a well-formed one.
 *
 * RFC 7591 §3.2.1 specifies 201 Created; servers that answer 200 are common
 * enough and say the same thing, so both are read. Every other status is a
 * refusal, including the §3.2.2 error body — upstream-controlled text never
 * reaches a message, so a failure is described by its status alone.
 */
function registrationDocument(
  url: string,
  response: RegistrationFetchResponse,
): JsonRecord {
  const what = "The client registration response";
  if (response.redirected === true || (response.url !== undefined && response.url !== url)) {
    throw unregistrable(`${what} came from another URL after a redirect.`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw unregistrable(`${what} was a redirect, which is never followed.`);
  }
  if (response.status !== 201 && response.status !== 200) {
    throw unregistrable(`${what} refused the registration (answered ${response.status}).`);
  }
  if (Buffer.byteLength(response.body) > MAX_REGISTRATION_BYTES) {
    throw unregistrable(`${what} exceeds the supported size.`);
  }
  const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== undefined && !JSON_MEDIA_TYPE.test(mediaType)) {
    throw unregistrable(`${what} is not a JSON document.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw unregistrable(`${what} is not valid JSON.`);
  }
  const document = asRecord(parsed);
  if (!document) throw unregistrable(`${what} is not a JSON object.`);
  return document;
}

/** RFC 7591 §3.2.1: an opaque string, which still has to be one. */
function registeredClientId(document: JsonRecord): string {
  const clientId = document.client_id;
  if (
    typeof clientId !== "string"
    || !clientId.trim()
    || clientId.length > MAX_CLIENT_ID_LENGTH
    || CONTROL_OR_SEPARATOR.test(clientId)
  ) {
    throw unregistrable("The client registration response names no usable client_id.");
  }
  return clientId;
}

/**
 * The answer must describe the client that was asked for.
 *
 * `token_endpoint_auth_method` is required to be present and `none`: RFC 7591
 * §3.2.1 has the server return the client's registered metadata, and an omitted
 * value carries the RFC 7591 §2 default of `client_secret_basic` — a
 * confidential client, which is not what was requested. `redirect_uris` is
 * checked when returned, and must then be exactly the one URI: a server that
 * adds another has registered a client that may send a code somewhere else.
 */
function assertRegisteredClientMatches(document: JsonRecord, redirectUri: string): void {
  if (document.client_secret !== undefined && document.client_secret !== null) {
    throw new HttpError(
      502,
      "OAUTH_CLIENT_AUTH_UNSUPPORTED",
      "The client registration response issued a client secret, so no public client was registered.",
    );
  }
  if (document.token_endpoint_auth_method !== "none") {
    throw new HttpError(
      502,
      "OAUTH_CLIENT_AUTH_UNSUPPORTED",
      "The client registration response does not confirm public client authentication.",
    );
  }
  const redirectUris = document.redirect_uris;
  if (redirectUris !== undefined) {
    const registered = stringList(redirectUris);
    if (registered?.length !== 1 || registered[0] !== redirectUri) {
      throw new HttpError(
        502,
        "OAUTH_REDIRECT_MISMATCH",
        "The client registration response registered other redirect URIs than the one requested.",
      );
    }
  }
  const grants = document.grant_types;
  if (grants !== undefined && !stringList(grants)?.includes("authorization_code")) {
    throw unregistrable("The client registration response withheld the authorization_code grant.");
  }
  const responseTypes = document.response_types;
  if (responseTypes !== undefined && !stringList(responseTypes)?.includes("code")) {
    throw unregistrable("The client registration response withheld the code response type.");
  }
}

/** A finite, non-negative RFC 7591 timestamp, or nothing. */
function issuedAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** The server's answer with every credential-bearing key removed. */
function withoutCredentials(document: JsonRecord): JsonRecord {
  const retained = { ...document };
  for (const key of CREDENTIAL_KEYS) delete retained[key];
  return retained;
}

/**
 * Register one public client and return what may be persisted about it.
 *
 * The request asserts a public client; the answer is only believed when it
 * describes the same one. Nothing is retried: a second POST to a conformant
 * server registers a SECOND client, so a caller that wants another attempt has
 * to decide that itself.
 */
export async function registerPublicClient(
  input: RegisterPublicClientInput,
  fetchRegistration: RegistrationFetch,
): Promise<RegisteredPublicClient> {
  const body = publicClientRegistrationBody(input);
  assertPublicClientSupported(input.authorizationServer.serverMetadata);
  const url = assertRegistrationEndpoint(input.authorizationServer);
  const redirectUri = body.redirect_uris[0]!;

  const response = await fetchRegistration({
    url,
    body: JSON.stringify(body),
    maxResponseBytes: MAX_REGISTRATION_BYTES,
  });
  const document = registrationDocument(url, response);
  const clientId = registeredClientId(document);
  assertRegisteredClientMatches(document, redirectUri);

  const grantTypes = stringList(document.grant_types) ?? body.grant_types;
  const clientIdIssuedAt = issuedAt(document.client_id_issued_at);
  const registeredName = typeof document.client_name === "string" && document.client_name.trim()
    ? document.client_name
    : body.client_name;

  return {
    issuer: input.authorizationServer.issuer,
    registrationEndpoint: url,
    clientId,
    clientName: registeredName,
    redirectUri,
    tokenEndpointAuthMethod: "none",
    grantTypes,
    responseTypes: stringList(document.response_types) ?? [...REQUESTED_RESPONSE_TYPES],
    refreshGranted: grantTypes.includes("refresh_token"),
    ...(clientIdIssuedAt === undefined ? {} : { clientIdIssuedAt }),
    registrationMetadata: Object.freeze(withoutCredentials(document)),
  };
}
