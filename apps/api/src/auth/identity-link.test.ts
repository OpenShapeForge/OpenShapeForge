// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  displayNameFromClaims,
  identityClaimsFromToken,
  personNameFromClaims,
  sessionRelation,
  type IdentityLinkState,
} from "./identity-link.js";

const linked: IdentityLinkState = {
  identityId: "11111111-1111-4111-8111-111111111111",
  issuer: "http://kc/realms/r",
  subject: "22222222-2222-4222-8222-222222222222",
  status: "linked",
  relationId: "33333333-3333-4333-8333-333333333333",
  displayName: "Zerocopter Admin",
  relationType: "person",
  candidateRelationId: null,
  linkedBy: "jit",
  needsRoleAssignment: false,
};

describe("sessionRelation", () => {
  test("answers the Relation of a linked session", () => {
    expect(sessionRelation({ relation: linked })).toEqual({
      relationId: linked.relationId!,
      displayName: "Zerocopter Admin",
    });
  });

  test("answers null while pending, when absent, and for sessions without a person", () => {
    expect(
      sessionRelation({
        relation: { ...linked, status: "pending_confirmation", relationId: null },
      }),
    ).toBeNull();
    expect(sessionRelation({ relation: null })).toBeNull();
    expect(sessionRelation({})).toBeNull();
    expect(sessionRelation(null)).toBeNull();
  });
});

describe("identityClaimsFromToken", () => {
  test("needs an issuer and a subject", () => {
    expect(identityClaimsFromToken({ sub: "x" })).toBeNull();
    expect(identityClaimsFromToken({ iss: "x" })).toBeNull();
  });

  test("flattens the person claims and ignores non-string values", () => {
    expect(
      identityClaimsFromToken({
        iss: "http://kc/realms/r",
        sub: "s",
        email: " hans@example.com ",
        name: "Hans Dev",
        given_name: "Hans",
        family_name: "Dev",
        preferred_username: 42,
      }),
    ).toEqual({
      issuer: "http://kc/realms/r",
      subject: "s",
      email: "hans@example.com",
      name: "Hans Dev",
      givenName: "Hans",
      familyName: "Dev",
      preferredUsername: undefined,
    });
  });
});

describe("names from claims", () => {
  test("display name prefers name, then given+family, then username, then subject", () => {
    const base = { issuer: "i", subject: "sub-1" };
    expect(displayNameFromClaims({ ...base, name: "N", givenName: "G", familyName: "F" })).toBe("N");
    expect(displayNameFromClaims({ ...base, givenName: "G", familyName: "F" })).toBe("G F");
    expect(displayNameFromClaims({ ...base, preferredUsername: "u" })).toBe("u");
    expect(displayNameFromClaims(base)).toBe("sub-1");
  });

  test("person name comes from given/family, else a two-part name, else nothing", () => {
    const base = { issuer: "i", subject: "s" };
    expect(personNameFromClaims({ ...base, givenName: "Hans", familyName: "Dev" })).toEqual({
      firstName: "Hans",
      lastName: "Dev",
    });
    expect(personNameFromClaims({ ...base, name: "Hans van der Dev" })).toEqual({
      firstName: "Hans",
      lastName: "van der Dev",
    });
    expect(personNameFromClaims({ ...base, name: "hans", preferredUsername: "hans" })).toBeNull();
  });
});
