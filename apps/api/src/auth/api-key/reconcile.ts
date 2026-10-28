// SPDX-License-Identifier: BUSL-1.1
/**
 * Reconciling the database against the realm.
 *
 * Two failure modes, both consequences of provisioning spanning two systems
 * with no shared transaction:
 *
 *   - a STALLED attempt: a row left at 'pending' because the process died
 *     between the insert and the realm mutation, or because the realm mutation
 *     failed. The row authenticates nothing, but it holds the derived
 *     clientId, so it can leave an orphaned client behind in Keycloak.
 *   - an ABANDONED attempt: a row that never reached activation, because an
 *     administrator disabled the integration — or removed it — while
 *     provisioning was still inside the realm (service.ts, step 3's fence).
 *     The activation then records the attempt and deletes the client it
 *     created, so there is usually nothing left here — but that delete is best
 *     effort, and such a row is visited by neither branch above, so the orphan
 *     would survive every later run. Recognised by its MISSING CLIENT SECRET
 *     rather than by its status: that is what the activation writes, so its
 *     absence is exactly the set of rows that never got that far, whatever
 *     status the fence found them in.
 *   - a RESET realm: `--import-realm` is a no-op against an existing realm, so
 *     runtime-created clients survive restarts — but a deliberate realm reset
 *     erases every one of them while the database still lists the integrations
 *     as active. Their keys then fail at the exchange step, silently.
 *
 * The database is the source of truth for intent, which is what makes both
 * recoverable: `granted_roles` records what the customer authorized, so a
 * client can be rebuilt without asking again.
 *
 * This is deliberately a function rather than a timer. Wiring it to a schedule
 * is a deployment decision; running it by hand after an incident is the common
 * case, and a background timer that silently recreated realm clients would be
 * the wrong default for something this privileged.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { withSystemSession, SYSTEM_BYPASS_ROLE } from "../../db/session.js";
import { encryptSecret, type SecretKeyring } from "../../platform/secrets.js";
import { invalidateIntegrationToken } from "./exchange.js";
import type { KeycloakAdmin } from "./keycloak-admin.js";

export type ReconcileDeps = {
  db: OpenShapeForgeDatabase;
  admin: KeycloakAdmin;
  keyring: SecretKeyring;
  entityRoleClientId: string;
  /** Subject recorded on the bypass audit rows this writes. */
  actorSubject: string;
};

export type ReconcileReport = {
  /** 'pending' rows older than the grace window, and what happened to them. */
  sweptPending: string[];
  /**
   * Never-activated rows whose realm client still existed and has now been
   * deleted. Normally empty: the activation's own compensation does this, and
   * this is only what that could not reach.
   */
  sweptAbandoned: string[];
  /** Active integrations whose realm client was missing and has been rebuilt. */
  rebuilt: string[];
  /** Integrations that could not be repaired; each needs a human. */
  failed: Array<{ integrationId: string; reason: string }>;
};

/**
 * How long a 'pending' row is left alone before it is considered stalled.
 * Generous, because a slow realm is not a failed one, and sweeping a row whose
 * provisioning is still in flight would delete a client someone is about to be
 * handed a key for.
 */
const PENDING_GRACE_MS = 15 * 60 * 1000;

type IntegrationRow = {
  id: string;
  tenant_id: string;
  display_name: string;
  keycloak_client_id: string;
  status: string;
  granted_roles: unknown;
  created_at: Date;
  /** Null while an attempt has never been activated. See the abandoned branch. */
  client_secret_ciphertext: string | null;
};

