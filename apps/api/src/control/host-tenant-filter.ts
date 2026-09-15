// SPDX-License-Identifier: BUSL-1.1
import { sql } from "kysely";
import { usesHostOrganizationContext } from "../config/host-organization.js";

/** Identifiers are internal call-site constants; the realm is always a bound value. */
export function hostTenantFilter(column = "keycloak_realm") {
  if (!usesHostOrganizationContext()) return sql<boolean>`true`;
  const realm = process.env.OPENSHAPEFORGE_CONTROL_KEYCLOAK_TENANT_REALM;
  if (!realm || realm.toLowerCase() === "master" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(realm)) {
    throw new Error("Host tenant queries require an explicit non-master realm");
  }
  return sql<boolean>`${sql.ref(column)} = ${realm}`;
}
