// SPDX-License-Identifier: BUSL-1.1
/**
 * Shared fixture for the document revision scratch-database tests: one
 * throwaway database built by the real migration chain, an app-role
 * connection, and platform services that are real where the schema owns
 * them (record access, field schemas, JSON validation, entity-value
 * metadata) and stubbed where a server would supply them (artifact storage,
 * the Operation dispatcher).
 */
import { expect } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Transaction } from "kysely";
import type { ModuleOperationContext } from "@openshapeforge/plugin-runtime";
import documents from "@openshapeforge/documents/runtime";
import versioning from "@openshapeforge/versioning/runtime";
import type { DB } from "../../generated/db/types.js";
import rawCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import { createDatabaseRuntime, type DatabaseRuntime } from "../../db/connection.js";
import { runMigrationChain } from "../../db/migration-chain.js";
import { withDbSession, type DbSessionInput } from "../../db/session.js";
import { jsonbLiteral } from "../../db/sql-helpers.js";
import { generatedEntityValues } from "../../modules/entity-value-registry.js";
import { generatedRuntimeFieldSchemas, runtimeJsonSchemas } from "../../modules/field-schemas.js";
import { RecordAccessRuntime } from "../../modules/record-access.js";
import { createCollectionMutationExecutor } from "../../operations/entity/collection-mutations.js";
import { getGeneratedCrudTables } from "../../operations/entity/catalog.js";
import type { EntityOperationContract } from "../../operations/entity/types.js";

const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
export const tenant = randomUUID();
export const actor = randomUUID();
export type Session = { tenantId: string; userId: string; credential: "bearer"; roles: string[]; groups: never[]; scope: "tenant" };
const session = (roles: string[]): Session => ({ tenantId: tenant, userId: actor, credential: "bearer", roles, groups: [], scope: "tenant" });
/** Full editor: documents, templates and organization writes. */
export const editor = session(["CaseFile.All.ReadWrite", "Organization.All.ReadWrite", "Templates.Read", "General.All.Read"]);
/** Document editor without any template role. */
export const caseUser = session(["CaseFile.All.ReadWrite"]);
/** Template publisher without any document role. */
export const publisher = session(["Organization.All.ReadWrite", "Templates.Read"]);
/** Template reader without any document role. */
export const templateUser = session(["Templates.Read"]);
/** Document reader without any template role. */
export const documentReader = session(["CaseFile.All.Read"]);
export const documentVersion = async (id: string) => (await sql<{ v: string }>`select updated_at::text as v from erp.documents where id = ${id}::uuid`.execute(privileged())).rows[0]!.v;
export const dbInput = (who: Session): DbSessionInput => ({ tenantId: who.tenantId, userId: who.userId, roles: who.roles, groups: [], scope: "tenant" });

export const scratch: { name: string; admin?: SQL; privileged?: DatabaseRuntime; restricted?: DatabaseRuntime } = { name: `doc_revisions_${randomUUID().replaceAll("-", "")}` };
function databaseUrl(app = false) {
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") throw new Error("Scratch tests require a local postgres admin database, never an application database.");
  url.pathname = `/${scratch.name}`;
  if (app) { url.username = "openshapeforge_app"; url.password = "openshapeforge_app"; }
  return url.toString();
}
export async function openScratch(): Promise<void> {
  scratch.admin = new SQL(adminUrl, { max: 1 });
  await scratch.admin.unsafe(`create database "${scratch.name}"`);
  scratch.privileged = createDatabaseRuntime({ databaseUrl: databaseUrl(), maxConnections: 1 });
  await scratch.privileged.db.connection().execute((connection) => runMigrationChain(connection));
  scratch.restricted = createDatabaseRuntime({ databaseUrl: databaseUrl(true), maxConnections: 1 });
  // The API initialises modules after loading; that is where the documents module registers its publish follower.
  await documents.init?.();
  // Document types are tenant-scoped reference data; the chain seeds none for a fresh tenant.
  await sql`insert into erp.document_types (tenant_id, code, name) values (${tenant}::uuid, 'outgoing_mail', 'Outgoing mail')`.execute(scratch.privileged.db);
}
export async function closeScratch(): Promise<void> {
  await scratch.restricted?.close(); await scratch.privileged?.close();
  if (scratch.privileged) await scratch.admin?.unsafe(`drop database if exists "${scratch.name}" with (force)`);
  await scratch.admin?.close();
}
export const privileged = () => scratch.privileged!.db;
export const restricted = () => scratch.restricted!.db;
export const asUser = <T>(who: Session, work: (trx: Transaction<DB>) => Promise<T>) => withDbSession(restricted(), dbInput(who), work);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export type Staged = { artifactId: string; version: number; fileName: string; mediaType: string; sha256: string; byteSize: number; bytes: Uint8Array };
export type Handlers = Record<string, (input: Record<string, unknown>, context: ModuleOperationContext) => Promise<{ value: unknown }>>;

