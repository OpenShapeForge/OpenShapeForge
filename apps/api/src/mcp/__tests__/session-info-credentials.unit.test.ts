// SPDX-License-Identifier: BUSL-1.1
/**
 * How `whoami` names a session whose credential carries no claims: an API
 * key is called by the integration it belongs to, "unlinked" is said only of
 * a recorded identity without a record, and the identity id never leaves —
 * the administrator who needs it reads `list_pending_members`, the caller
 * does not.
 */
import { describe, expect, it } from "bun:test";
import type { IdentityLinkState } from "../../auth/identity-link.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { buildSessionInfo, identityFromSession } from "../session-info.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY_ID = "44444444-4444-4444-8444-444444444444";
const RELATION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = Date.parse("2026-09-04T10:00:00.000Z");

const session = (overrides: Partial<TrustedSessionContext> = {}): TrustedSessionContext => ({
  tenantId: TENANT_ID,
  userId: "integration-jira",
  roles: [],
  groups: [],
  scope: "self",
  credential: "api-key",
  issuer: "http://localhost:8181/realms/openshapeforge",
  userDisplayName: "Jira sync",
  ...overrides,
});

const link = (overrides: Partial<IdentityLinkState> = {}): IdentityLinkState => ({
  identityId: IDENTITY_ID,
  issuer: "http://localhost:8181/realms/openshapeforge",
  subject: "integration-jira",
  status: "pending_confirmation",
  relationId: null,
  displayName: null,
  relationType: null,
  candidateRelationId: null,
  linkedBy: null,
  needsRoleAssignment: false,
  roles: [],
  ...overrides,
});

const info = (relation: IdentityLinkState | null, context = session()) =>
  buildSessionInfo({
    identity: identityFromSession(context),
    roles: ["org_employee"],
    organization: { name: "Zerocopter" },
    access: { tools: 3, resources: 1 },
    relation,
    nowMs: NOW,
  });

const expectNoIdentifiers = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain(TENANT_ID);
  expect(text).not.toContain(IDENTITY_ID);
  expect(text).not.toContain(RELATION_ID);
  expect(text).not.toContain("integration-jira");
};

describe("an API key in whoami", () => {
  it("carries the integration's display name onto the identity", () => {
    expect(identityFromSession(session()).name).toBe("Jira sync");
    expect(identityFromSession(session({ userDisplayName: null })).name).toBeNull();
  });

  it("is named by its integration, and by its record once linked", () => {
    const linked = info(
      link({ status: "linked", relationId: RELATION_ID, displayName: "Jira", relationType: "system" }),
    );
    expect(linked.name).toBe("Jira sync");
    expect(linked.relation).toMatchObject({ status: "Linked", name: "Jira", kind: "system" });
    expect(linked.summary).toStartWith("You are Jira sync, ");
    expect(linked.summary).toContain("You act as the record Jira.");
    expect(linked.summary).not.toContain("unlinked");
    expectNoIdentifiers(linked);
  });

  it("points a recorded but unlinked integration at the administrator's tools, without its id", () => {
    const unlinked = info(link());
    expect(unlinked.relation.status).toBe("Not linked");
    expect(unlinked.summary).toContain(
      "This integration is not linked to a record yet; an organization administrator finds it with list_pending_members and links it with link_identity.",
    );
    expectNoIdentifiers(unlinked);
  });

  it("says 'unlinked' only of a recorded identity that has neither a record nor a candidate", () => {
    const nameless = session({ userDisplayName: null });
    expect(info(link(), nameless).summary).toStartWith("You are an unlinked integration, ");
    expect(info(null, nameless).summary).toStartWith("You are an integration, ");
    expect(
      info(link({ status: "linked", relationId: RELATION_ID, displayName: "Jira" }), nameless).summary,
    ).toStartWith("You are an integration, ");
  });
});

describe("a login without claims in whoami", () => {
  it("is an unlinked login only while recorded without a record", () => {
    const bearer = session({ credential: "bearer", userDisplayName: null, userId: "abc" });
    expect(info(link({ subject: "abc" }), bearer).summary).toStartWith("You are an unlinked login, ");
    expect(info(link({ subject: "abc" }), bearer).summary).toContain(
      "Your login is not linked to a record yet; an organization administrator links it with link_identity by your e-mail address.",
    );
    expect(info(null, bearer).summary).toStartWith("You are a login, ");
  });

  it("calls a trusted-context session without an identity the development identity", () => {
    const dev = session({ credential: "trusted-context", userDisplayName: null });
    expect(info(null, dev).summary).toStartWith("You are the development identity, ");
    expect(info(link(), dev).summary).toStartWith("You are an unlinked login, ");
  });
});
