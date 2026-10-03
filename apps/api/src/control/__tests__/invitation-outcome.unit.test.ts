// SPDX-License-Identifier: BUSL-1.1
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { deliverInvitation, invitationOutcome, tenantSignInUrl } from "../invitation-outcome.js";
import type { FirstAdministratorClients } from "../first-tenant-administrator.js";
import { KeycloakAdminError } from "../keycloak-organization-admin.js";

const conflict = (message: string) =>
  new KeycloakAdminError("KEYCLOAK_ADMIN_REJECTED", `The Keycloak admin API rejected the request while inviting a member: ${message}`, 409);

function members(overrides: Partial<FirstAdministratorClients["members"]> = {}) {
  const sent: string[] = [];
  const client = {
    hasMemberByEmail: async () => false,
    findPendingInvitationByEmail: async () => null,
    hasInvitationMailConfiguration: async () => true,
    organizationAdministrators: async () => [],
    listInvitations: async () => [],
    deleteInvitation: async () => true,
    inviteUser: async (_id: string, input: { email: string }) => { sent.push(input.email); },
    ...overrides,
  } as FirstAdministratorClients["members"];
  return { client, sent };
}

describe("invitation outcome", () => {
  const original = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
  beforeEach(() => { process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = "https://example.example/"; });
  afterEach(() => {
    if (original === undefined) delete process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
    else process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = original;
  });

  it("builds the tenant sign-in URL from the public origin, or none without one", () => {
    expect(tenantSignInUrl("acme")).toBe("https://example.example/acme");
    delete process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
    expect(tenantSignInUrl("acme")).toBeNull();
    expect(invitationOutcome("acme", "no_email_existing_account").nextStep).toContain("sign in to this tenant's app");
  });

  it("tells the model that an existing account gets no mail and where to sign in", () => {
    const outcome = invitationOutcome("acme", "no_email_existing_account");
    expect(outcome).toMatchObject({ delivery: "no_email_existing_account", signInUrl: "https://example.example/acme" });
    expect(outcome.nextStep).toContain("No e-mail was sent");
    expect(outcome.nextStep).toContain("https://example.example/acme");
    expect(invitationOutcome("acme", "email_sent").nextStep).toContain("resend_tenant_invitation");
    expect(invitationOutcome("acme", "already_accepted").nextStep).toContain("assign_tenant_member_roles");
  });
});

describe("deliverInvitation", () => {
  it("sends only when nothing is pending, after the SMTP preflight", async () => {
    const { client, sent } = members();
    expect(await deliverInvitation(client, "org", { email: "a@example.com" })).toBe("email_sent");
    expect(sent).toEqual(["a@example.com"]);
    const invitation = (expiresAt: number) => async () => ({ id: "i", email: "a@example.com", firstName: null, lastName: null, status: "PENDING", sentDate: null, expiresAt });
    const now = Math.floor(Date.now() / 1000);
    const pending = members({ findPendingInvitationByEmail: invitation(now + 3600), hasInvitationMailConfiguration: async () => false });
    expect(await deliverInvitation(pending.client, "org", { email: "a@example.com" })).toBe("already_pending");
    expect(pending.sent).toEqual([]);
    const expired = members({ findPendingInvitationByEmail: invitation(now - 1) });
    expect(await deliverInvitation(expired.client, "org", { email: "a@example.com" })).toBe("email_sent");
    expect(expired.sent).toEqual(["a@example.com"]);
    const member = members({ hasMemberByEmail: async () => true });
    expect(await deliverInvitation(member.client, "org", { email: "a@example.com" })).toBe("no_email_existing_account");
    expect(await deliverInvitation(member.client, "org", { email: "a@example.com" }, { knownNonMember: true })).toBe("email_sent");
    const noSmtp = members({ hasInvitationMailConfiguration: async () => false });
    await expect(deliverInvitation(noSmtp.client, "org", { email: "a@example.com" })).rejects.toMatchObject({ code: "SMTP_NOT_CONFIGURED" });
  });

  it("resolves a 409 by re-reading, and otherwise names the conflict instead of blaming SMTP", async () => {
    let member = false;
    const raced = members({
      hasMemberByEmail: async () => member,
      inviteUser: async () => { member = true; throw conflict("User already a member of the organization"); },
    });
    expect(await deliverInvitation(raced.client, "org", { email: "a@example.com" })).toBe("no_email_existing_account");

    const stale = (message: string) => members({ inviteUser: async () => { throw conflict(message); } }).client;
    await expect(deliverInvitation(stale("User already a member of the organization"), "org", { email: "a@example.com" }))
      .rejects.toMatchObject({ code: "ORGANIZATION_MEMBER_EXISTS" });
    await expect(deliverInvitation(stale("User already has a pending invitation"), "org", { email: "a@example.com" }))
      .rejects.toMatchObject({ code: "INVITATION_ALREADY_PENDING" });
    await expect(deliverInvitation(stale("something else"), "org", { email: "a@example.com" }))
      .rejects.toMatchObject({ code: "INVITATION_REJECTED" });
  });

  it("leaves non-409 provider failures to the caller's delivery-unconfirmed boundary", async () => {
    const failing = members({ inviteUser: async () => { throw new KeycloakAdminError("KEYCLOAK_ADMIN_UNAVAILABLE", "smtp", 500); } });
    await expect(deliverInvitation(failing.client, "org", { email: "a@example.com" })).rejects.toBeInstanceOf(KeycloakAdminError);
  });
});
