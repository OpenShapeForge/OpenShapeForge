// SPDX-License-Identifier: BUSL-1.1
/**
 * The plaintext of a Connection's configuration, for a runtime module.
 *
 * Until this existed, a module could reach a connection row through
 * `platform.db.withSession` and get ciphertext: decryption lived in the MCP
 * execution path (`mcp/declarative-execution.ts`), which speaks HTTP and
 * nothing else. A koppeling that opens a socket — IMAP, SMTP, LDAP, a database
 * — therefore had no way to learn its own password, and the only workarounds
 * were worse than the gap: hand modules the keyring, or let a host pass
 * credentials in at boot and give up per-employee connections entirely.
 *
 * What this adds is deliberately NOT "modules can decrypt". Core decrypts, and
 * hands back exactly one connection's values after deciding the module may see
 * them. Three gates, in this order:
 *
 *   1. the row is read under the CALLER's session, so `integration.connections`
 *      row-level security decides which rows exist at all (an owned row is
 *      visible only to its owner; an unowned row is organization-public);
 *   2. the Adapter's `auth.connectionScope` is enforced on top — a `user`
 *      Adapter never resolves an unowned row, and never another employee's,
 *      even if RLS were widened later;
 *   3. only then is the ciphertext opened, field by field, under the same AAD
 *      scope the elicitation wrote it with.
 *
 * Gate 2 is not redundant with gate 1. RLS answers "may this session read this
 * row"; connectionScope answers "is this row this person's own credential".
 * A `user` Adapter whose row lost its owner must fail, not fall back to a
 * shared one — that is the difference between a personal mailbox and everyone
 * reading the first mailbox somebody connected.
 *
 * The result also carries an opaque EGRESS GRANT (see `socket-egress.ts`). A
 * module never states its own allow-list: it hands the grant back to core,
 * which reads the Adapter's `egressHosts` again. So a connection's credentials
 * and the hosts it may be used against travel together and cannot be mixed.
 */
import { sql } from "kysely";
import manifest from "../generated/db/manifest.json" with { type: "json" };
import rawCatalog from "../generated/mcp/tools.json" with { type: "json" };
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import {
  connectionTokenSecretScope,
  decryptSecret,
  keyringFromEnv,
  type SecretKeyring,
  type StoredSecret,
} from "../connectors/secrets.js";
import type {
  ModuleConnectionResolution,
  ModuleConnectionSelector,
  ModuleConnectionValues,
} from "./contract.js";
import { mintSocketGrant } from "./socket-egress.js";
import { liveConnectionValues, secretKeysOf } from "./connection-oauth-liveness.js";

const KEYRING_ENV = "OPENSHAPEFORGE_ELICITED_SECRET_KEYS";

type JsonRecord = Record<string, unknown>;

/**
 * The canonical vocabulary, read from the same generated catalog the MCP
 * execution path reads. Nothing here names a host's tables: which entity plays
 * "connection" and "adapter" is configuration (`mcp.derivedTools.execution`),
 * exactly as it is for declarative execution.
 */
type ExecutionShape = {
  providerTable: string;
  connectionTable: string;
  connectionProviderRef: string;
  connectionValuesField: string;
};

type CatalogShape = {
  entities?: {
    table?: string;
    elicitOnCreate?: { sourceTable?: string; definitionsField?: string };
  }[];
  derivedTools?: { execution?: ExecutionShape }[];
};

const catalog = rawCatalog as CatalogShape;

function executionShape(source: CatalogShape): ExecutionShape | undefined {
  for (const entry of source.derivedTools ?? []) {
    if (entry.execution?.connectionTable) return entry.execution;
  }
  return undefined;
}

type ManifestTable = {
  name: string;
  schema: string;
  table: string;
  primaryKey?: string;
  columns?: { name: string; sourceField?: string }[];
  source?: {
    authorization?: { rowAccess?: { owner?: { column?: string } } };
  };
};

function manifestTable(
  source: { tables?: ManifestTable[] },
  name: string,
): ManifestTable | undefined {
  return (source.tables ?? []).find(
    (table) => table.name === name,
  );
}

/** The physical column an authored field name is stored in. */
function columnFor(table: ManifestTable | undefined, field: string): string | undefined {
  return (table?.columns ?? []).find((column) => column.sourceField === field)?.name;
}

/** Split a `schema.table` catalog name the way Kysely wants it. */
function tableRef(name: string) {
  return sql.table(name);
}

/**
 * Whether this Adapter's Connections are one per employee or one per
 * organization. Same rule the MCP invocation path applies, kept in one shape
 * so the two cannot drift: an `oauth2AuthorizationCode` profile is personal
 * unless the Adapter says otherwise.
 */
export function connectionScopeOf(auth: unknown): "tenant" | "user" | "both" {
  const config = auth && typeof auth === "object" ? (auth as JsonRecord) : undefined;
  const declared = config?.connectionScope;
  if (declared === "user" || declared === "tenant" || declared === "both") return declared;
  return config?.profile === "oauth2AuthorizationCode" ? "user" : "tenant";
}

