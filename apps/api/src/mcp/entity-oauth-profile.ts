// SPDX-License-Identifier: BUSL-1.1
/**
 * What an Adapter's `auth` block declares about its OAuth client and the
 * authorization server behind it, validated once and failing closed.
 *
 * An Adapter that declares none of this keeps the confidential
 * `client_secret_post` flow unchanged. Declaring a public client, a resource
 * indicator (RFC 8707) or server metadata opts into the strict rules:
 *
 *   auth.clientAuthentication       "client_secret_post" (default) or "none"
 *   auth.resource                   the protected resource tokens are minted for
 *   auth.expectedAudiences          `aud` values besides `resource` itself
 *   auth.serverMetadata             RFC 8414 document, verified by whoever
 *                                   authored the Adapter
 *   auth.protectedResourceMetadata  RFC 9728 document, likewise
 *
 * The metadata documents are configuration, never fetched here: nothing in a
 * request or a callback can name a URL this module will believe. They are
 * checked against the declared endpoints and the Adapter's egress allow-list,
 * so a document cannot widen where a token or a code travels.
 */
import { hostAllowed } from "../modules/egress.js";
import { assertOutboundTls } from "../modules/outbound-response.js";
import { HttpError } from "../rest/http-error.js";

type JsonRecord = Record<string, unknown>;

export type OAuthClientAuthentication = "none" | "client_secret_post";

export type OAuthClientProfile = {
  clientAuthentication: OAuthClientAuthentication;
  resource?: string;
  /** `aud` values that identify this resource; empty when no resource is declared. */
  audiences: string[];
  issuer?: string;
  /** The server promised RFC 9207 `iss`, so a callback without it is refused. */
  issuerResponseRequired: boolean;
  metadataEndpoints?: { authorization: string; token: string };
  /** The server's metadata rules out the refresh grant. */
  refreshUnsupported: boolean;
  /** A stated grant with a shortfall stores nothing. */
  strictGrants: boolean;
};

/** Where a token set came from; a change of either needs a fresh consent. */
export type OAuthTokenBinding = {
  resource: string | null;
  issuer: string | null;
};

function misconfigured(message: string): HttpError {
  return new HttpError(400, "PROVIDER_MISCONFIGURED", message);
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** RFC 8707: an absolute https URI without a fragment; compared in normal form. */
function canonicalResource(value: unknown, label: string): string {
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "https:" || url.username || url.password || url.hash) {
    throw misconfigured(`${label} must be an absolute https URI without a fragment.`);
  }
  return url.href;
}

