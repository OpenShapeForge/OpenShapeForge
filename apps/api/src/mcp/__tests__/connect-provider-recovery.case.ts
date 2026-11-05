// SPDX-License-Identifier: BUSL-1.1
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { HttpError } from "../../rest/http-error.js";

const owner = "person-1";
const personal = { id: "connection-1", ownerUserId: owner, values: { accessToken: {}, refreshToken: { ciphertext: "fake", keyId: "fake" }, accessTokenExpiresAt: "2000-01-01T00:00:00Z", grantedScopes: ["calendar.read"] } };
const organization = { id: "organization-1", ownerUserId: null, values: {} };
let refreshCalls: Record<string, unknown>[] = [];
let handoffs: Record<string, unknown>[] = [];
let refreshFailure: Error | undefined;

mock.module("../session-connections.js", () => ({
  looksLikeStoredSecret: (value: any) => Boolean(value?.ciphertext && value?.keyId),
  normalizeConnectionValueRows: (rows: unknown) => rows,
  runtimeRowsByFilter: async () => [organization, personal],
  selectOAuthConnectionRow: (rows: any[], scope: string, id: string) => rows.find(row => scope === "tenant" ? row.ownerUserId === null : row.ownerUserId === id),
  readClientCredentials: () => ({ clientId: "client", clientSecret: "secret" }),
  urlSafeConnectionValues: () => ({ plain: {}, secretKeys: new Set() }),
  organizationConnectionProblem: () => { throw new Error("unexpected"); },
}));
mock.module("../entity-oauth.js", () => ({
  scopesCovered: (required: string[], granted: string[]) => required.every(scope => granted?.includes(scope)),
  mintAuthorization: async (input: Record<string, unknown>) => { handoffs.push(input); return { authorizationUrl: "https://example.test/consent", expiresInSeconds: 300 }; },
}));
mock.module("../connection-token-refresh.js", () => ({
  accessTokenNeedsRefresh: () => true,
  refreshLeewaySeconds: () => 60,
  refreshConnectionRowLocked: async (input: Record<string, unknown>) => { refreshCalls.push(input); if (refreshFailure) throw refreshFailure; return {}; },
}));
mock.module("../catalog.js", () => ({ entityForTable: () => ({ elicitOnCreate: { sourceTable: "provider", definitionsField: "fields" } }) }));
mock.module("../declarative-execution.js", () => ({ resolveTemplate: (value: string) => value }));
mock.module("../onboarding.js", () => ({ isOrganizationAdministrator: () => false }));
mock.module("../connection-guidance.js", () => ({ missingRequiredConnectionValues: () => [] }));
mock.module("../catalog-rows.js", () => ({ connectionScopeOf: (auth: any) => auth.connectionScope }));
mock.module("../tool-results.js", () => ({ ok: (data: unknown) => ({ structuredContent: data }) }));
mock.module("../../connectors/secrets.js", () => ({ connectionTokenSecretScope: () => "connection" }));
mock.module("../handoff-config.js", () => ({ ENTITY_OAUTH_CALLBACK_PATH: "/callback", callbackOrigin: () => "https://app.test", elicitedKeyring: () => ({}) }));
mock.module("../acting-relation-guard.js", () => ({ requireActingRelationId: () => owner }));
mock.module("../../db/acting-relation.js", () => ({ actingRelationId: () => owner }));

const { connectProviderStep } = await import("../dispatch-connect-provider.js");

function context(): any {
  return {
    db: {}, session: { tenantId: "tenant-1", userId: "user-1", relationId: owner, roles: [] },
    tables: new Map([["connection", { columns: [], schema: "public", table: "connection" }]]),
    execution: { connectionTable: "connection", connectionProviderRef: "providerId", connectionValuesField: "values", providerTable: "provider", providerEntity: "Adapter" },
    connectEntry: {}, requiredScopesByProvider: new Map([["provider-1", new Set(["calendar.read"])]]),
    signInProviders: [{}], connectedProviders: [], requestId: "request-1", egressOwner: {},
  };
}
const provider: any = { id: "provider-1", row: { name: "Example", egressHosts: ["example.test"] }, auth: { connectionScope: "user", authorizationUrl: "https://example.test/authorize", tokenUrl: "https://example.test/token", scopes: ["calendar.read"] } };

describe("connect recovers an expired personal grant", () => {
  beforeEach(() => { refreshCalls = []; handoffs = []; refreshFailure = undefined; });
  it("refreshes the selected person's row and keeps a working connection", async () => {
    const ctx = context();
    expect(await connectProviderStep(ctx, 0, provider)).toBeUndefined();
    expect(refreshCalls[0]).toMatchObject({ rowId: "connection-1", expectedOwnerUserId: owner, expectedProviderId: "provider-1" });
    expect(ctx.connectedProviders).toEqual(["Example"]);
    expect(handoffs).toHaveLength(0);
  });
  it("offers consent for the same owner when the refresh grant is refused", async () => {
    refreshFailure = new HttpError(403, "REAUTHORIZATION_REQUIRED", "refused");
    const result = await connectProviderStep(context(), 0, provider);
    expect(result?.isError).not.toBe(true);
    expect(result?.structuredContent).toMatchObject({ action: "authorize", authorizationUrl: "https://example.test/consent" });
    expect(handoffs[0]).toMatchObject({ tenantId: "tenant-1", relationId: owner, providerRowId: "provider-1", connectionScope: "user" });
  });
  it("does not create a consent handoff on temporary provider failure", async () => {
    refreshFailure = new HttpError(502, "TOKEN_REFRESH_FAILED", "temporary");
    await expect(connectProviderStep(context(), 0, provider)).rejects.toBe(refreshFailure);
    expect(handoffs).toHaveLength(0);
  });
});
