// SPDX-License-Identifier: BUSL-1.1
/**
 * The shared vocabulary for "a connection is needed": what an Adapter needs,
 * the sentence a tool description carries, and the actionable failure every
 * connection gap is raised as.
 */
import { describe, expect, it } from "bun:test";
import {
  connectionFieldsOf,
  connectionNeedsOf,
  connectionProblemError,
  connectionProblemMessage,
  describeConnectionNeeds,
  isConnectionProblemCode,
  missingRequiredConnectionValues,
  withConnectionNeeds,
} from "../connection-guidance.js";

const GOOGLE_FIELDS = [
  { key: "clientId", label: { en: "Google OAuth client ID" }, required: true },
  {
    key: "clientSecret",
    label: { en: "Google OAuth client secret" },
    required: true,
    classification: { sensitivity: "confidential" },
  },
  { key: "region", label: { en: "Region" }, required: false },
];

const TOOLS = { create: "create_connection", connect: "connect_service" };

describe("connectionNeedsOf", () => {
  it("derives organization and personal needs from the auth block and the contract", () => {
    expect(
      connectionNeedsOf({ profile: "oauth2AuthorizationCode", connectionScope: "user" }, GOOGLE_FIELDS),
    ).toEqual({ organization: true, personal: true, oauthClient: true });
    // A sign-in profile needs the OAuth client even without declared fields.
    expect(connectionNeedsOf({ profile: "oauth2AuthorizationCode" }, [])).toEqual({
      organization: true,
      personal: true,
      oauthClient: true,
    });
    expect(connectionNeedsOf({ profile: "apiKey", scheme: "bearer", tokenFrom: "token" }, [])).toEqual({
      organization: true,
      personal: false,
      oauthClient: false,
    });
    expect(connectionNeedsOf({ profile: "oauth2AuthorizationCode", connectionScope: "tenant" }, [])).toEqual({
      organization: true,
      personal: false,
      oauthClient: true,
    });
    // The native provider: no auth, no fields, nothing to set up.
    expect(connectionNeedsOf(null, [])).toEqual({ organization: false, personal: false, oauthClient: false });
    expect(connectionNeedsOf(undefined, undefined)).toEqual({
      organization: false,
      personal: false,
      oauthClient: false,
    });
  });
});

describe("connection fields and required values", () => {
  it("lists the form fields with secret ones marked", () => {
    expect(connectionFieldsOf(GOOGLE_FIELDS)).toEqual([
      { key: "clientId", label: "Google OAuth client ID", required: true, secret: false },
      { key: "clientSecret", label: "Google OAuth client secret", required: true, secret: true },
      { key: "region", label: "Region", required: false, secret: false },
    ]);
    expect(connectionFieldsOf(null)).toEqual([]);
    expect(connectionFieldsOf([{ label: "no key" }, { key: "k" }])).toEqual([
      { key: "k", label: "k", required: false, secret: false },
    ]);
  });

  it("judges required values the way test_connection does, stored secrets counting as set", () => {
    const auth = { profile: "oauth2AuthorizationCode" };
    expect(missingRequiredConnectionValues(GOOGLE_FIELDS, auth, null)).toEqual([
      "clientId",
      "clientSecret",
    ]);
    expect(
      missingRequiredConnectionValues(GOOGLE_FIELDS, auth, {
        clientId: "id",
        clientSecret: { ciphertext: "c", keyId: "k", algorithm: "a" },
      }),
    ).toEqual([]);
    expect(missingRequiredConnectionValues(GOOGLE_FIELDS, auth, { clientId: "" })).toEqual([
      "clientId",
      "clientSecret",
    ]);
    expect(
      missingRequiredConnectionValues([], { profile: "apiKey", scheme: "bearer", tokenFrom: "token" }, {}),
    ).toEqual(["token"]);
  });
});

describe("describeConnectionNeeds", () => {
  it("generates one short sentence per need and nothing when there is none", () => {
    expect(
      describeConnectionNeeds("Google", { organization: true, personal: true, oauthClient: true }, TOOLS),
    ).toBe(
      "Requires the organization's Google connection; administrators set it up with " +
        "create_connection. Sign in once with connect_service.",
    );
    expect(
      describeConnectionNeeds("Slack", { organization: true, personal: false, oauthClient: false }, TOOLS),
    ).toBe("Requires the organization's Slack connection; administrators set it up with create_connection.");
    expect(
      describeConnectionNeeds(
        "Google",
        { organization: true, personal: true, oauthClient: true },
        { create: "create_connection", connect: null },
      ),
    ).toBe("Requires the organization's Google connection; administrators set it up with create_connection.");
    expect(
      describeConnectionNeeds("Hubble", { organization: false, personal: false, oauthClient: false }, TOOLS),
    ).toBe("");
  });

  it("appends under the authored description, never over it", () => {
    expect(withConnectionNeeds("Search the inbox.", "Sign in once with connect_service.")).toBe(
      "Search the inbox.\n\nSign in once with connect_service.",
    );
    expect(withConnectionNeeds("Search the inbox.", "")).toBe("Search the inbox.");
    expect(withConnectionNeeds("", "Sign in once with connect_service.")).toBe(
      "Sign in once with connect_service.",
    );
  });
});