function rolesOf(value: unknown): string[] {
  const raw = typeof value === "string" ? safeParse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((role): role is string => typeof role === "string" && role.trim() !== "");
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Reconciliation legitimately spans tenants — it repairs the deployment, not
 * one customer's data — so it runs under the audited break-glass wrapper rather
 * than inventing a second cross-tenant path. Every run is therefore recorded in
 * `platform.system_bypass_audit` with a reason, which is the right trail for
 * something that can recreate credentials-adjacent realm state.
 */
export async function reconcileApiKeyIntegrations(
  deps: ReconcileDeps,
  now: Date = new Date(),
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    sweptPending: [], sweptAbandoned: [], rebuilt: [], failed: [],
  };

  const rows = await withSystemSession(
    deps.db,
    {
      actorSubject: deps.actorSubject,
      roles: [SYSTEM_BYPASS_ROLE],
      reason: "Reconcile API key integrations against the Keycloak realm.",
    },
    async (trx) => {
      // 'pending' and 'active' are the two branches below; everything that
      // was NEVER ACTIVATED is the third, by its missing client secret rather
      // than by a list of statuses. Enumerating 'disabled' was the same
      // mistake one layer down: the activation's fence can refuse on any
      // status the row happens to be in, and a status this version does not
      // write would then be an orphan no run ever visits.
      const result = await sql<IntegrationRow>`
        select id, tenant_id, display_name, keycloak_client_id, status,
               granted_roles, created_at, client_secret_ciphertext
          from platform.api_key_integrations
         where status in ('pending', 'active')
            or client_secret_ciphertext is null
         order by created_at asc
      `.execute(trx);
      return result.rows;
    },
  );

  for (const row of rows) {
    try {
      if (row.status === "pending") {
        const age = now.getTime() - new Date(row.created_at).getTime();
        if (age < PENDING_GRACE_MS) continue;
        await sweepStalled(deps, row);
        report.sweptPending.push(row.id);
        continue;
      }

      if (row.client_secret_ciphertext === null) {
        // Never activated: there is no credential to keep working and nothing
        // to rebuild, only a client that may still be there. Checked BEFORE
        // the rebuild below, so a row that claims to be live without ever
        // having been activated is never answered by minting it a realm
        // client and a fresh secret — which would be this reconciler enabling
        // an integration nobody activated. Not a state this version writes;
        // reported for a human instead of guessed at.
        if (row.status === "active") {
          throw new Error(
            "Active with no client secret: never activated, so it is not rebuilt.",
          );
        }
        // The row is already in its final state, so only the realm is touched
        // — and `deleteClient` is a no-op when the client is gone, which is
        // the ordinary case, because the activation's own compensation got
        // there first.
        if (!await deps.admin.clientExists(row.keycloak_client_id)) continue;
        await deps.admin.deleteClient(row.keycloak_client_id);
        report.sweptAbandoned.push(row.id);
        continue;
      }

      if (await deps.admin.clientExists(row.keycloak_client_id)) continue;
      await rebuild(deps, row, now);
      report.rebuilt.push(row.id);
    } catch (error) {
      report.failed.push({
        integrationId: row.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

/**
 * A stalled attempt: delete whatever reached the realm, then mark the row
 * 'disabled' rather than deleting it. Keeping the row keeps the audit trail of
 * an attempt that was made, and keeps its derived clientId reserved.
 */
async function sweepStalled(deps: ReconcileDeps, row: IntegrationRow): Promise<void> {
  await deps.admin.deleteClient(row.keycloak_client_id);
  await withSystemSession(
    deps.db,
    {
      actorSubject: deps.actorSubject,
      roles: [SYSTEM_BYPASS_ROLE],
      reason: `Sweep stalled API key integration ${row.id}.`,
      tenantId: row.tenant_id,
    },
    async (trx) => {
      await sql`
        update platform.api_key_integrations
           set status = 'disabled', updated_at = now()
         where id = ${row.id}
      `.execute(trx);
    },
  );
}

/**
 * Rebuild a realm client the database still expects to exist.
 *
 * The new client gets a NEW secret, which is why the ciphertext is rewritten
 * here. The customer's keys keep working: they never held the client secret,
 * only a credential that names the integration. That indirection is what makes
 * this repair invisible to the external party.
 */
async function rebuild(deps: ReconcileDeps, row: IntegrationRow, now: Date): Promise<void> {
  const provisioned = await deps.admin.createServiceAccountClient(
    row.keycloak_client_id,
    row.display_name,
  );
  await deps.admin.setServiceAccountTenant(provisioned.serviceAccountUserId, row.tenant_id);
  await deps.admin.grantClientRoles(
    provisioned.serviceAccountUserId,
    deps.entityRoleClientId,
    rolesOf(row.granted_roles),
  );

  const encrypted = encryptSecret(
    deps.keyring,
    row.id,
    "clientSecret",
    provisioned.clientSecret,
  );

  await withSystemSession(
    deps.db,
    {
      actorSubject: deps.actorSubject,
      roles: [SYSTEM_BYPASS_ROLE],
      reason: `Rebuild API key integration ${row.id} after a missing realm client.`,
      tenantId: row.tenant_id,
    },
    async (trx) => {
      await sql`
        update platform.api_key_integrations
           set client_secret_ciphertext = ${encrypted.ciphertext},
               client_secret_key_id = ${encrypted.keyId},
               client_secret_algorithm = ${encrypted.algorithm},
               updated_at = ${now}
         where id = ${row.id}
      `.execute(trx);
    },
  );

  // The cached token was minted by the client that no longer exists.
  invalidateIntegrationToken(row.id);
}
