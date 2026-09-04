// SPDX-License-Identifier: BUSL-1.1
/**
 * `whoami` / `osf://session` projection. Pure: no database, no server. The
 * one rule that matters most is negative — nothing identifier-shaped may
 * leave `buildSessionInfo` — so every case also asserts the absence of ids,
 * slugs and raw claims.
 */
import { describe, expect, it } from "bun:test";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import {
  buildSessionInfo,
  describeExpiry,
  humanizeDuration,
  identityFromBearerClaims,
  identityFromSession,
  readSessionIdentity,
  rememberSessionIdentity,
  sessionIdentityOf,
  type SessionIdentity,
} from "../session-info.js";

const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_ID = "8ba94fb8-08d3-4907-9af3-5bd1e2018f46";
const NOW = Date.parse("2026-09-04T10:00:00.000Z");

const KEYCLOAK_NOISE = [
  "default-roles-openshapeforge",
  "offline_access",
  "uma_authorization",
  "manage-account",
  "manage-account-links",
  "view-profile",
];

const bearer = (overrides: Partial<SessionIdentity> = {}): SessionIdentity => ({
  credential: "bearer",
  name: "Hans Eilers",
  email: "hans@example.com",
  authorizedParty: "codex",
  expiresAtMs: NOW + 12 * 60_000,
  organizations: [{ alias: "zerocopter-dev", active: true }],
  ...overrides,
});

const session = (
  overrides: Partial<TrustedSessionContext> = {},
): TrustedSessionContext => ({
  tenantId: TENANT_ID,
  userId: USER_ID,
  roles: [],
  groups: [],
  scope: "self",
  credential: "bearer",
  ...overrides,
});

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const unsignedJwt = (claims: Record<string, unknown>) =>
  `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url(claims)}.signature`;

const expectNoIdentifiers = (info: unknown) => {
  const text = JSON.stringify(info);
  expect(text).not.toContain(TENANT_ID);
  expect(text).not.toContain(USER_ID);
  expect(text).not.toContain(ORGANIZATION_ID);
  expect(text).not.toContain("zerocopter-dev");
  expect(text).not.toContain("resource_access");
  expect(text).not.toContain("azp");
};

