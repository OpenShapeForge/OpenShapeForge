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