export function platformFor(who: Session) {
  let active: Transaction<DB> | undefined;
  const events: { eventType: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown> }[] = [];
  const staged: Staged[] = [];
  const operation = (id: string, entityName: string, intent: string, data: "read" | "write", input: Record<string, unknown>) =>
    ({ id, entityName, intent, effects: { data, external: "none" }, reliability: { idempotency: { mode: "natural" } }, input: { kind: "json-schema", schema: input }, output: { kind: "json-schema", schema: { type: "object" } } });
  const operations = [
    operation("TextBlock.materialize", "TextBlock", "invoke", "read", { type: "object", required: ["definitionKey", "values"], properties: { definitionKey: { const: "TextBlock" }, values: { type: "object" } } }),
    operation("DocumentVersion.create", "DocumentVersion", "create", "write", { type: "object" }),
    operation("DocumentVersion.get", "DocumentVersion", "get", "read", { type: "object" }),
  ];
  const handlers = documents.operationHandlers as Handlers;
  let context: ModuleOperationContext;
  const withSession = async <T>(_session: unknown, work: (trx: Transaction<DB>) => Promise<T>): Promise<T> => {
    if (active) return work(active);
    return asUser(who, async (trx) => { active = trx; try { return await work(trx); } finally { active = undefined; } });
  };
  const records = new RecordAccessRuntime({ acceptsSession: () => true, currentTransaction: () => active, withSession }).services;
  const platform = {
    db: { withSession },
    records,
    events: { async append(_session: unknown, event: (typeof events)[number]) { events.push(event); } },
    errors: { classifyDatabase: () => undefined },
    schemas: { fields: generatedRuntimeFieldSchemas, json: runtimeJsonSchemas, entityValues: generatedEntityValues },
    artifacts: {
      async stage(_session: unknown, data: { fileName: string; source: AsyncIterable<Uint8Array> }) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of data.source) chunks.push(chunk);
        const bytes = new Uint8Array(Buffer.concat(chunks));
        const entry: Staged = { artifactId: randomUUID(), version: 1, fileName: data.fileName, mediaType: "application/json", sha256: sha256(bytes), byteSize: bytes.byteLength, bytes };
        staged.push(entry);
        const { bytes: _bytes, ...descriptor } = entry;
        return descriptor;
      },
      async bind(_session: unknown, request: { artifactId: string; expectedArtifactVersion: number }) {
        const { bytes: _bytes, ...descriptor } = staged.find((entry) => entry.artifactId === request.artifactId)!;
        return { ...descriptor, version: request.expectedArtifactVersion + 1 };
      },
    },
    operations: {
      async list() { return operations; },
      async get(_session: unknown, id: string) { return operations.find((entry) => entry.id === id); },
      async execute(_session: unknown, request: { operation: { id: string }; input: Record<string, unknown> }) {
        try {
          if (request.operation.id === "TextBlock.materialize") return { data: (await handlers.materializeFields!(request.input, context)).value };
          if (request.operation.id === "DocumentVersion.create") return { data: (await handlers.createDocumentVersion!(request.input, context)).value };
          if (request.operation.id === "DocumentVersion.get") {
            const row = (await sql<Record<string, unknown>>`select id, document_id as "documentId", artifact_id as "artifactId", artifact_version::int as "artifactVersion",
              checksum, mime_type as "mimeType", byte_size::int as "byteSize", file_name as "fileName" from erp.document_versions where id = ${String(request.input.id)}::uuid`.execute(active!)).rows[0];
            return { data: row ?? null };
          }
          throw new Error(`Unexpected Operation ${request.operation.id}`);
        } catch (error) {
          const failure = (error as { operationError?: unknown }).operationError;
          if (failure) return { error: failure };
          throw error;
        }
      },
    },
  };
  context = { transport: "operation", session: who, platform } as unknown as ModuleOperationContext;
  return { context, events, staged, handlers };
}

