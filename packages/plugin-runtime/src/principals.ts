// SPDX-License-Identifier: BUSL-1.1

/**
 * What kind of principal the HOST decided the live session is.
 *
 * A module that acts for an application needs the application's identity for
 * work authorization alone cannot do: naming its own idempotency namespace,
 * recording provenance on the rows it writes, and attributing an audit event.
 * It must never derive that identity from anything the caller presented — not
 * a header, not a path parameter, not a key id — because every one of those is
 * attacker-chosen. So the host answers instead, from the facts it verified:
 *
 *   person       a verified human identity
 *   application  a resolved API-key integration, and only that
 *   service      a verified client-credentials principal with no integration
 *                behind it — configured organization automation included
 *   unknown      a carrier that states nothing the host can classify
 *
 * `unknown` is a named answer rather than an absent one so no module can read
 * a missing value as a permissive one.
 */
export type RuntimePrincipalClass = "person" | "application" | "service" | "unknown";

/**
 * The verified application a session acts as.
 *
 * `integrationId` is the host's tenant-bound integration row id. It is stable
 * across credential rotation, independent of the integration's mutable display
 * name, and stops resolving once the integration is gone — which is what makes
 * it usable as a durable namespace and as an audited actor. It is NOT the key
 * id and NOT anything the request carried.
 */
export type RuntimeApplicationPrincipal = Readonly<{ integrationId: string }>;

/**
 * Host-owned classification of the live verified session.
 *
 * Both calls are refused for a session that is not the live one this
 * invocation was handed, so a module cannot fabricate a session object and
 * read a principal out of it. Neither call authorizes anything: a module that
 * needs authorization uses the record services, which ask the host's own
 * policy. These answer only "who is this", for provenance and namespacing.
 */
export type RuntimePrincipalServices<Session> = Readonly<{
  classOf(session: Session): RuntimePrincipalClass;
  /**
   * The verified application, or `undefined` for every other principal class.
   * A module that must act only for an application refuses on `undefined`
   * rather than falling back to a caller-supplied identifier.
   */
  application(session: Session): RuntimeApplicationPrincipal | undefined;
}>;
