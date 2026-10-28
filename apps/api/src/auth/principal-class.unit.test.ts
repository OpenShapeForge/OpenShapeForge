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
  });
});

/**
 * The `person` class rests on a VERIFIED human login, and on nothing else.
 *
 * One carrier states no kind: a trusted-context bundle still signing payload
 * v2, which this deployment accepts for ordinary work. The tempting fallback
 * for it is the identity ↔ Relation link, because that link is a row this
 * server read under RLS rather than a claim. It is still not evidence of a
 * human, and this file is the statement of that:
 *
 *   - `ensureServiceIdentityLink` records a link row for every API-key
 *     service account on its first session, so a link exists for machines;
 *   - `link_identity` lets an administrator point any identity at any
 *     Relation the tenant holds, so the party's own `relation_type` is a fact
 *     about a row somebody chose — a machine identity linked to a person
 *     Relation is permitted and ordinary — and not a fact about how this
 *     session authenticated;
 *   - a `pending_confirmation` link names a candidate an e-mail matched and
 *     nobody confirmed, so even reading the party as authoritative would be
 *     reading an unverified one.
 *
 * `person` is the one class that holds a named action's user, role and group
 * subjects and the class a generic route's `principalClasses` is matched
 * against, so each of those shapes would have been handed a person's record
 * actions. That those two surfaces now hold nothing for them is proven where
 * the surfaces live, against the compiled entities and a real database:
 * `operations/entity/record-permissions.test.ts`,
 * `operations/entity/principal-classes.test.ts` and
 * `operations/api-key-dispatcher-db.test.ts`.
 */
describe("a link is not evidence of a person, however its party reads", () => {
  const PERSON_PARTY = {
    status: "linked",
    relationId: randomUUID(),
    relationType: "person",
  };

  const carrier = (extra: Record<string, unknown>) => ({
    tenantId,
    userId: serviceAccountUserId,
    relation: {
      identityId: randomUUID(),
      issuer: "https://identity.example/realms/test",
      subject: serviceAccountUserId,
      ...extra,
    },
  });

  test("an unclassified carrier linked to a person party is unknown", async () => {
    const { resolvePrincipalClass } = await import("../db/session.js");
    // The shape the review names: a service account an administrator linked
    // to a person Relation, reaching this code under a v2 bundle. Verified
    // link, person party, no signed class — and no person.
    expect(resolvePrincipalClass(carrier(PERSON_PARTY) as never)).toBe("unknown");
    // And a candidate nobody confirmed is no better, whatever its party.
    expect(resolvePrincipalClass(
      carrier({ ...PERSON_PARTY, status: "pending_confirmation" }) as never)).toBe("unknown");
  });

  test("no other party, status or shape of link reaches the class either", async () => {
    const { resolvePrincipalClass } = await import("../db/session.js");
    const parties: readonly [string, Record<string, unknown>][] = [
      ["a person party", { relationType: "person", relationId: randomUUID() }],
      ["an organization party", { relationType: "organization", relationId: randomUUID() }],
      ["no party at all", { relationType: null, relationId: null }],
    ];
    for (const status of ["linked", "pending_confirmation"]) {
      for (const [label, party] of parties) {
        expect({ status, label, got: resolvePrincipalClass(
          carrier({ status, ...party }) as never) })
          .toEqual({ status, label, got: "unknown" });
      }
    }
    // A link belonging to someone else, and no link at all, are the same
    // answer — there was never a route to the class here to close.
    expect(resolvePrincipalClass(
      carrier({ ...PERSON_PARTY, subject: randomUUID() }) as never)).toBe("unknown");
    expect(resolvePrincipalClass({ tenantId, userId: serviceAccountUserId })).toBe("unknown");
  });

  test("a signed class decides, in both directions, link or no link", async () => {
    const { resolvePrincipalClass } = await import("../db/session.js");
    // A verified person needs no link at all: the class comes from the bearer
    // path's verdict or from inside a v3 bundle's HMAC.
    expect(resolvePrincipalClass({
      tenantId, userId: serviceAccountUserId, principalKind: "person",
    })).toBe("person");
    expect(resolvePrincipalClass(
      { ...carrier({ relationType: null, status: "linked" }), principalKind: "person" } as never),
    ).toBe("person");
    // And a signed service verdict is not undone by a person party.
    expect(resolvePrincipalClass(
      { ...carrier(PERSON_PARTY), principalKind: "service" } as never)).toBe("service");
    // Nor is it undone by a resolved integration, which only narrows it.
    expect(resolvePrincipalClass({
      ...carrier(PERSON_PARTY), principalKind: "service", appPrincipal: { integrationId },
    } as never)).toBe("application");
  });

  test("the audit identity and the acting Relation are unaffected", async () => {
    const { verifiedAuditIdentity } = await import("../db/session.js");
    const { actingRelationId } = await import("../db/acting-relation.js");
    // Which identity acted, and which party it acts as, are different
    // questions from whether it is a person — and both still come off the
    // link this classification ignores. Narrowing the class must not quietly
    // drop a session's audit trail or its row scope.
    const input = carrier(PERSON_PARTY);
    expect(verifiedAuditIdentity(input as never)).toEqual({
      auditIdentityId: input.relation.identityId,
      auditIssuer: input.relation.issuer,
    });
    expect(actingRelationId(input as never)).toBe(PERSON_PARTY.relationId);
  });
});
