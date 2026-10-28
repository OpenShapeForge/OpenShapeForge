// SPDX-License-Identifier: BUSL-1.1
/**
 * Which carriers do NOT produce an application principal, and how the
 * database session classifies the ones that do.
 *
 * The positive case — a resolved API key naming its integration — is proven
 * through the real credential path against a real database in
 * db/__tests__/record-actions-rls.test.ts, because mocking the store here
 * would replace the one read whose result is the whole point.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

const tenantId = randomUUID();
const integrationId = randomUUID();
const serviceAccountUserId = randomUUID();

describe("no other carrier produces an application principal", () => {
  test("a signed trusted-context bundle cannot name one", async () => {
    const { readTrustedSessionContext } = await import("./trusted-context.js");
    // Everything a web tier may hand on, plus every spelling of the field a
    // caller might hope is read. The reader builds its own object, so none of
    // it can reach the session.
    const headers = new Headers({
      "x-osf-tenant-id": tenantId,
      "x-osf-user-id": serviceAccountUserId,
      "x-osf-roles": "Relations.All.Read",
      "x-osf-app-principal": integrationId,
      "x-osf-app-principal-id": integrationId,
      "x-osf-integration-id": integrationId,
      "x-osf-principal-class": "application",
      "x-osf-principal-kind": "service",
    });
    const session = readTrustedSessionContext(headers, { allowUnsigned: true });
    expect(session.credential).toBe("trusted-context");
    expect(session.appPrincipal).toBeUndefined();
    expect(session.principalKind).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain(integrationId);
  });

  test("the database session derives the class from the server's own decision", async () => {
    const { resolvePrincipalClass } = await import("../db/session.js");
    expect(resolvePrincipalClass({ tenantId, userId: serviceAccountUserId })).toBe("unknown");
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId, principalKind: "service",
    })).toBe("service");
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId, principalKind: "person",
    })).toBe("person");
    // An application outranks the service kind its own token carries.
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId, principalKind: "service",
      appPrincipal: { integrationId },
    })).toBe("application");
    // A verified service account cannot be re-read as a person by attaching a
    // Relation to it; the stated kind wins over the link.
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId, principalKind: "service",
      relation: {
        identityId: randomUUID(), issuer: "https://identity.example/realms/test",
        subject: serviceAccountUserId, status: "linked",
      },
    } as never)).toBe("service");
    // A link belonging to someone else classifies nobody.
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId,
      relation: {
        identityId: randomUUID(), issuer: "https://identity.example/realms/test",
        subject: randomUUID(), status: "linked",
      },
    } as never)).toBe("unknown");
  });
});

/**
 * The link classifies a PERSON, and only a person.
 *
 * The fallback exists for the one carrier that states no kind: a
 * trusted-context bundle still signing payload v2, which this deployment
 * accepts for ordinary work. Everything about such a session's class comes
 * from the link, and a link is not evidence of a person — every API-key
 * service account records one on its first session
 * (`ensureServiceIdentityLink`), and `link_identity` may point any identity at
 * any Relation the tenant holds. So the party's own kind is required, and
 * `relationIsPerson` is where `toState` put the deployment's answer to it.
 *
 * `person` is the one class that holds a named action's user, role and group
 * subjects and the class a generic route's `principalClasses` is matched
 * against, so this is what a legacy linked service carrier would have been
 * handed.
 */
describe("a verified link is a person's or it is nobody's", () => {
  const link = (extra: Record<string, unknown>) => ({
    tenantId,
    userId: serviceAccountUserId,
    relation: {
      identityId: randomUUID(),
      issuer: "https://identity.example/realms/test",
      subject: serviceAccountUserId,
      ...extra,
    },
  });

  test("a v2 carrier with a person party is a person — linked or pending", async () => {
    const { resolvePrincipalClass } = await import("../db/session.js");
    // Ordinary v2 compatibility: this is how a real person with no signed
    // class has always reached the person class, and still does.
    expect(resolvePrincipalClass(
      link({ status: "linked", relationIsPerson: true }) as never)).toBe("person");
    // A candidate the e-mail matched is a person party too, so a person
    // waiting to confirm keeps the class they have today.
    expect(resolvePrincipalClass(
      link({ status: "pending_confirmation", relationIsPerson: true }) as never)).toBe("person");
  });

  test("a v2 carrier whose party is not a person holds nothing", async () => {
    const { resolvePrincipalClass } = await import("../db/session.js");
    for (const status of ["linked", "pending_confirmation"]) {
      // A service account an administrator linked to a supplier organization.
      expect({ status, got: resolvePrincipalClass(
        link({ status, relationIsPerson: false }) as never) })
        .toEqual({ status, got: "unknown" });
      // The empty pending row an API-key service account records for itself:
      // a verified link with no party at all.
      expect({ status, got: resolvePrincipalClass(
        link({ status, relationType: null, relationIsPerson: false }) as never) })
        .toEqual({ status, got: "unknown" });
      // And a link that says nothing about its party — a producer that omits
      // the field proves no person, so absence is not a permissive value.
      expect({ status, got: resolvePrincipalClass(link({ status }) as never) })
        .toEqual({ status, got: "unknown" });
    }
  });

  test("the audit identity is unaffected: a linked service is still audited", async () => {
    const { verifiedAuditIdentity } = await import("../db/session.js");
    // The class is about personhood; the audit identity is about which
    // identity row acted. A linked service account has one, and it still
    // reaches `app.audit_identity_id`.
    const input = link({ status: "linked", relationIsPerson: false });
    expect(verifiedAuditIdentity(input as never)).toEqual({
      auditIdentityId: input.relation.identityId,
      auditIssuer: input.relation.issuer,
    });
  });

  test("a stated kind still outranks the link, in both directions", async () => {
    const { resolvePrincipalClass } = await import("../db/session.js");
    // A signed person verdict does not need a link at all, and a signed
    // service verdict is not undone by a person party.
    expect(resolvePrincipalClass(
      { ...link({ status: "linked", relationIsPerson: false }), principalKind: "person" } as never),
    ).toBe("person");
    expect(resolvePrincipalClass(
      { ...link({ status: "linked", relationIsPerson: true }), principalKind: "service" } as never),
    ).toBe("service");
  });
});
