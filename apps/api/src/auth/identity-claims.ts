// SPDX-License-Identifier: BUSL-1.1
/**
 * What a verified token says about the person: the claims the identity
 * link keys on (issuer, subject) and the names the just-in-time Relation
 * and NaturalPerson rows are given.
 */
import type { IdentityClaims } from "./identity-link.js";

/** Flatten the claims a verified token carries about the person. */
export function identityClaimsFromToken(
  claims: Record<string, unknown>,
): IdentityClaims | null {
  const issuer = stringClaim(claims.iss);
  const subject = stringClaim(claims.sub);
  if (!issuer || !subject) return null;
  return {
    issuer,
    subject,
    email: stringClaim(claims.email),
    name: stringClaim(claims.name),
    givenName: stringClaim(claims.given_name),
    familyName: stringClaim(claims.family_name),
    preferredUsername: stringClaim(claims.preferred_username),
  };
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The person's display name, in the order the token is trusted for it. */
export function displayNameFromClaims(claims: IdentityClaims): string {
  const combined = [claims.givenName, claims.familyName].filter(Boolean).join(" ").trim();
  return claims.name ?? (combined || undefined) ?? claims.preferredUsername ?? claims.subject;
}

/**
 * First/last name for the NaturalPerson row, or null when the token does not
 * say. Both are required on NaturalPerson and neither is guessed: a person
 * with only a username gets a Relation, not a person record with an invented
 * family name.
 */
export function personNameFromClaims(
  claims: IdentityClaims,
): { firstName: string; lastName: string } | null {
  if (claims.givenName && claims.familyName) {
    return { firstName: claims.givenName, lastName: claims.familyName };
  }
  const parts = (claims.name ?? "").split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
  }
  return null;
}