describe("buildSessionInfo", () => {
  it("describes an organization administrator in plain language", () => {
    const info = buildSessionInfo({
      identity: bearer(),
      roles: [
        ...KEYCLOAK_NOISE,
        "org_admin",
        "Pentest.All.ReadWrite",
        "Relations.All.ReadWrite",
        "integration_admin",
      ],
      organization: { name: "Zerocopter" },
      access: { tools: 68, resources: 13 },
      nowMs: NOW,
    });

    expect(info.name).toBe("Hans Eilers");
    expect(info.email).toBe("hans@example.com");
    expect(info.organization).toBe("Zerocopter");
    expect(info.role).toBe("Organization administrator");
    expect(info.permissions).toEqual([
      "integration_admin",
      "Pentest.All.ReadWrite",
      "Relations.All.ReadWrite",
    ]);
    expect(info.groups).toEqual([{ name: "Zerocopter", active: true }]);
    expect(info.signedInVia).toBe("Codex");
    expect(info.signInExpiresAt).toBe("2026-09-04T10:12:00.000Z");
    expect(info.signInExpiresIn).toBe("in 12 minutes");
    expect(info.access).toEqual({ tools: 68, resources: 13 });
    expect(info.employeeRecord).toEqual({
      status: "Not linked yet",
      name: null,
      relation: null,
    });
    expect(info.summary).toBe(
      "You are Hans Eilers, organization administrator of Zerocopter, signed in via Codex. " +
        "Your sign-in expires in 12 minutes. You can use 68 tools and 13 resources.",
    );
    expectNoIdentifiers(info);
  });

  it("describes an employee and names the gateway client Hubble", () => {
    const info = buildSessionInfo({
      identity: bearer({
        name: "Hans Dev",
        authorizedParty: "openshapeforge-gateway",
      }),
      roles: [...KEYCLOAK_NOISE, "org_employee", "Pentest.All.Read"],
      organization: { name: "Zerocopter" },
      access: { tools: 12, resources: 3 },
      nowMs: NOW,
    });

    expect(info.role).toBe("Employee");
    expect(info.permissions).toEqual(["Pentest.All.Read"]);
    expect(info.signedInVia).toBe("Hubble");
    expect(info.summary).toStartWith(
      "You are Hans Dev, employee of Zerocopter, signed in via Hubble.",
    );
    expectNoIdentifiers(info);
  });

  it("falls back to the raw role list when no composite is present", () => {
    const info = buildSessionInfo({
      identity: bearer({ authorizedParty: "openshapeforge-inspector" }),
      roles: [...KEYCLOAK_NOISE, "Relations.All.Read", "CaseFile.All.ReadWrite"],
      organization: { name: "Hubble" },
      access: { tools: 1, resources: 1 },
      nowMs: NOW,
    });

    expect(info.role).toBe("CaseFile.All.ReadWrite, Relations.All.Read");
    expect(info.signedInVia).toBe("MCP Inspector");
    expect(info.summary).toBe(
      "You are Hans Eilers, a member of Hubble with the roles CaseFile.All.ReadWrite, " +
        "Relations.All.Read, signed in via MCP Inspector. Your sign-in expires in 12 minutes. " +
        "You can use 1 tool and 1 resource.",
    );
  });

  it("reports no role and an unknown client without inventing values", () => {
    const info = buildSessionInfo({
      identity: bearer({ authorizedParty: "some-other-client" }),
      roles: KEYCLOAK_NOISE,
      organization: { name: "Zerocopter" },
      access: { tools: 1, resources: 1 },
      nowMs: NOW,
    });
    expect(info.role).toBe("No role");
    expect(info.permissions).toEqual([]);
    expect(info.signedInVia).toBe("some-other-client");
    expect(info.summary).toContain("a member of Zerocopter without any roles");
  });

  it("lists every organization membership as a group, the active one by display name", () => {
    const info = buildSessionInfo({
      identity: bearer({
        organizations: [
          { alias: "hubble", active: false },
          { alias: "zerocopter-dev", active: true },
        ],
      }),
      roles: ["org_admin"],
      organization: { name: "Zerocopter" },
      access: { tools: 5, resources: 2 },
      nowMs: NOW,
    });

    expect(info.groups).toEqual([
      { name: "hubble", active: false },
      { name: "Zerocopter", active: true },
    ]);
    expect(info.summary).toContain(
      "You belong to 2 groups; Zerocopter is the active one.",
    );
  });

  it("makes the tenant row the only group when the token names no organization", () => {
    const info = buildSessionInfo({
      identity: bearer({ organizations: [] }),
      roles: ["org_admin"],
      organization: { name: "Zerocopter" },
      access: { tools: 5, resources: 2 },
      nowMs: NOW,
    });
    expect(info.groups).toEqual([{ name: "Zerocopter", active: true }]);
  });

  it("describes the development identity without an expiry", () => {
    const info = buildSessionInfo({
      identity: identityFromSession(session({ credential: "trusted-context" })),
      roles: ["Relations.All.ReadWrite", "Pentest.All.ReadWrite"],
      organization: { name: "Zerocopter" },
      access: { tools: 40, resources: 9 },
      nowMs: NOW,
    });

    expect(info.name).toBeNull();
    expect(info.email).toBeNull();
    expect(info.signedInVia).toBe("Development identity");
    expect("signInExpiresAt" in info).toBe(false);
    expect("signInExpiresIn" in info).toBe(false);
    expect(info.groups).toEqual([{ name: "Zerocopter", active: true }]);
    expect(info.summary).toBe(
      "You are the development identity, a member of Zerocopter with the roles " +
        "Pentest.All.ReadWrite, Relations.All.ReadWrite, signed in using the development " +
        "identity. You can use 40 tools and 9 resources.",
    );
    expectNoIdentifiers(info);
  });

  it("says so when the registry has no row for the tenant, without leaking the id", () => {
    const info = buildSessionInfo({
      identity: bearer(),
      roles: ["org_admin"],
      organization: null,
      access: { tools: 1, resources: 1 },
      nowMs: NOW,
    });
    expect(info.organization).toBeNull();
    expect(info.groups).toEqual([{ name: "zerocopter-dev", active: true }]);
    expect(info.summary).toContain("organization administrator of an unknown organization");
    expect(JSON.stringify(info)).not.toContain(TENANT_ID);
  });

  it("phrases an already-expired sign-in as such", () => {
    const info = buildSessionInfo({
      identity: bearer({ expiresAtMs: NOW - 3 * 60_000 }),
      roles: ["org_admin"],
      organization: { name: "Zerocopter" },
      access: { tools: 1, resources: 1 },
      nowMs: NOW,
    });
    expect(info.signInExpiresIn).toBe("3 minutes ago");
    expect(info.summary).toContain("Your sign-in expired 3 minutes ago.");
  });
});