/** The real collection machinery over the generated catalog, as the API wires it. */
export const collections = createCollectionMutationExecutor({
  tables: getGeneratedCrudTables(),
  operations: (rawCatalog as unknown as { entityOperations: EntityOperationContract[] }).entityOperations,
  entityValues: generatedEntityValues,
});
export const tableName = (entity: string) => getGeneratedCrudTables().find((table) => table.source?.authoringEntityName === entity)!.name;

export const parameters = [{ key: "name", osfType: "string", required: true, label: { en: "Name", nl: "Naam" } }];
export async function seedTemplate() {
  const ids = { template: randomUUID(), variant: randomUUID(), first: randomUUID(), second: randomUUID() };
  await sql`insert into erp.templates (id, tenant_id, key, name, parameters) values (${ids.template}::uuid, ${tenant}::uuid, ${`welcome-${ids.template.slice(0, 8)}`}, 'Welcome', ${jsonbLiteral(parameters)})`.execute(privileged());
  await sql`insert into erp.template_variants (id, tenant_id, template_id, channel, locale) values (${ids.variant}::uuid, ${tenant}::uuid, ${ids.template}::uuid, 'document', 'nl')`.execute(privileged());
  await sql`insert into erp.blocks (id, tenant_id, variant_id, variant_id_position, definition_key, "values") values
    (${ids.first}::uuid, ${tenant}::uuid, ${ids.variant}::uuid, 0, 'TextBlock', ${jsonbLiteral({ text: "Hello {{local.name}}" })}),
    (${ids.second}::uuid, ${tenant}::uuid, ${ids.variant}::uuid, 1, 'TextBlock', ${jsonbLiteral({ text: "Second" })})`.execute(privileged());
  return ids;
}
export async function publishTemplate(context: ModuleOperationContext, templateId: string) {
  const handler = (versioning.operationHandlers as Record<string, (input: Record<string, unknown>, context: ModuleOperationContext) => Promise<{ value: { id: string } }>>).publishTemplateToTemplateVersion!;
  return (await handler({ id: templateId }, context)).value.id;
}
export async function createDocument() {
  return asUser(editor, async (trx) =>
    (await sql<{ document_id: string }>`select document_id from document_internal.create_with_first_version(
      ${jsonbLiteral({ title: "Welcome letter", documentType: "outgoing_mail", status: "draft", isExternal: false })},
      ${jsonbLiteral({ versionLabel: "0", status: "draft", isMajorVersion: false })})`.execute(trx)).rows[0]!.document_id);
}
export async function revisionBlocks(revisionId: string) {
  return (await sql<{ id: string; origin: string; template_block_id: string | null; diverged: boolean; text: string; updated_at: string }>`select id, origin, template_block_id, diverged, "values"->>'text' as text, updated_at::text as updated_at
    from erp.blocks where revision_id = ${revisionId}::uuid order by revision_id_position, id`.execute(privileged())).rows;
}
export async function revision(id: string) {
  return (await sql<{ status: string; template_version_id: string | null; published_version_id: string | null; follow_error: string | null; updated_at: string }>`select status, template_version_id, published_version_id, follow_error, updated_at::text as updated_at from erp.document_revisions where id = ${id}::uuid`.execute(privileged())).rows[0]!;
}
export const fails = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ operationError: { code } });
export const startedRevision = async (handlers: Handlers, context: ModuleOperationContext, input: Record<string, unknown>) =>
  (await handlers.startRevision!(input, context)).value as { id: string; status: string; templateVersion: string | null; parameters: Record<string, unknown>; document: string };