function looksLikeStoredSecret(value: unknown): value is StoredSecret {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredSecret).ciphertext === "string" &&
    typeof (value as StoredSecret).keyId === "string"
  );
}

const TOKEN_FIELDS = new Set(["accessToken", "refreshToken"]);

function refuse(
  code: Extract<ModuleConnectionResolution, { ok: false }>["code"],
  message: string,
): ModuleConnectionResolution {
  return { ok: false, code, message };
}

export type ResolveConnectionInput = {
  db: OpenShapeForgeDatabase;
  session: TrustedSessionContext;
  selector: ModuleConnectionSelector;
  keyring?: SecretKeyring | undefined;
  /** Test seam for the token endpoint an expired OAuth sign-in is renewed at. */
  fetchImpl?: typeof fetch | undefined;
  /** Generated host artifacts; omitted in production, injectable for tests. */
  artifacts?: {
    catalog: CatalogShape;
    manifest: { tables?: ManifestTable[] };
  } | undefined;
};

/**
 * Resolve one Connection's values for the caller. Every refusal is one of a
 * closed set and carries a sentence a person can act on; none of them says
 * whether a row the caller may not see exists, because "not yours" and "not
 * there" must read the same to a module.
 */
export async function resolveConnectionValues(
  input: ResolveConnectionInput,
): Promise<ModuleConnectionResolution> {
  const artifacts = input.artifacts ?? {
    catalog,
    manifest: manifest as { tables?: ManifestTable[] },
  };
  const execution = executionShape(artifacts.catalog);
  if (!execution) {
    return refuse(
      "CONNECTION_REQUIRED",
      "This deployment declares no Connections, so there is nothing to resolve.",
    );
  }
  const connectionTable = manifestTable(artifacts.manifest, execution.connectionTable);
  const providerTable = manifestTable(artifacts.manifest, execution.providerTable);
  const valuesColumn = columnFor(connectionTable, execution.connectionValuesField);
  const providerRefColumn = columnFor(connectionTable, execution.connectionProviderRef);
  const ownerColumn =
    connectionTable?.source?.authorization?.rowAccess?.owner?.column ?? "owner_user_id";
  if (!connectionTable || !valuesColumn || !providerRefColumn || !providerTable) {
    return refuse(
      "CONNECTION_REQUIRED",
      "The Connection catalog is incomplete in this build, so no connection can be resolved.",
    );
  }

  // The Adapter fields this reads are the canonical execution vocabulary the
  // declarative executor already interprets (transport, auth, egressHosts,
  // configurationFields); their COLUMNS come from the manifest so a host that
  // spells a column differently still works.
  const providerColumns = {
    key: columnFor(providerTable, "key"),
    auth: columnFor(providerTable, "auth"),
    transport: columnFor(providerTable, "transport"),
    egress: columnFor(providerTable, "egressHosts"),
    definitions: columnFor(providerTable, "configurationFields"),
  };
  const {
    key: providerKeyColumn,
    auth: providerAuthColumn,
    transport: providerTransportColumn,
    egress: providerEgressColumn,
    definitions: providerDefinitionsColumn,
  } = providerColumns;
  if (
    !providerKeyColumn ||
    !providerAuthColumn ||
    !providerTransportColumn ||
    !providerEgressColumn ||
    !providerDefinitionsColumn
  ) {
    return refuse(
      "CONNECTION_REQUIRED",
      "The Adapter catalog is incomplete in this build, so no connection can be resolved.",
    );
  }

  type ConnectionRow = {
    id: string;
    key: string;
    values: unknown;
    owner: string | null;
    adapter_id: string;
    adapter_key: string;
    adapter_auth: unknown;
    adapter_transport: string | null;
    adapter_egress: unknown;
    adapter_definitions: unknown;
  };

  const selector = input.selector;
  const row = await withDbSession(input.db, input.session, async (trx) => {
    // Read under the caller's own session: row-level security decides which
    // rows exist before any of this code sees one.
    const connections = tableRef(execution.connectionTable);
    const providers = tableRef(execution.providerTable);
    const values = sql.ref(valuesColumn);
    const owner = sql.ref(ownerColumn);
    const providerRef = sql.ref(providerRefColumn);
    const projection = sql`
      c.id as id, c.key as key, c.${values} as values, c.${owner} as owner,
      a.id as adapter_id,
      a.${sql.ref(providerKeyColumn)} as adapter_key,
      a.${sql.ref(providerAuthColumn)} as adapter_auth,
      a.${sql.ref(providerTransportColumn)} as adapter_transport,
      a.${sql.ref(providerEgressColumn)} as adapter_egress,
      a.${sql.ref(providerDefinitionsColumn)} as adapter_definitions
    `;
    if ("connectionId" in selector) {
      const result = await sql<ConnectionRow>`
        select ${projection}
          from ${connections} c
          join ${providers} a on a.id = c.${providerRef}
         where c.id = ${selector.connectionId}::uuid
         limit 1
      `.execute(trx);
      return result.rows[0];
    }
    const result = await sql<ConnectionRow>`
      select ${projection}
        from ${connections} c
        join ${providers} a on a.id = c.${providerRef}
       where a.${sql.ref(providerKeyColumn)} = ${selector.adapterKey}
       order by (c.${owner} is null), c.id
       limit 2
    `.execute(trx);
    // A personal Adapter can hold one row per employee, but RLS has already
    // narrowed the visible set to this employee's own (plus any unowned one,
    // which gate 2 below rejects for a `user` Adapter).
    return (
      result.rows.find((candidate) => candidate.owner === input.session.userId) ??
      result.rows[0]
    );
  });

  if (!row) {
    return refuse(
      "NOT_FOUND",
      "connectionId" in selector
        ? "No Connection with that identifier is available to you."
        : `No Connection to the "${selector.adapterKey}" Adapter is available to you.`,
    );
  }

  const declaredScope = connectionScopeOf(row.adapter_auth);
  const scope =
    declaredScope === "both"
      ? row.owner === input.session.userId
        ? "user"
        : "tenant"
      : declaredScope;
  if (scope === "user") {
    if (!input.session.userId) {
      return refuse(
        "FORBIDDEN",
        "This Connection belongs to one employee, and this session acts as no employee.",
      );
    }
    if (row.owner !== input.session.userId) {
      // Reached only if RLS were ever widened; the message stays the same as
      // "no such connection" so it cannot be used to probe for other people's.
      return refuse(
        "NOT_FOUND",
        "No Connection to that Adapter is available to you.",
      );
    }
  } else if (row.owner !== null && row.owner !== input.session.userId) {
    return refuse("NOT_FOUND", "No Connection to that Adapter is available to you.");
  }

  const keyring = input.keyring ?? keyringFromEnv(process.env[KEYRING_ENV]);
  const elicitScope =
    (artifacts.catalog.entities ?? []).find((entity) => entity.table === execution.connectionTable)
      ?.elicitOnCreate?.sourceTable ?? execution.providerTable;
  const tokenScope = connectionTokenSecretScope(execution.connectionTable);
  const egress = Array.isArray(row.adapter_egress)
    ? (row.adapter_egress as unknown[]).filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];

  // An OAuth access token is renewed BEFORE it is handed over, by the same
  // code the HTTP path refreshes with; every other Adapter passes through.
  const live = await liveConnectionValues({
    db: input.db,
    session: input.session,
    keyring,
    row: {
      id: row.id,
      owner: row.owner,
      adapterId: row.adapter_id,
      auth: (row.adapter_auth ?? null) as JsonRecord | null,
      egress,
      definitions: row.adapter_definitions,
      values: (row.values ?? {}) as JsonRecord,
    },
    table: { ...connectionTable, columns: connectionTable.columns ?? [] },
    providerTable: execution.providerTable,
    valuesField: execution.connectionValuesField,
    providerRefField: execution.connectionProviderRef,
    columns: { values: valuesColumn, owner: ownerColumn, providerRef: providerRefColumn },
    elicitScope,
    tokenScope,
    fetchImpl: input.fetchImpl,
  });
  if (!live.ok) return refuse(live.code, live.message);

  const stored = live.values;
  const values: Record<string, string> = {};
  try {
    for (const [key, value] of Object.entries(stored)) {
      if (looksLikeStoredSecret(value)) {
        if (!keyring) {
          return refuse(
            "SECRET_KEYRING_MISSING",
            `This Connection holds an encrypted value and this process has no keyring; set ${KEYRING_ENV}.`,
          );
        }
        values[key] = decryptSecret(
          keyring,
          TOKEN_FIELDS.has(key) ? tokenScope : elicitScope,
          key,
          value,
        );
      } else if (value !== null && value !== undefined && typeof value !== "object") {
        values[key] = String(value);
      }
    }
  } catch (error) {
    return refuse(
      "SECRET_KEYRING_MISSING",
      `This Connection's stored values could not be opened with the current keyring (${
        error instanceof Error ? error.message : "unknown reason"
      }).`,
    );
  }

  const connection: ModuleConnectionValues = {
    connectionId: row.id,
    connectionKey: row.key,
    adapterKey: row.adapter_key,
    transport: row.adapter_transport ?? "",
    connectionScope: scope,
    ownerUserId: row.owner,
    values: Object.freeze(values),
    secretKeys: Object.freeze([...secretKeysOf(row.adapter_definitions)]),
    egressGrant: mintSocketGrant({
      allowlist: egress,
      adapterKey: row.adapter_key,
      adapterName: row.adapter_key,
      tenantId: input.session.tenantId,
    }),
  };
  return { ok: true, connection };
}
