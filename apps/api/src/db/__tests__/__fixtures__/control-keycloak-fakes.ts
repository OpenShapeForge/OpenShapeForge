// SPDX-License-Identifier: BUSL-1.1
/**
 * In-memory stand-ins for the two Keycloak surfaces the control plane uses.
 *
 * Shared by the database-backed control-plane suites (`control-provisioning`
 * and `control-reconciliation`) because they need the SAME fake: the
 * reconciliation tests desync state that the provisioning tests create, and two
 * fakes that drifted apart would make one suite's "converged" mean something
 * the other's does not.
 *
 * Not a test file itself — it defines no `test()` — so the runner does not
 * collect it; it lives under `__fixtures__` for exactly that reason.
 *
 * FIDELITY, AND WHERE IT STOPS. These fakes reproduce the behaviours the
 * database half has to cope with, each established against the running Keycloak
 * 26.5.3 and documented at its source:
 *
 *   - upsert-shaped creates (`getByAlias` before create, every attribute
 *     rewritten each call) — `keycloak-spi-client.ts`;
 *   - `setEnabled(true)` on EVERY create, including a replay, which is what
 *     `reconcileOrganizationEnabled` exists to correct — `provisioning.ts`;
 *   - an OPAQUE generated organization id, unrelated to the alias or the name.
 *     It used to be the derived `name` string, mirroring the SPI's
 *     `create(name, alias, null)` binding; #294 fixed that binding, so Keycloak
 *     generates a uuid. Minting one here is what keeps these suites honest —
 *     with id == name they would pass while depending on a coincidence
 *     production no longer supplies. It is also what forces the replay lookup
 *     below to go through the ALIAS, which is what the SPI actually does.
 *
 * What they do NOT reproduce is Keycloak's own validation (alias immutability,
 * realm-unique names, the SPI's parent/root agreement check). Those are proven
 * against the real server, not here.
 */
import { randomUUID } from "node:crypto";
import type {
  KeycloakOrganizationAdminClient,
  KeycloakOrganizationSnapshot,
} from "../../../control/keycloak-organization-admin.js";
import type {
  CreateOrganizationRequest,
  KeycloakOrganization,
  KeycloakSpiClient,
} from "../../../control/keycloak-spi-client.js";

/**
 * One organization as the fake realm holds it: the last create request that
 * touched it, plus the native `enabled` flag the admin API owns.
 *
 * `request` is deliberately mutable and public, because corrupting exactly one
 * projected value — a path, a parent id — is how a drift fixture is built.
 */
export type FakeOrganization = { request: CreateOrganizationRequest; enabled: boolean };

export type FakeSpiClient = KeycloakSpiClient & {
  /** The realm, keyed by the generated organization id. */
  organizations: Map<string, FakeOrganization>;
  calls: CreateOrganizationRequest[];
  failNext: (error: Error) => void;
  /**
   * Fail every call matching a predicate, for as long as it is set. `failNext`
   * cannot express "the third node of a subtree move fails", which is exactly
   * the case the partial-projection failure path has to be proven on.
   */
  failWhen: (match: ((request: CreateOrganizationRequest) => boolean) | null) => void;
  pathOf: (organizationId: string) => string | undefined;
};

export function fakeSpi(): FakeSpiClient {
  const organizations = new Map<string, FakeOrganization>();
  const calls: CreateOrganizationRequest[] = [];
  let pendingFailure: Error | null = null;
  let failMatch: ((request: CreateOrganizationRequest) => boolean) | null = null;

  return {
    organizations,
    calls,
    failNext(error: Error) {
      pendingFailure = error;
    },
    failWhen(match) {
      failMatch = match;
    },
    pathOf(organizationId) {
      return organizations.get(organizationId)?.request.organizationPath;
    },
    async createOrganization(request): Promise<KeycloakOrganization> {
      if (pendingFailure) {
        const error = pendingFailure;
        pendingFailure = null;
        throw error;
      }
      if (failMatch?.(request)) {
        throw new Error(`keycloak refused ${request.organizationPath}`);
      }
      calls.push(request);
      // `getByAlias` before create: a replay keeps the id it was first given,
      // which is what makes the provisioning layer's retry a repair rather than
      // a second organization. The id itself is opaque, so nothing downstream
      // can recover the alias from it.
      const existingId = [...organizations.entries()].find(
        ([, organization]) => organization.request.alias === request.alias,
      )?.[0];
      const id = existingId ?? randomUUID();
      // `setEnabled(true)` on every create, including a replay — the behaviour
      // `reconcileOrganizationEnabled` exists to correct for. Note the whole
      // request replaces the old one, which is the SPI's "rewrite every
      // attribute" shape and therefore what makes a replay a repair.
      organizations.set(id, { request, enabled: true });
      return { id, alias: request.alias, name: request.name };
    },
  };
}

/** The admin-API half, keyed by the same ids the SPI fake hands out. */
export function fakeAdmin(spi: FakeSpiClient): KeycloakOrganizationAdminClient {
  const require_ = (id: string): FakeOrganization => {
    const found = spi.organizations.get(id);
    if (!found) throw new Error(`fake admin: no organization "${id}"`);
    return found;
  };
  const state = (id: string) => {
    const org = require_(id);
    return {
      id,
      alias: org.request.alias,
      name: org.request.name,
      enabled: org.enabled,
    };
  };
  const snapshot = (id: string, org: FakeOrganization): KeycloakOrganizationSnapshot => ({
    id,
    alias: org.request.alias,
    name: org.request.name,
    enabled: org.enabled,
    organizationLevel: org.request.organizationLevel,
    organizationPath: org.request.organizationPath,
    // Absent means "the attribute is not set", which is a meaningful state for a
    // root organization rather than a missing value — the real client makes the
    // same distinction.
    parentOrganizationId: org.request.parentOrganizationId ?? null,
    rootOrganizationId:
      org.request.rootOrganizationId ??
      // The SPI stamps a ROOT organization's own id as its root; the request
      // never carries one because there is nothing to point at yet.
      (org.request.organizationLevel === "root" ? id : null),
  });
  return {
    async getOrganization(id) {
      return state(id);
    },
    async setOrganizationEnabled(id, enabled) {
      const org = require_(id);
      const changed = org.enabled !== enabled;
      org.enabled = enabled;
      return { organization: state(id), changed };
    },
    async listOrganizations(limit) {
      const rows = [...spi.organizations.entries()].map(([id, org]) => snapshot(id, org));
      return { organizations: rows.slice(0, limit), truncated: rows.length > limit };
    },
  };
}
