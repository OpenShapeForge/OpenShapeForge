// SPDX-License-Identifier: BUSL-1.1
/** A linked membership with no roles, for resolver tests that have no database. */
import { __setIdentityLinkForTests } from "./identity.js";

export function stubLinkedMembershipForTests(roles: readonly string[] = []): void {
  __setIdentityLinkForTests(async (session, claims) => ({
    identityId: "00000000-0000-4000-8000-000000000001",
    issuer: claims.issuer,
    subject: claims.subject,
    status: "linked",
    relationId: "00000000-0000-4000-8000-000000000002",
    displayName: claims.name ?? claims.subject,
    relationType: "person",
    candidateRelationId: null,
    linkedBy: "test",
    needsRoleAssignment: roles.length === 0,
    roles,
  }));
}
