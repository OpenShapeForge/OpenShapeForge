// SPDX-License-Identifier: BUSL-1.1
/**
 * Server actions for the API key settings screen.
 *
 * Every one of these is a thin call onto the API's GraphQL surface, which in
 * turn calls the same provisioning service the REST surface does. Nothing here
 * decides anything: the privilege ceiling and tenant containment live on the
 * API, and a caller who reaches these actions with a session that lacks
 * `Platform.ApiKeys.Manage` gets a FORBIDDEN back rather than a filtered view.
 *
 * That matters for how the UI is written: the screen may hide controls the
 * user cannot use, but hiding is never what stops them.
 */
"use server";

import { executeGraphqlRequest } from "@/lib/server/graphql-client";

export type ApiKeyRow = {
  id: string;
  integrationId: string;
  integrationName: string;
  displayName: string;
  roleSubset: string[] | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

export type MintedApiKey = {
  integrationId: string;
  keyId: string;
  /** The credential. Shown once; there is no way to read it back. */
  token: string;
  expiresAt: string | null;
};

const KEY_FIELDS = `
  id
  integrationId
  integrationName
  displayName
  roleSubset
  createdAt
  expiresAt
  revokedAt
  lastUsedAt
`;

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  const data = await executeGraphqlRequest<{ apiKeys?: ApiKeyRow[] }>({
    query: `query { apiKeys { ${KEY_FIELDS} } }`,
  });
  return data?.apiKeys ?? [];
}

/**
 * Roles the signed-in user may grant. Populates the picker only — the API
 * re-derives the caller's roles on every mutation, so a client that ignores
 * this list gains nothing by it.
 */
export async function listGrantableRoles(): Promise<string[]> {
  const data = await executeGraphqlRequest<{ grantableApiKeyRoles?: string[] }>({
    query: `query { grantableApiKeyRoles }`,
  });
  return data?.grantableApiKeyRoles ?? [];
}

export async function createApiKeyIntegration(input: {
  displayName: string;
  roles: string[];
  expiresInDays?: number | null;
}): Promise<MintedApiKey> {
  const data = await executeGraphqlRequest<{
    createApiKeyIntegration?: MintedApiKey;
  }>({
    query: `
      mutation ($input: CreateApiKeyIntegrationInput!) {
        createApiKeyIntegration(input: $input) {
          integrationId
          keyId
          token
          expiresAt
        }
      }`,
    variables: { input },
  });
  if (!data?.createApiKeyIntegration) {
    throw new Error("The API did not return a credential.");
  }
  return data.createApiKeyIntegration;
}

/**
 * Issue a second key against an existing integration — the rotation primitive.
 * Both keys are live until the old one is revoked, which is the cutover window
 * the external party needs.
 */
export async function rotateApiKey(input: {
  integrationId: string;
  displayName: string;
  roleSubset?: string[] | null;
}): Promise<MintedApiKey> {
  const data = await executeGraphqlRequest<{ issueApiKey?: MintedApiKey }>({
    query: `
      mutation ($input: IssueApiKeyInput!) {
        issueApiKey(input: $input) {
          integrationId
          keyId
          token
          expiresAt
        }
      }`,
    variables: { input },
  });
  if (!data?.issueApiKey) {
    throw new Error("The API did not return a credential.");
  }
  return data.issueApiKey;
}

export async function revokeApiKey(keyId: string): Promise<void> {
  await executeGraphqlRequest<{ revokeApiKey?: boolean }>({
    query: `mutation ($keyId: ID!) { revokeApiKey(keyId: $keyId) }`,
    variables: { keyId },
  });
}

export async function disableApiKeyIntegration(integrationId: string): Promise<void> {
  await executeGraphqlRequest<{ disableApiKeyIntegration?: boolean }>({
    query: `
      mutation ($integrationId: ID!) {
        disableApiKeyIntegration(integrationId: $integrationId)
      }`,
    variables: { integrationId },
  });
}
