// SPDX-License-Identifier: BUSL-1.1
/**
 * Per-tenant connector state: installations, secrets, entitlement grants.
 *
 * Every read and write goes through `withDbSession`, so the tenant GUC is set
 * and `FORCE ROW LEVEL SECURITY` applies. The queries here carry no tenant
 * predicate of their own — that is deliberate, and proved at the database layer
 * in `db/__tests__/connector-tenant-isolation.test.ts`: if a policy were ever
 * dropped, the test fails rather than the application quietly compensating.
 *
 * Secret VALUES never leave this module in plaintext except through
 * `readSecrets`, which exists for the invocation path alone. Every
 * configuration read path gets the field NAMES only, so a caller can be told a
 * secret is set without being told what it is.
 */
import { sql, type Transaction } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession, type DbSessionInput } from "../db/session.js";
import type { DB } from "../generated/db/types.js";
import { decryptSecret, encryptSecret, type SecretKeyring, type StoredSecret } from "./secrets.js";
import type { InstallationRecord } from "./status.js";

export type ConnectorInstallation = InstallationRecord & {
  id: string;
  displayName: string | null;
  /** Secret field names that have a stored value — never the values. */
  storedSecretFields: Set<string>;
};

type InstallationRow = {
  id: string;
  connector_slug: string;
  instance_key: string;
  display_name: string | null;
  config: unknown;
  enabled: boolean;
  contract_version: number;
  contract_checksum: string;
};

/**
 * jsonb comes back as a STRING from this driver, not a parsed object. Spreading
 * a string yields per-character keys ({"0":"{","1":"\""}), which is silent
 * corruption rather than a failure — the same shape of bug as a scalar reaching
 * code that expected a list. Parse explicitly, and treat anything that is not
 * an object as empty rather than guessing.
 */
function parseConfig(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? safeParse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function toInstallation(
  row: InstallationRow,
  storedSecretFields: Set<string>,
): ConnectorInstallation {
  return {
    id: row.id,
    connectorSlug: row.connector_slug,
    instanceKey: row.instance_key,
    displayName: row.display_name,
    config: parseConfig(row.config),
    enabled: row.enabled,
    contractVersion: row.contract_version,
    contractChecksum: row.contract_checksum,
    storedSecretFields,
  };
}

async function loadSecretFieldNames(
  trx: Transaction<DB>,
  installationIds: string[],
): Promise<Map<string, Set<string>>> {
  const byInstallation = new Map<string, Set<string>>();
  if (installationIds.length === 0) return byInstallation;

  const rows = await sql<{ installation_id: string; field_key: string }>`
    select installation_id, field_key from platform.connector_secrets
  `.execute(trx);

  for (const row of rows.rows) {
    let fields = byInstallation.get(row.installation_id);
    if (!fields) {
      fields = new Set<string>();
      byInstallation.set(row.installation_id, fields);
    }
    fields.add(row.field_key);
  }
  return byInstallation;
}

export async function listInstallations(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
): Promise<ConnectorInstallation[]> {
  return withDbSession(db, session, async (trx) => {
    const rows = await sql<InstallationRow>`
      select id, connector_slug, instance_key, display_name, config, enabled,
             contract_version, contract_checksum
        from platform.connector_installations
       order by connector_slug, instance_key
    `.execute(trx);

    const secretFields = await loadSecretFieldNames(
      trx,
      rows.rows.map((row) => row.id),
    );
    return rows.rows.map((row) =>
      toInstallation(row, secretFields.get(row.id) ?? new Set<string>()),
    );
  });
}

export async function listEntitlementGrants(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
): Promise<{ entitlement: string; expires_at: Date | string | null }[]> {
  return withDbSession(db, session, async (trx) => {
    const rows = await sql<{ entitlement: string; expires_at: Date | string | null }>`
      select entitlement, expires_at from platform.connector_entitlements
    `.execute(trx);
    return rows.rows;
  });
}

export type UpsertInstallationInput = {
  connectorSlug: string;
  instanceKey: string;
  displayName?: string | null;
  config: Record<string, unknown>;
  /** Secret values to encrypt and store. Absent keys are left untouched. */
  secrets: Record<string, string>;
  contractVersion: number;
  contractChecksum: string;
};

/**
 * Create or update an installation and its secrets in ONE transaction.
 *
 * Atomicity matters more here than it looks: a half-applied configuration is an
 * installation pointing at a new endpoint with the old credentials, which is
 * both broken and a plausible way to send one system's secrets to another.
 */
export async function upsertInstallation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  keyring: SecretKeyring,
  input: UpsertInstallationInput,
): Promise<ConnectorInstallation> {
  return withDbSession(db, session, async (trx) => {
    const existing = await sql<InstallationRow>`
      select id, connector_slug, instance_key, display_name, config, enabled,
             contract_version, contract_checksum
        from platform.connector_installations
       where connector_slug = ${input.connectorSlug}
         and instance_key = ${input.instanceKey}
    `.execute(trx);

    const tenantId = session.tenantId;
    const configJson = JSON.stringify(input.config);
    let installationId = existing.rows[0]?.id;

    if (installationId) {
      await sql`
        update platform.connector_installations
           set display_name = ${input.displayName ?? null},
               config = ${configJson}::jsonb,
               contract_version = ${input.contractVersion},
               contract_checksum = ${input.contractChecksum},
               updated_at = now()
         where id = ${installationId}::uuid
      `.execute(trx);
    } else {
      const inserted = await sql<{ id: string }>`
        insert into platform.connector_installations
          (tenant_id, connector_slug, instance_key, display_name, config, enabled,
           contract_version, contract_checksum)
        values (${tenantId}::uuid, ${input.connectorSlug}, ${input.instanceKey},
                ${input.displayName ?? null}, ${configJson}::jsonb, false,
                ${input.contractVersion}, ${input.contractChecksum})
        returning id
      `.execute(trx);
      installationId = inserted.rows[0]!.id;
    }

    for (const [fieldKey, plaintext] of Object.entries(input.secrets)) {
      const stored = encryptSecret(keyring, installationId, fieldKey, plaintext);
      await sql`
        insert into platform.connector_secrets
          (tenant_id, installation_id, field_key, ciphertext, key_id, algorithm)
        values (${tenantId}::uuid, ${installationId}::uuid, ${fieldKey},
                ${stored.ciphertext}, ${stored.keyId}, ${stored.algorithm})
        on conflict (tenant_id, installation_id, field_key)
        do update set ciphertext = excluded.ciphertext,
                      key_id = excluded.key_id,
                      algorithm = excluded.algorithm,
                      updated_at = now()
      `.execute(trx);
    }

    const row = await sql<InstallationRow>`
      select id, connector_slug, instance_key, display_name, config, enabled,
             contract_version, contract_checksum
        from platform.connector_installations
       where id = ${installationId}::uuid
    `.execute(trx);

    const secretFields = await loadSecretFieldNames(trx, [installationId]);
    return toInstallation(
      row.rows[0]!,
      secretFields.get(installationId) ?? new Set<string>(),
    );
  });
}

