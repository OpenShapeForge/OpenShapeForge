// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { RuntimeDeclarativeServiceDefinition, RuntimeProviderReadTarget } from "@openshapeforge/plugin-runtime";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { withDbSession } from "../db/session.js";
import { getGeneratedCrudTables } from "../operations/entity/catalog.js";
import { HttpError } from "../rest/http-error.js";
import { catalogDerivedTools, entityForTable, type GeneratedTable } from "./catalog.js";
import { fieldNameForColumn, serializeRow, stableSnapshotJson } from "./catalog-rows.js";
import { derivedToolsFromRows, isAuthorizedInternalDerivedRow, sessionInAudience } from "./derived-tools.js";
import { composeBindingRequest, orderedBindingRecords } from "./declarative-execution.js";
import { normalizeConnectionValueRows } from "./session-connections.js";

type GraphRow = Record<string, unknown>;

export function pinnedReadRefused() {
  return new HttpError(403, "PINNED_READ_REFUSED", "The binding does not match the approved provider read.");
}

export function providerReadExecutionFingerprint(
  target: RuntimeProviderReadTarget,
  rows: { service: GraphRow; binding: GraphRow; capability: GraphRow; adapter: GraphRow },
) {
  const operation = rows.capability.operation as GraphRow | undefined;
  if (rows.binding.optional === true || rows.binding.forEach != null ||
      rows.adapter.key !== target.adapterKey || rows.adapter.transport !== "rest" ||
      rows.capability.key !== target.capabilityKey || rows.capability.kind !== "query" ||
      rows.capability.pagination != null || operation?.method !== "GET") throw pinnedReadRefused();

  // Hash all stored execution fields, including mappings and authentication
  // templates. Connection credentials are resolved separately and never enter
  // this graph. Drop only the row metadata set by storage itself.
  const content = Object.fromEntries(Object.entries(rows).map(([name, row]) => [
    name, Object.fromEntries(Object.entries(row)
      .filter(([key, value]) => key !== "createdAt" && key !== "updatedAt" && value !== undefined)),
  ]));
  const sha = createHash("sha256").update(stableSnapshotJson({
    target: { adapterKey: target.adapterKey, capabilityKey: target.capabilityKey,
      origin: target.origin, pathname: target.pathname },
    content,
  })).digest("hex");
  return `sha256:${sha}`;
}

/** Capture the Service, its single mandatory binding and provider definitions
 * in one MVCC statement under the publishing session's tenant policies. */
export async function publishedProviderReadFingerprint(
  db: OpenShapeForgeDatabase,
  session: TrustedSessionContext,
  definition: RuntimeDeclarativeServiceDefinition,
  target: RuntimeProviderReadTarget,
  connectionId: string,
  sampleInput: GraphRow,
) {
  const entry = catalogDerivedTools.find((candidate) => candidate.entity === definition.entity);
  const execution = entry?.execution;
  if (!entry || !execution || !session.tenantId || !sessionInAudience(entry, session.roles)) throw pinnedReadRefused();

  const tables = new Map(getGeneratedCrudTables().map((table) => [table.name, table]));
  const serviceTable = tables.get(entry.table);
  const bindingTable = tables.get(execution.bindingsTable);
  const capabilityTable = tables.get(execution.operationTable);
  const adapterTable = tables.get(execution.providerTable);
  const connectionTable = tables.get(execution.connectionTable);
  if (!serviceTable || !bindingTable || !capabilityTable || !adapterTable || !connectionTable || !entry.versionField) throw pinnedReadRefused();

  const table = (entry: GeneratedTable) => sql.id(entry.schema, entry.table);
  const column = (entry: GeneratedTable, key: string, alias: string) => {
    const name = entry.columns.find((candidate) => fieldNameForColumn(candidate) === key)?.name;
    if (!name) throw pinnedReadRefused();
    return sql.id(alias, name);
  };
  const result = await withDbSession(db, session, (trx) =>
    sql<{ service: GraphRow; binding: GraphRow; capability: GraphRow | null; adapter: GraphRow | null; connection: GraphRow | null }>`
      select to_jsonb(s) as service, to_jsonb(b) as binding,
             to_jsonb(c) as capability, to_jsonb(a) as adapter, to_jsonb(conn) as connection
        from ${table(serviceTable)} s
        join ${table(bindingTable)} b on ${column(bindingTable, execution.parentRef, "b")} = s.id
        left join ${table(capabilityTable)} c on c.id = ${column(bindingTable, execution.operationRef, "b")}
        left join ${table(adapterTable)} a on a.id = ${column(capabilityTable, execution.providerRef, "c")}
        left join ${table(connectionTable)} conn on conn.id = ${connectionId}::uuid
          and ${column(connectionTable, execution.connectionProviderRef, "conn")} = a.id
       where s.id = ${definition.id}::uuid
       limit 2
    `.execute(trx));
  const graph = result.rows[0];
  if (result.rows.length !== 1 || !graph?.capability || !graph.adapter || !graph.connection) throw pinnedReadRefused();
  const service = serializeRow(serviceTable, graph.service);
  const roles = session.roles ?? [];
  if (service[entry.keyField] !== definition.key || String(service[entry.versionField]) !== String(definition.version) ||
      (!isAuthorizedInternalDerivedRow(entry, service, roles) &&
        derivedToolsFromRows(entry, [service], new Set(), roles).length !== 1)) throw pinnedReadRefused();

  const [binding] = orderedBindingRecords([serializeRow(bindingTable, graph.binding)]);
  const capability = serializeRow(capabilityTable, graph.capability);
  const adapter = serializeRow(adapterTable, graph.adapter);
  const fingerprint = providerReadExecutionFingerprint(target, { service, binding: binding!, capability, adapter });
  const [connection] = normalizeConnectionValueRows([serializeRow(connectionTable, graph.connection)], execution.connectionValuesField);
  const values = connection?.[execution.connectionValuesField];
  if (!values || typeof values !== "object" || Array.isArray(values)) throw pinnedReadRefused();
  const definitionField = entityForTable(execution.connectionTable)?.elicitOnCreate?.definitionsField;
  const preview = await composeBindingRequest({
    mode: "describe", binding: binding!, operationRow: capability, providerRow: adapter,
    connectionValues: values as GraphRow, serviceInputs: sampleInput, secretScope: "",
    ...(definitionField ? { providerDefinitions: adapter[definitionField] } : {}),
    fetchImpl: Object.assign(async () => { throw pinnedReadRefused(); }, {
      preconnect: () => { throw pinnedReadRefused(); },
    }),
  });
  if (preview.method !== "GET" || preview.url.origin !== target.origin || preview.url.pathname !== target.pathname) {
    throw pinnedReadRefused();
  }
  return fingerprint;
}
