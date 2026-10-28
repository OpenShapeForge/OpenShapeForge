// SPDX-License-Identifier: BUSL-1.1
/**
 * Which KIND of session an entity's generated CRUD and derived search admit.
 *
 * Roles answer "what may this session do"; they cannot answer "what sort of
 * session is this", because a service account and the person beside it can
 * hold the very same role. That gap is load-bearing once applications are
 * first-class principals: an entity may hand an application a named action on
 * one record and still have no intention of exposing its collection, its
 * record read or the search derived from them to every key whose service
 * account happens to hold the entity's read role.
 *
 * So the entity declares the classes its generic routes admit
 * (`authorization.principalClasses`, docs/authoring.md), the compiler derives
 * the default — every class, except that an entity declaring an action for
 * `integration` principals excludes `application` — and this is where that
 * declaration is enforced.
 *
 * Three properties the callers depend on:
 *
 *   - it NARROWS only. An admitted class still faces the entity's roles, the
 *     Operation's scopes and the record ACL; nothing here admits a session
 *     that those would refuse.
 *   - the class comes from `resolvePrincipalClass`, the same server-sourced
 *     derivation the record-action axis matches its subjects against. There is
 *     one classification in the system, not a second opinion per call site.
 *   - an absent policy admits everything, so an entity that declares none
 *     behaves exactly as it did before this existed.
 */
import { operationFailure } from "@openshapeforge/operations";
import { resolvePrincipalClass, type DbPrincipalClass, type DbSessionInput } from "../../db/session.js";
import type { GeneratedCrudTable } from "./types.js";

/** The classes this entity admits on its generic routes, or undefined for all. */
export function admittedPrincipalClasses(
  table: GeneratedCrudTable,
): readonly DbPrincipalClass[] | undefined {
  const declared = table.source?.authorization?.principalClasses;
  return declared && declared.length > 0 ? declared : undefined;
}

/**
 * Does this entity admit this session's verified class?
 *
 * Never throws: the MCP projection and the Operation listing use it to decide
 * what to ADVERTISE, and a route a caller cannot use is omitted rather than
 * surfaced as an error.
 */
export function entityAdmitsPrincipal(
  table: GeneratedCrudTable,
  session: DbSessionInput,
): boolean {
  const admitted = admittedPrincipalClasses(table);
  if (!admitted) return true;
  return admitted.includes(resolvePrincipalClass(session));
}

/**
 * The refusal, for the call path.
 *
 * It names the class rather than the policy: the caller already knows what it
 * is, and saying so is what tells an integrator "this is not a missing role,
 * presenting a different credential will not help" instead of leaving them to
 * request a broader role for a route that would still refuse them. It does
 * not name which classes the entity admits — that is the entity's policy, not
 * this caller's business.
 */
export function assertEntityAdmitsPrincipal(
  table: GeneratedCrudTable,
  session: DbSessionInput,
): void {
  if (entityAdmitsPrincipal(table, session)) return;
  const name = table.source?.authoringEntityName ?? table.name;
  const principal = resolvePrincipalClass(session);
  throw operationFailure({
    code: "FORBIDDEN",
    message:
      `${name} does not expose its generated read and write operations to a ` +
      `${principal} principal.`,
    data: {
      localized: {
        en: `${name} is not available to this kind of session.`,
        nl: `${name} is niet beschikbaar voor dit soort sessie.`,
      },
    },
    retryable: false,
  });
}
