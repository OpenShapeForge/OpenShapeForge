// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";

/** Public registration and metadata only; secrets and bearer tokens never belong here. */
export type PublicMcpOAuthClient = {
  resource: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  metadata: Readonly<Record<string, unknown>>;
};
type Binding = {
  session: DbSessionInput;
  providerTable: string;
  providerId: string;
  providerUpdatedAt: Date | string;
  resource: string;
  redirectUri: string;
};
type Row = { resource: string; issuer: string; client_id: string; redirect_uri: string; metadata: Record<string, unknown> };
const SECRET_FIELD = /^(?:clientsecret|accesstoken|refreshtoken|registrationaccesstoken|password)$/;
function containsSecretField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) =>
    SECRET_FIELD.test(key.replace(/[_-]/g, "").toLowerCase()) || containsSecretField(child));
}

/** Each lookup is under the verified tenant and bound to the current provider version and callback. */
export async function readPublicMcpOAuthClient(db: OpenShapeForgeDatabase, binding: Binding): Promise<PublicMcpOAuthClient | undefined> {
  if (!binding.session.tenantId || !binding.session.userId) return undefined;
  const result = await withDbSession(db, binding.session, trx => sql<Row>`
    select resource, issuer, client_id, redirect_uri, metadata
      from platform.mcp_oauth_clients
     where tenant_id = ${binding.session.tenantId}::uuid
       and provider_table = ${binding.providerTable} and provider_id = ${binding.providerId}::uuid
       and provider_updated_at = ${binding.providerUpdatedAt}::timestamptz
       and resource = ${binding.resource} and redirect_uri = ${binding.redirectUri}
  `.execute(trx));
  const row = result.rows[0];
  return row ? { resource: row.resource, issuer: row.issuer, clientId: row.client_id, redirectUri: row.redirect_uri, metadata: row.metadata } : undefined;
}

/** First registration wins for one provider revision; concurrent consent flows reuse its exact client id. */
export async function savePublicMcpOAuthClient(db: OpenShapeForgeDatabase, binding: Binding, client: PublicMcpOAuthClient): Promise<PublicMcpOAuthClient> {
  if (!binding.session.tenantId || !binding.session.userId || client.resource !== binding.resource || client.redirectUri !== binding.redirectUri) {
    throw new Error("OAuth client registration does not match the verified binding.");
  }
  const json = JSON.stringify(client.metadata);
  if (Buffer.byteLength(json, "utf8") > 512 * 1024 || !client.clientId || !client.issuer || containsSecretField(client.metadata)) {
    throw new Error("OAuth client registration is invalid.");
  }
  await withDbSession(db, binding.session, trx => sql`
    insert into platform.mcp_oauth_clients
      (tenant_id, provider_table, provider_id, provider_updated_at, resource, issuer, metadata, client_id, redirect_uri)
    values (${binding.session.tenantId}::uuid, ${binding.providerTable}, ${binding.providerId}::uuid,
      ${binding.providerUpdatedAt}::timestamptz, ${binding.resource}, ${client.issuer}, ${json}::text::jsonb, ${client.clientId}, ${binding.redirectUri})
    on conflict (tenant_id, provider_table, provider_id, resource, redirect_uri) do update
      set provider_updated_at = excluded.provider_updated_at, issuer = excluded.issuer,
          metadata = excluded.metadata, client_id = excluded.client_id, updated_at = now()
      where platform.mcp_oauth_clients.provider_updated_at < excluded.provider_updated_at
  `.execute(trx));
  const stored = await readPublicMcpOAuthClient(db, binding);
  if (!stored) throw new Error("OAuth client registration changed during setup.");
  return stored;
}
