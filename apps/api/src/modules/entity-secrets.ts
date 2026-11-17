// SPDX-License-Identifier: BUSL-1.1
/**
 * The plaintext of one record's static secure-input values, for the plugin
 * Operation that record's entity names.
 *
 * `connection-secrets.ts` opens the one catalog Connection and derives its
 * egress policy from an Adapter. This is the same seam for an entity that
 * declares its secure fields itself (`interaction.fields`) and names who may
 * open them (`interaction.resolve`). Core still decrypts, and still decides:
 *
 *   1. only an entity whose create Operation declares `resolve` resolves at
 *      all, and only while one of the Operations it names is executing;
 *   2. where that Operation is bound to one record of the entity, only that
 *      record resolves;
 *   3. the row is read under the CALLER's session, so row-level security
 *      decides which rows exist; "not yours" and "not there" answer the same;
 *   4. a declarative invocation bound to one exact Connection still refuses a
 *      credential that is not that Connection;
 *   5. the record's stored URL must be an HTTPS URL naming one exact host;
 *   6. only then is the ciphertext opened, under an AAD scope that binds it to
 *      the tenant, the table and that URL's origin.
 *
 * Gate 6 is why a stored key cannot be re-pointed: a record whose URL moved to
 * another origin no longer decrypts, and its values must be entered again.
 *
 * The egress grant admits the record's own URL and nothing else: the
 * allow-list is that one hostname, and the grant is bound to the URL as its
 * protected resource, so `connection-http-egress.ts` also pins the origin, the
 * path and the query. A module names no policy here either.
 */
import { sql } from "kysely";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import {
  decryptSecret,
  keyringFromEnv,
  type SecretKeyring,
  type StoredSecret,
} from "../connectors/secrets.js";
import { ambientConnectionControls, assertConnectionControls } from "../mcp/connection-expectation.js";
import { connectionGrantSubject } from "../mcp/connection-delegation.js";
import { auditContext } from "../platform/audit-context.js";
import { getGeneratedCrudTables } from "../operations/entity/catalog.js";
import { fieldNameForColumn } from "../operations/entity/columns.js";
import type { GeneratedCrudTable } from "../operations/entity/types.js";
import type { ModuleEntitySecretResolution, ModuleEntitySecretSelector, ModuleSocketGrant } from "./contract.js";
import { mintSocketGrant } from "./socket-egress.js";

const KEYRING_ENV = "OPENSHAPEFORGE_ELICITED_SECRET_KEYS";
/** The same bound a Connection grant has; a changed record is read again after it. */
const EGRESS_GRANT_TTL_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type StaticSecureInput = {
  into: string;
  fields: readonly { key: string; required?: boolean; classification?: { sensitivity: string } }[];
  resolve?: { operations: readonly string[]; egress: { urlField: string } };
};

/** The static secure-input declaration of an entity, if it has one. */
export function staticSecureInput(table: GeneratedCrudTable | undefined): StaticSecureInput | undefined {
  const secure = table?.source?.secureInputOnCreate;
  return secure?.fields ? { into: secure.into, fields: secure.fields, ...(secure.resolve ? { resolve: secure.resolve } : {}) } : undefined;
}

/**
 * The one destination a record's secrets may be sent to. HTTPS only, no
 * userinfo and no fragment, and a hostname that is exactly one host: `*` is a
 * legal host character and a wildcard in an allow-list entry.
 */
export function secureTargetUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
  if (!url.hostname || url.hostname.includes("*")) return undefined;
  return url;
}

/**
 * The AAD scope static secure-input values are sealed under. Tenant and table
 * keep a ciphertext from opening for another tenant or entity; the origin
 * keeps it from opening after the record was pointed somewhere else.
 */
export function entitySecretScope(tenantId: string, table: string, origin: string | undefined): string {
  return `entity-secure:${tenantId.toLowerCase()}:${table}:${origin ?? ""}`;
}

/** The scope for one write: the origin comes from the record's own URL field. */
export function staticSecretScopeFor(
  secure: Pick<StaticSecureInput, "resolve">,
  table: string,
  tenantId: string,
  values: Readonly<Record<string, unknown>>,
): { ok: true; scope: string } | { ok: false } {
  if (!secure.resolve) return { ok: true, scope: entitySecretScope(tenantId, table, undefined) };
  const url = secureTargetUrl(values[secure.resolve.egress.urlField]);
  return url ? { ok: true, scope: entitySecretScope(tenantId, table, url.origin) } : { ok: false };
}

/**
 * Core-only. The grant of one record: its allow-list is the record URL's one
 * hostname, and the URL itself is the protected resource the HTTP path pins
 * origin, path and query to. A bare hostname grants no socket.
 */
export function mintRecordEgressGrant(input: {
  session: TrustedSessionContext;
  entity: string;
  id: string;
  table: string;
  url: URL;
  expiresAtMs: number;
}): ModuleSocketGrant {
  return mintSocketGrant({
    allowlist: [input.url.hostname],
    adapterKey: input.entity,
    adapterName: input.entity,
    subject: "record",
    tenantId: input.session.tenantId,
    binding: {
      session: input.session,
      connectionId: input.id,
      connectionTable: input.table,
      ownerUserId: null,
      expiresAtMs: input.expiresAtMs,
      resource: input.url.href,
    },
  });
}

function looksLikeStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredSecret).ciphertext === "string" &&
    typeof (value as StoredSecret).keyId === "string"
  );
}