export async function setInstallationEnabled(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  connectorSlug: string,
  instanceKey: string,
  enabled: boolean,
): Promise<boolean> {
  return withDbSession(db, session, async (trx) => {
    const result = await sql<{ id: string }>`
      update platform.connector_installations
         set enabled = ${enabled}, updated_at = now()
       where connector_slug = ${connectorSlug} and instance_key = ${instanceKey}
      returning id
    `.execute(trx);
    return result.rows.length > 0;
  });
}

export async function deleteInstallation(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  connectorSlug: string,
  instanceKey: string,
): Promise<boolean> {
  return withDbSession(db, session, async (trx) => {
    // Secrets cascade via the FK, so a deleted installation cannot leave
    // orphaned ciphertext behind.
    const result = await sql<{ id: string }>`
      delete from platform.connector_installations
       where connector_slug = ${connectorSlug} and instance_key = ${instanceKey}
      returning id
    `.execute(trx);
    return result.rows.length > 0;
  });
}

/**
 * Decrypt an installation's secrets. The ONLY path that yields plaintext.
 *
 * Reserved for connector invocation, which is why it is a separate export from
 * everything the configuration surface uses: a reviewer can grep for callers of
 * this function and see the complete list of places a credential is in memory.
 */
export async function readSecrets(
  db: OpenShapeForgeDatabase,
  session: DbSessionInput,
  keyring: SecretKeyring,
  installationId: string,
): Promise<Record<string, string>> {
  return withDbSession(db, session, async (trx) => {
    const rows = await sql<{
      field_key: string;
      ciphertext: string;
      key_id: string;
      algorithm: string;
    }>`
      select field_key, ciphertext, key_id, algorithm
        from platform.connector_secrets
       where installation_id = ${installationId}::uuid
    `.execute(trx);

    const secrets: Record<string, string> = {};
    for (const row of rows.rows) {
      const stored: StoredSecret = {
        ciphertext: row.ciphertext,
        keyId: row.key_id,
        algorithm: row.algorithm,
      };
      secrets[row.field_key] = decryptSecret(
        keyring,
        installationId,
        row.field_key,
        stored,
      );
    }
    return secrets;
  });
}