/** RFC 8414: an https URL without query or fragment, compared as written. */
function issuerOf(metadata: JsonRecord): string {
  const issuer = metadata.issuer;
  let url: URL | undefined;
  try {
    url = typeof issuer === "string" ? new URL(issuer) : undefined;
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw misconfigured("auth.serverMetadata.issuer must be an https URL without query or fragment.");
  }
  return issuer as string;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

/**
 * Whether this `auth` opts into the strict rules. Separate from
 * `oauthClientProfile` for readers that must not throw on a malformed block.
 */
export function strictOAuthGrants(auth: unknown): boolean {
  const record = asRecord(auth);
  return (
    record?.clientAuthentication === "none" ||
    record?.resource !== undefined ||
    record?.serverMetadata !== undefined
  );
}

export function oauthClientProfile(auth: unknown): OAuthClientProfile {
  const record = asRecord(auth) ?? {};
  const declared = record.clientAuthentication ?? "client_secret_post";
  if (declared !== "none" && declared !== "client_secret_post") {
    throw new HttpError(
      400,
      "OAUTH_CLIENT_AUTH_UNSUPPORTED",
      'auth.clientAuthentication must be "none" or "client_secret_post".',
    );
  }
  const clientAuthentication = declared as OAuthClientAuthentication;
  const resource =
    record.resource === undefined
      ? undefined
      : canonicalResource(record.resource, "auth.resource");
  const expected = stringList(record.expectedAudiences);
  if (record.expectedAudiences !== undefined && (!resource || !expected?.length)) {
    throw misconfigured("auth.expectedAudiences needs auth.resource and at least one value.");
  }

  const profile: OAuthClientProfile = {
    clientAuthentication,
    ...(resource ? { resource } : {}),
    audiences: resource ? [resource, ...(expected ?? [])] : [],
    issuerResponseRequired: false,
    refreshUnsupported: false,
    strictGrants: strictOAuthGrants(record),
  };

  if (record.serverMetadata !== undefined) {
    const metadata = asRecord(record.serverMetadata);
    if (!metadata) throw misconfigured("auth.serverMetadata must be an object.");
    profile.issuer = issuerOf(metadata);
    const authorization = metadata.authorization_endpoint;
    const token = metadata.token_endpoint;
    if (typeof authorization !== "string" || typeof token !== "string") {
      throw misconfigured("auth.serverMetadata names no authorization and token endpoints.");
    }
    profile.metadataEndpoints = { authorization, token };
    profile.issuerResponseRequired =
      metadata.authorization_response_iss_parameter_supported === true;

    // RFC 8414 defaults: an omitted auth-method list means client_secret_basic
    // alone, an omitted grant list means no refresh. Neither default helps here.
    const authMethods = stringList(metadata.token_endpoint_auth_methods_supported) ?? ["client_secret_basic"];
    if (!authMethods.includes(clientAuthentication)) {
      throw new HttpError(
        400,
        "OAUTH_CLIENT_AUTH_UNSUPPORTED",
        `The authorization server does not offer ${clientAuthentication} client authentication.`,
      );
    }
    const grants = stringList(metadata.grant_types_supported) ?? ["authorization_code", "implicit"];
    if (!grants.includes("authorization_code")) {
      throw misconfigured("The authorization server does not offer the authorization_code grant.");
    }
    profile.refreshUnsupported = !grants.includes("refresh_token");
    // Without S256 the metadata gives no assurance the challenge is checked.
    if (!stringList(metadata.code_challenge_methods_supported)?.includes("S256")) {
      throw misconfigured("The authorization server does not advertise PKCE S256.");
    }
    const responseTypes = stringList(metadata.response_types_supported);
    if (responseTypes && !responseTypes.includes("code")) {
      throw misconfigured("The authorization server does not offer the code response type.");
    }
  }

  if (record.protectedResourceMetadata !== undefined) {
    const document = asRecord(record.protectedResourceMetadata);
    if (!document || !resource) {
      throw misconfigured("auth.protectedResourceMetadata needs auth.resource and must be an object.");
    }
    if (canonicalResource(document.resource, "protectedResourceMetadata.resource") !== resource) {
      throw new HttpError(400, "OAUTH_AUDIENCE_MISMATCH", "The protected resource metadata names another resource.");
    }
    if (profile.issuer === undefined) {
      throw misconfigured("auth.protectedResourceMetadata needs auth.serverMetadata.");
    }
    if (!stringList(document.authorization_servers)?.includes(profile.issuer)) {
      throw new HttpError(400, "OAUTH_AUDIENCE_MISMATCH", "The protected resource does not name this authorization server.");
    }
  }
  return profile;
}

/**
 * The resolved token endpoint, against the metadata and the allow-list, ahead
 * of every use of a code or refresh token. The resource host is held to the
 * same list: the token is only ever worth anything there. Legacy Adapters keep
 * their existing checks at the request itself.
 */
export function assertOAuthTokenEndpoint(
  profile: OAuthClientProfile,
  tokenUrl: string,
  egress: readonly string[],
): void {
  if (!profile.strictGrants) return;
  if (profile.metadataEndpoints && profile.metadataEndpoints.token !== tokenUrl) {
    throw misconfigured("The declared token endpoint differs from the server metadata.");
  }
  const token = new URL(tokenUrl);
  assertOutboundTls(token);
  for (const url of [token, ...(profile.resource ? [new URL(profile.resource)] : [])]) {
    if (!hostAllowed(url.hostname, egress)) {
      throw new HttpError(
        403,
        "EGRESS_DENIED",
        `OAuth endpoint host ${url.hostname} is outside the provider's egress allow-list.`,
      );
    }
  }
}

/** The same before a consent link exists, with the browser-only endpoint added. */
export function assertOAuthEndpoints(
  profile: OAuthClientProfile,
  endpoints: { authorizationUrl: string; tokenUrl: string; egress: readonly string[] },
): void {
  if (!profile.strictGrants) return;
  if (
    profile.metadataEndpoints &&
    profile.metadataEndpoints.authorization !== endpoints.authorizationUrl
  ) {
    throw misconfigured("The declared authorization endpoint differs from the server metadata.");
  }
  assertOutboundTls(new URL(endpoints.authorizationUrl));
  assertOAuthTokenEndpoint(profile, endpoints.tokenUrl, endpoints.egress);
}

export function tokenBindingOf(profile: OAuthClientProfile | undefined): OAuthTokenBinding {
  return { resource: profile?.resource ?? null, issuer: profile?.issuer ?? null };
}

/**
 * Whether stored tokens were minted for what the Adapter declares now. Absent
 * on both sides is the legacy case. Reads only the plain fields, so it cannot
 * throw for a row whose Adapter is otherwise misconfigured.
 */
export function tokenBindingCurrent(profile: OAuthClientProfile, values: unknown): boolean {
  const stored = asRecord(asRecord(values)?.oauthBinding);
  const expected = tokenBindingOf(profile);
  return (
    (stored?.resource ?? null) === expected.resource &&
    (stored?.issuer ?? null) === expected.issuer
  );
}

/**
 * The effective scopes recorded at exchange, with their provenance stored
 * separately. A requested set on its own is not a recorded grant.
 */
export function grantedScopesOf(auth: unknown, values: unknown): unknown {
  const record = asRecord(values);
  void auth;
  return Array.isArray(record?.grantedScopes) ? record.grantedScopes : undefined;
}

function audiencesOfJwt(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return asRecord(claims)?.aud;
  } catch {
    return undefined;
  }
}

function sameAudience(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

/**
 * Refuse a token set that says it is for another audience. Sources are the
 * response's own `resource`/`aud` and an `aud` claim in a JWT access token.
 * The JWT is not verified, which is sound for this one use: it can only turn
 * an acceptance into a refusal. An opaque token with neither proves nothing
 * either way and is accepted, the resource server being the final judge.
 */
export function tokenResponseAudienceMismatch(
  profile: OAuthClientProfile | undefined,
  payload: { access_token?: unknown; resource?: unknown; aud?: unknown },
): boolean {
  if (!profile?.resource) return false;
  const claims = [
    payload.resource,
    payload.aud,
    typeof payload.access_token === "string" ? audiencesOfJwt(payload.access_token) : undefined,
  ];
  return claims.some((claim) => {
    if (claim === undefined || claim === null) return false;
    const values = typeof claim === "string" ? [claim] : (stringList(claim) ?? []);
    return !values.some((value) =>
      profile.audiences.some((audience) => sameAudience(value, audience)),
    );
  });
}

/**
 * RFC 9207 on the callback. `iss` is compared, never followed: the expected
 * value comes from the pending state. Returns whether the response is refused.
 */
export function callbackIssuerMismatch(
  profile: OAuthClientProfile | undefined,
  iss: unknown,
): boolean {
  if (!profile?.issuer) return false;
  if (iss === undefined || iss === null) return profile.issuerResponseRequired;
  return iss !== profile.issuer;
}