describe("connection problems", () => {
  const organization = {
    kind: "organization_missing" as const,
    adapter: "Google",
    adapterId: "adapter-google",
    createTool: "create_connection",
    adapterArgument: "adapterId",
  };

  it("tells an employee to ask an administrator, naming the adapter and the tool", () => {
    const error = connectionProblemError({ ...organization, administrator: false });
    expect(error.status).toBe(400);
    expect(error.code).toBe("CONNECTION_MISSING");
    expect(error.message).toBe(
      "The organization's Google connection is not set up. Ask an organization administrator " +
        "to set up the Google connection (create_connection).",
    );
  });

  it("tells an administrator the exact call, plus the browser link when one was minted", () => {
    expect(connectionProblemMessage({ ...organization, administrator: true })).toBe(
      "The organization's Google connection is not set up. As an organization administrator, " +
        'set it up with create_connection { adapterId: "adapter-google" }.',
    );
    expect(
      connectionProblemMessage({
        ...organization,
        administrator: true,
        configurationUrl: "http://127.0.0.1:3271/api/entity-configuration/tok",
        expiresAt: "2026-09-05T10:30:00.000Z",
      }),
    ).toBe(
      "The organization's Google connection is not set up. As an organization administrator, " +
        'set it up with create_connection { adapterId: "adapter-google" }, or open ' +
        "http://127.0.0.1:3271/api/entity-configuration/tok in a browser and enter the values " +
        "there (link valid until 2026-09-05T10:30:00.000Z); they never pass through the chat.",
    );
  });

  it("names the missing values of an incomplete connection", () => {
    expect(
      connectionProblemMessage({ ...organization, administrator: false, missingValues: ["clientSecret"] }),
    ).toStartWith("The organization's Google connection is incomplete (missing values: clientSecret).");
  });

  it("points a personal sign-in at connect_service with the tool name", () => {
    const error = connectionProblemError({
      kind: "personal_missing",
      adapter: "Google",
      toolName: "inbox_doorzoeken",
      connectTool: "connect_service",
    });
    expect(error.status).toBe(403);
    expect(error.code).toBe("CONNECTION_REQUIRED");
    expect(error.message).toBe(
      "This tool needs your personal Google sign-in. Call connect_service " +
        '{ tool: "inbox_doorzoeken" } and open the returned URL to approve at Google.',
    );
    expect(
      connectionProblemMessage({
        kind: "personal_missing",
        adapter: "Google",
        toolName: "inbox_doorzoeken",
        connectTool: null,
      }),
    ).toContain("Call the connect tool and open the returned URL");
  });

  it("words the tenant-wide sign-in and reauthorization for the caller's role and scope", () => {
    expect(
      connectionProblemMessage({
        kind: "tenant_sign_in",
        adapter: "HubSpot",
        toolName: "find_deals",
        connectTool: "connect_service",
        administrator: false,
      }),
    ).toBe(
      "HubSpot needs a one-time sign-in for the whole organization. Ask an organization " +
        'administrator to call connect_service { tool: "find_deals" } and approve at HubSpot.',
    );
    expect(
      connectionProblemMessage({
        kind: "tenant_sign_in",
        adapter: "HubSpot",
        toolName: "find_deals",
        connectTool: "connect_service",
        administrator: true,
      }),
    ).toContain("As an organization administrator, call connect_service");
    const reauth = connectionProblemError({
      kind: "reauthorization",
      adapter: "Google",
      toolName: "inbox_doorzoeken",
      connectTool: "connect_service",
      scope: "user",
      reason: "does not cover the required scopes: mail.read",
    });
    expect(reauth.code).toBe("REAUTHORIZATION_REQUIRED");
    expect(reauth.message).toBe(
      "Your Google sign-in does not cover the required scopes: mail.read. Call connect_service " +
        '{ tool: "inbox_doorzoeken" } again and approve at Google.',
    );
    expect(
      connectionProblemMessage({
        kind: "reauthorization",
        adapter: "HubSpot",
        toolName: "find_deals",
        connectTool: "connect_service",
        scope: "tenant",
        reason: "expired and could not be refreshed",
      }),
    ).toStartWith("The organization's HubSpot sign-in expired and could not be refreshed. An organization administrator calls");
  });

  it("recognises its own codes and nothing else", () => {
    expect(isConnectionProblemCode("CONNECTION_MISSING")).toBe(true);
    expect(isConnectionProblemCode("CONNECTION_REQUIRED")).toBe(true);
    expect(isConnectionProblemCode("REAUTHORIZATION_REQUIRED")).toBe(true);
    expect(isConnectionProblemCode("PROVIDER_ERROR")).toBe(false);
    expect(isConnectionProblemCode(undefined)).toBe(false);
  });
});
