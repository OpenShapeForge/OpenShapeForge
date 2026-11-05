// SPDX-License-Identifier: BUSL-1.1
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import type { DbSessionInput } from "../db/session.js";
import type { RuntimeModule } from "../modules/contract.js";
import { HttpError } from "../rest/http-error.js";
import { assertOAuthEndpoints, oauthClientProfile, type OAuthClientProfile } from "./entity-oauth-profile.js";
import { readPublicMcpOAuthClient, savePublicMcpOAuthClient, type PublicMcpOAuthClient } from "./native-oauth-client-store.js";
import { discoverMcpOAuthMetadata, type MetadataFetch } from "./native-oauth-discovery.js";
import { registerPublicClient, type RegistrationFetch } from "./native-oauth-registration.js";
import { createOAuthMetadataFetch, createOAuthRegistrationFetch } from "./native-oauth-transport.js";

type Setup = {
  db: OpenShapeForgeDatabase;
  session: DbSessionInput;
  providerTable: string;
  providerId: string;
  providerUpdatedAt: Date | string;
  resource: string;
  redirectUri: string;
  clientName: string;
  auth: Readonly<Record<string, unknown>>;
  egress: readonly string[];
  owner: RuntimeModule["egress"] | undefined;
  signal?: AbortSignal;
  /** Read-only test seams, never supplied by an MCP caller. */
  fetchMetadata?: MetadataFetch;
  fetchRegistration?: RegistrationFetch;
};
export type PreparedMcpOAuth = { clientId: string; authorizationUrl: string; tokenUrl: string; profile: OAuthClientProfile };

/** Revalidate persisted metadata and endpoint grants each time they shape an authorization or refresh. */
export function preparedPublicMcpOAuth(auth: Readonly<Record<string, unknown>>, client: PublicMcpOAuthClient, egress: readonly string[]): PreparedMcpOAuth {
  const metadata = client.metadata;
  const server = metadata.serverMetadata;
  const resource = metadata.protectedResourceMetadata;
  if (!server || typeof server !== "object" || Array.isArray(server) || !resource || typeof resource !== "object" || Array.isArray(resource)) {
    throw new HttpError(400, "PROVIDER_MISCONFIGURED", "Stored MCP OAuth metadata is incomplete.");
  }
  const serverRecord = server as Record<string, unknown>;
  const authorizationUrl = serverRecord.authorization_endpoint;
  const tokenUrl = serverRecord.token_endpoint;
  if (serverRecord.issuer !== client.issuer || typeof authorizationUrl !== "string" || typeof tokenUrl !== "string") {
    throw new HttpError(400, "PROVIDER_MISCONFIGURED", "Stored MCP OAuth metadata no longer matches its issuer.");
  }
  const profile = oauthClientProfile({ ...auth, resource: client.resource, clientAuthentication: "none", serverMetadata: server, protectedResourceMetadata: resource });
  assertOAuthEndpoints(profile, { authorizationUrl, tokenUrl, egress });
  return { clientId: client.clientId, authorizationUrl, tokenUrl, profile };
}

/** Discover once and register a public client automatically; a racing setup reuses the committed client. */
export async function preparePublicMcpOAuth(input: Setup): Promise<PreparedMcpOAuth> {
  const { session } = input;
  if (!session.tenantId || !session.userId) throw new HttpError(403, "FORBIDDEN", "A verified user and tenant are required.");
  const binding = { session, providerTable: input.providerTable, providerId: input.providerId,
    providerUpdatedAt: input.providerUpdatedAt, resource: input.resource, redirectUri: input.redirectUri };
  let existing = await readPublicMcpOAuthClient(input.db, binding);
  if (!existing) {
    const egress = { owner: input.owner, allowlist: input.egress, tenantId: session.tenantId,
      actorId: session.userId, provider: input.providerId, ...(input.signal ? { signal: input.signal } : {}) };
    const discovery = await discoverMcpOAuthMetadata({ resource: input.resource }, input.fetchMetadata ?? createOAuthMetadataFetch(egress));
    // Validate capabilities before registering anything at the provider.
    preparedPublicMcpOAuth(input.auth, { resource: discovery.resource, issuer: discovery.authorizationServer.issuer,
      clientId: "pending", redirectUri: input.redirectUri, metadata: { serverMetadata: discovery.authorizationServer.serverMetadata,
        protectedResourceMetadata: discovery.protectedResourceMetadata } }, input.egress);
    const registered = await registerPublicClient({ authorizationServer: discovery.authorizationServer,
      clientName: input.clientName, redirectUri: input.redirectUri }, input.fetchRegistration ?? createOAuthRegistrationFetch(egress));
    existing = await savePublicMcpOAuthClient(input.db, binding, { resource: discovery.resource,
      issuer: registered.issuer, clientId: registered.clientId, redirectUri: registered.redirectUri,
      metadata: { serverMetadata: discovery.authorizationServer.serverMetadata, protectedResourceMetadata: discovery.protectedResourceMetadata } });
  }
  return preparedPublicMcpOAuth(input.auth, existing, input.egress);
}
