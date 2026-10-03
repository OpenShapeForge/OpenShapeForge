// SPDX-License-Identifier: BUSL-1.1
/**
 * What an operator becomes on the far side of the control-plane door.
 *
 * The elevation this file guards is the sharpest edge in S3: an authenticated
 * operator is granted `Platform.SystemBypass`, which disables row-level security
 * across every tenant. The door itself — a verified CONTROL-realm bearer from
 * an admitted party, holding a control-realm role looked for in `realm_access`
 * only — is control-session.unit.test.ts. What has to hold here is that the
 * elevation is attached to a session object, with an issuer-qualified actor
 * and a non-empty reason, and never back onto the token.
 */
import { describe, expect, it } from "bun:test";
import { SYSTEM_BYPASS_ROLE } from "../../db/session.js";
import { systemSessionForOperator } from "../authorization.js";

const ISSUER = "http://localhost:8181/realms/openshapeforge-control";
const SUBJECT = "8f8e0c86-3c4f-4a2f-9f3a-0f1a2b3c4d5e";

describe("systemSessionForOperator", () => {
  const operator = {
    subject: SUBJECT,
    issuer: ISSUER,
    username: "platform-operator",
  };

  it("attaches the bypass role the control realm deliberately does not mint", () => {
    const session = systemSessionForOperator(operator, 'create tenant slug="acme"');

    expect(session.roles).toEqual([SYSTEM_BYPASS_ROLE]);
  });

  it("qualifies the actor by issuer, because sub is only unique within one", () => {
    const session = systemSessionForOperator(operator, "create tenant");

    expect(session.actorSubject).toBe(`${ISSUER}#${SUBJECT} (platform-operator)`);
  });

  it("falls back to the bare qualified subject when there is no username", () => {
    const session = systemSessionForOperator(
      { ...operator, username: undefined },
      "create tenant",
    );

    expect(session.actorSubject).toBe(`${ISSUER}#${SUBJECT}`);
  });

  it("records a reason naming the control plane and the operation", () => {
    const session = systemSessionForOperator(operator, 'create tenant slug="acme"');

    expect(session.reason).toBe('control-plane: create tenant slug="acme"');
    expect(session.reason.trim().length).toBeGreaterThan(0);
  });

  it("prefixes the audit source and the Operation key an Operation hands it", () => {
    const session = systemSessionForOperator(
      { ...operator, auditSource: "platform-mcp", auditAction: "control.create-tenant" },
      'create tenant slug="acme"',
    );

    expect(session.reason).toBe('platform-mcp: control.create-tenant create tenant slug="acme"');
  });

  it("claims no tenant scope, because the writes are cross-tenant", () => {
    // A bypass session naming a tenant reads as scoped to it. The registry row
    // IS the tenant and may not exist yet, so claiming a scope would make the
    // audit trail misleading rather than more precise.
    expect(systemSessionForOperator(operator, "create tenant").tenantId).toBeUndefined();
  });

  it("refuses an empty reason", () => {
    expect(() => systemSessionForOperator(operator, "   ")).toThrow(/non-empty reason/);
  });
});