describe("expiry formatting", () => {
  it("humanizes durations at the coarsest honest unit", () => {
    expect(humanizeDuration(0)).toBe("0 seconds");
    expect(humanizeDuration(45_000)).toBe("45 seconds");
    expect(humanizeDuration(60_000)).toBe("1 minute");
    expect(humanizeDuration(12 * 60_000 + 30_000)).toBe("12 minutes");
    expect(humanizeDuration(60 * 60_000)).toBe("1 hour");
    expect(humanizeDuration(65 * 60_000)).toBe("1 hour 5 minutes");
    expect(humanizeDuration(26 * 60 * 60_000)).toBe("1 day 2 hours");
    expect(humanizeDuration(3 * 24 * 60 * 60_000)).toBe("3 days");
  });

  it("prefixes the future and suffixes the past", () => {
    expect(describeExpiry(NOW + 15 * 60_000, NOW)).toBe("in 15 minutes");
    expect(describeExpiry(NOW, NOW)).toBe("in 0 seconds");
    expect(describeExpiry(NOW - 90_000, NOW)).toBe("1 minute ago");
  });
});

describe("identity from the credential", () => {
  const claims = {
    iss: "http://localhost:8181/realms/openshapeforge",
    azp: "codex",
    exp: Math.floor((NOW + 12 * 60_000) / 1000),
    name: "Zerocopter Admin",
    preferred_username: "zerocopter-admin",
    email: "zerocopter-admin@example.com",
    organization: { "zerocopter-dev": { id: ORGANIZATION_ID } },
    resource_access: { "hubble-api": { roles: ["org_admin"] } },
    scope: "openid email organization profile",
  };

  it("keeps only display facts from a bearer payload", () => {
    const identity = identityFromBearerClaims(claims);
    expect(identity).toEqual({
      credential: "bearer",
      name: "Zerocopter Admin",
      email: "zerocopter-admin@example.com",
      authorizedParty: "codex",
      expiresAtMs: NOW + 12 * 60_000,
      organizations: [{ alias: "zerocopter-dev", active: true }],
    });
  });

  it("falls back to the username and marks the selected membership when several exist", () => {
    const identity = identityFromBearerClaims({
      ...claims,
      name: undefined,
      organization: {
        hubble: { id: "11111111-1111-4111-8111-111111111111" },
        "zerocopter-dev": { id: ORGANIZATION_ID },
      },
      scope: "openid organization:zerocopter-dev",
    });
    expect(identity.name).toBe("zerocopter-admin");
    expect(identity.organizations).toEqual([
      { alias: "hubble", active: false },
      { alias: "zerocopter-dev", active: true },
    ]);
  });

  it("marks no membership active when the token cannot say which one it acts for", () => {
    const identity = identityFromBearerClaims({
      ...claims,
      organization: {
        hubble: { id: "11111111-1111-4111-8111-111111111111" },
        "zerocopter-dev": { id: ORGANIZATION_ID },
      },
      scope: "openid organization",
    });
    expect(identity.organizations.every((membership) => !membership.active)).toBe(true);
  });

  it("reads the bearer payload of the request only for a bearer session", () => {
    const headers = new Headers({ authorization: `Bearer ${unsignedJwt(claims)}` });
    expect(readSessionIdentity(session(), headers).name).toBe("Zerocopter Admin");
    expect(
      readSessionIdentity(session({ credential: "trusted-context" }), headers),
    ).toEqual(identityFromSession(session({ credential: "trusted-context" })));
    expect(readSessionIdentity(session({ credential: "api-key" }), headers).name).toBeNull();
  });

  it("degrades to the credential floor on an unreadable token", () => {
    const headers = new Headers({ authorization: "Bearer not.a.jwt" });
    expect(readSessionIdentity(session(), headers)).toEqual(identityFromSession(session()));
  });

  it("remembers the identity per session object", () => {
    const first = session();
    const second = session();
    rememberSessionIdentity(
      first,
      new Headers({ authorization: `Bearer ${unsignedJwt(claims)}` }),
    );
    expect(sessionIdentityOf(first).authorizedParty).toBe("codex");
    expect(sessionIdentityOf(second)).toEqual(identityFromSession(second));
  });
});