function refuse(
  code: Extract<ModuleEntitySecretResolution, { ok: false }>["code"],
  message: string,
): ModuleEntitySecretResolution {
  return { ok: false, code, message };
}

const UNAVAILABLE = "No such record with resolvable secure values is available to this Operation.";

export type ResolveEntitySecretInput = {
  db: OpenShapeForgeDatabase;
  session: TrustedSessionContext;
  selector: ModuleEntitySecretSelector;
  keyring?: SecretKeyring | undefined;
  /** Generated tables; omitted in production, injectable for tests. */
  tables?: readonly GeneratedCrudTable[] | undefined;
  now?: (() => number) | undefined;
};

/**
 * Resolve one record's secure values for the executing plugin Operation. Every
 * refusal is one of a closed set, and none of them quotes the stored URL or a
 * stored value.
 */
export async function resolveEntitySecretValues(
  input: ResolveEntitySecretInput,
): Promise<ModuleEntitySecretResolution> {
  const { session } = input;
  const entity = typeof input.selector?.entity === "string" ? input.selector.entity : "";
  const id = typeof input.selector?.id === "string" ? input.selector.id : "";
  const table = (input.tables ?? getGeneratedCrudTables())
    .find((candidate) => candidate.source?.authoringEntityName === entity);
  const secure = staticSecureInput(table);
  const resolve = secure?.resolve;
  if (!table || !secure || !resolve || !table.primaryKey || !UUID.test(id) || !session.tenantId) {
    return refuse("NOT_FOUND", UNAVAILABLE);
  }
  const operationId = auditContext()?.operationId;
  if (!operationId || !resolve.operations.includes(operationId)) {
    return refuse("FORBIDDEN", `${entity} does not let this Operation resolve its secure values.`);
  }
  // A record-targeted write Operation of this entity opens its own record only.
  const subject = connectionGrantSubject();
  if (subject && subject.entity === entity && subject.id.toLowerCase() !== id.toLowerCase()) {
    return refuse("FORBIDDEN", "This Operation may resolve only the record it was invoked for.");
  }
  const valuesColumn = table.columns.find((column) => fieldNameForColumn(column) === secure.into);
  const urlColumn = table.columns.find((column) => fieldNameForColumn(column) === resolve.egress.urlField);
  if (!valuesColumn || !urlColumn) return refuse("NOT_FOUND", UNAVAILABLE);

  // Read under the caller's own session: row-level security decides which
  // rows exist before any of this code sees one.
  const row = await withDbSession(input.db, session, async (trx) => {
    const result = await sql<{ values: unknown; url: unknown }>`
      select ${sql.ref(valuesColumn.name)} as values, ${sql.ref(urlColumn.name)} as url
        from ${sql.id(table.schema, table.table)}
       where ${sql.ref(table.primaryKey!)} = ${id}::uuid
         ${table.tenantScoped ? sql`and tenant_id = ${session.tenantId}::uuid` : sql``}
       limit 1
    `.execute(trx);
    return result.rows[0];
  });
  if (!row) return refuse("NOT_FOUND", UNAVAILABLE);

  assertConnectionControls({
    controls: ambientConnectionControls(),
    session,
    connectionTable: table.name,
    connection: { id, ownerUserId: null },
  });

  const url = secureTargetUrl(row.url);
  if (!url) {
    return refuse(
      "EGRESS_TARGET_INVALID",
      "This record's stored URL is not an HTTPS URL naming one exact host without credentials or a fragment.",
    );
  }

  const stored = row.values && typeof row.values === "object" && !Array.isArray(row.values)
    ? (row.values as Record<string, unknown>)
    : {};
  const keyring = input.keyring ?? keyringFromEnv(process.env[KEYRING_ENV]);
  const scope = entitySecretScope(session.tenantId, table.name, url.origin);
  const reentry = () => refuse(
    "SECRET_REENTRY_REQUIRED",
    "This record's secure values are incomplete or were entered for another destination; enter them again.",
  );
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (looksLikeStoredSecret(value)) {
      if (!keyring || !keyring.keys.has(value.keyId)) {
        return refuse(
          "SECRET_KEYRING_MISSING",
          `This record holds an encrypted value this process has no key for; set ${KEYRING_ENV}.`,
        );
      }
      try {
        values[key] = decryptSecret(keyring, scope, key, value);
      } catch {
        return reentry();
      }
    } else if (value !== null && value !== undefined && typeof value !== "object") {
      values[key] = String(value);
    }
  }
  const secretKeys = secure.fields
    .filter((field) => field.classification?.sensitivity === "confidential")
    .map((field) => field.key);
  // A confidential value that is not sealed was never entered through the
  // secure form; a required one that is absent was never entered at all.
  for (const field of secure.fields) {
    const present = Object.hasOwn(values, field.key);
    if ((field.required === true && !present) ||
      (present && secretKeys.includes(field.key) && !looksLikeStoredSecret(stored[field.key]))) {
      return reentry();
    }
  }

  return {
    ok: true,
    record: {
      entity,
      id,
      values: Object.freeze(values),
      secretKeys: Object.freeze(secretKeys),
      url: url.href,
      egressGrant: mintRecordEgressGrant({
        session, entity, id, table: table.name, url,
        expiresAtMs: (input.now ?? Date.now)() + EGRESS_GRANT_TTL_MS,
      }),
    },
  };
}
