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
import { createHmac, randomUUID } from "node:crypto";
import { applyTrustedContextHeaders, TRUSTED_CONTEXT_HEADERS } from "@openshapeforge/auth";

const tenantId = randomUUID();
const integrationId = randomUUID();
const credentialId = randomUUID();
const serviceAccountUserId = randomUUID();

describe("no other carrier produces an application principal", () => {
  test("signed trusted contexts cannot name an application principal", async () => {
    const { readTrustedSessionContext } = await import("./trusted-context.js");
    const secret = "principal-class-test-secret";
    const nowMs = Date.now();
    const headers = new Headers();
    applyTrustedContextHeaders(headers, {
      tenantId, userId: serviceAccountUserId, roles: ["Relations.All.Read"],
      groups: [], principalKind: "service",
    }, { secret, nowMs });
    headers.set("x-osf-app-principal", integrationId);
    headers.set("x-osf-app-principal-id", integrationId);
    headers.set("x-osf-integration-id", integrationId);
    headers.set("x-osf-app-credential", credentialId);
    headers.set("x-osf-app-credential-id", credentialId);
    headers.set("x-osf-principal-class", "application");
    headers.set("x-osf-principal-kind", "service");
    const session = readTrustedSessionContext(headers, { secret, nowMs });
    expect(session.tenantId).toBe(tenantId);
    expect(session.userId).toBe(serviceAccountUserId);
    expect(session.principalKind).toBe("service");
    expect(session.appPrincipal).toBeUndefined();
    expect(JSON.stringify(session)).not.toContain(integrationId);
    expect(JSON.stringify(session)).not.toContain(credentialId);

    headers.set(TRUSTED_CONTEXT_HEADERS.principalKind, "person");
    const tampered = readTrustedSessionContext(headers, { secret, nowMs });
    expect(tampered.tenantId).toBeNull();
    expect(tampered.principalKind).toBeUndefined();
    expect(tampered.appPrincipal).toBeUndefined();

    const timestamp = String(nowMs);
    const legacy = new Headers({
      [TRUSTED_CONTEXT_HEADERS.tenantId]: tenantId,
      [TRUSTED_CONTEXT_HEADERS.userId]: serviceAccountUserId,
      [TRUSTED_CONTEXT_HEADERS.roles]: "Relations.All.Read",
      [TRUSTED_CONTEXT_HEADERS.timestamp]: timestamp,
      [TRUSTED_CONTEXT_HEADERS.signature]: createHmac("sha256", secret)
        .update(["v2", timestamp, tenantId, serviceAccountUserId, "Relations.All.Read", ""].join("\n"))
        .digest("hex"),
      [TRUSTED_CONTEXT_HEADERS.principalKind]: "person",
      "x-osf-app-principal": integrationId,
    });
    const v2 = readTrustedSessionContext(legacy, { secret, nowMs });
    expect(v2.tenantId).toBe(tenantId);
    expect(v2.userId).toBe(serviceAccountUserId);
    expect(v2.principalKind).toBeUndefined();
    expect(v2.appPrincipal).toBeUndefined();
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
      appPrincipal: { integrationId, credentialId },
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
      ...carrier(PERSON_PARTY), principalKind: "service",
      appPrincipal: { integrationId, credentialId },
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
