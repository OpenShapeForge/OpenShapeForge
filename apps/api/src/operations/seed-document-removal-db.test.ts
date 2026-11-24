// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Transaction } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime, type OpenShapeForgeDatabase } from "../db/connection.js";
import { runMigrationChain } from "../db/migration-chain.js";
import { SYSTEM_BYPASS_ROLE, withSystemSession, type DbSessionInput } from "../db/session.js";
import { jsonbLiteral } from "../db/sql-helpers.js";
import type { DB } from "../generated/db/types.js";
import type { RuntimeModule } from "../modules/contract.js";
import { runRegisteredSeedJob } from "../modules/maintenance.js";
import { ModulePlatformRuntime } from "../modules/platform.js";
import {
  removeSeedOwnedDocument,
  type SeedOwnedDocumentRemoval,
  type SeedOwnedDocumentRemovalResult,
} from "../db/maintenance/remove-seed-documents.js";

const AUTHORITY = "openshapeforge:test:seed-fixtures";

type Graph = {
  document: string;
  version: string;
  variant: string;
  block: string;
  removal: SeedOwnedDocumentRemoval;
};

test("seed-owned document removal proves the graph, shares the caller transaction and fails closed", async () => {
  const adminUrl = process.env.SCRATCH_ADMIN_DATABASE_URL ?? "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
  const url = new URL(adminUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/postgres") {
    throw Error("A scratch admin endpoint is required.");
  }
  const name = `seed_document_removal_${randomUUID().replaceAll("-", "")}`;
  const admin = new SQL(adminUrl, { max: 1 });
  let privileged: DatabaseRuntime | undefined, restricted: DatabaseRuntime | undefined;
  try {
    await admin.unsafe(`create database "${name}"`);
    url.pathname = `/${name}`;
    privileged = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 1 });
    await privileged.db.connection().execute(runMigrationChain);
    url.username = "openshapeforge_app";
    url.password = "openshapeforge_app";
    restricted = createDatabaseRuntime({ databaseUrl: url.toString(), maxConnections: 2 });

    const tenant = randomUUID(), foreignTenant = randomUUID(), seedActor = randomUUID();
    const db = privileged.db;
    for (const id of [tenant, foreignTenant]) {
      await sql`insert into platform.tenants(id,slug,name,status) values(${id}::uuid,${'fixture-' + id},'Seed removal fixture','active')`.execute(db);
      await sql`insert into erp.tenants(id,tenant_id,slug,name,tenant_kind) values(${id}::uuid,${id}::uuid,${'fixture-' + id},'Seed removal fixture','customer')`.execute(db);
      await sql`insert into erp.document_types(tenant_id,code,name) values(${id}::uuid,'note','Note')`.execute(db);
    }

    /** Fixture writes are attributed to the seed, as a real seed run is. */
    const asSeed = <T>(target: OpenShapeForgeDatabase, work: (trx: Transaction<DB>) => Promise<T>) =>
      withSystemSession(target, {
        actorSubject: seedActor, databaseActorId: seedActor, roles: [SYSTEM_BYPASS_ROLE],
        reason: "Seed removal fixture", tenantId: tenant,
      }, work);

    /** A published, versioned seed-owned document with one variant and block. */
    const seedGraph = async (): Promise<Graph> => {
      const document = randomUUID(), version = randomUUID(), variant = randomUUID(), block = randomUUID();
      await asSeed(db, async (trx) => {
        await sql`insert into erp.documents(id,tenant_id,title,document_type,status,lifecycle_status,source_authority)
          values(${document}::uuid,${tenant}::uuid,'Seed fixture','note','draft','published',${AUTHORITY})`.execute(trx);
        await sql`insert into erp.document_versions(id,tenant_id,document_id,version_label,status,is_major_version,version_number,source_authority)
          values(${version}::uuid,${tenant}::uuid,${document}::uuid,'1.0','published',true,1,${AUTHORITY})`.execute(trx);
        await sql`update erp.documents set current_version_id = ${version}::uuid
          where id = ${document}::uuid and tenant_id = ${tenant}::uuid`.execute(trx);
        await sql`insert into erp.document_variants(id,tenant_id,document_id,channel,locale,source_authority)
          values(${variant}::uuid,${tenant}::uuid,${document}::uuid,'document','nl',${AUTHORITY})`.execute(trx);
        await sql`insert into erp.blocks(id,tenant_id,document_variant_id,document_variant_id_position,definition_key,definition_version,values,source_authority)
          values(${block}::uuid,${tenant}::uuid,${variant}::uuid,0,'TextBlock',1,${jsonbLiteral({ markdown: "Seeded content" })},${AUTHORITY})`.execute(trx);
      });
      return {
        document, version, variant, block,
        removal: {
          documentId: document,
          versionIds: [version],
          ownedMembers: { Document: [document], DocumentVariant: [variant], Block: [block] },
        },
      };
    };

    const counts = async (graph: Graph) => (await sql<{
      documents: string; versions: string; variants: string; blocks: string;
    }>`select (select count(*) from erp.documents where id = ${graph.document}::uuid)::text as documents,
               (select count(*) from erp.document_versions where document_id = ${graph.document}::uuid)::text as versions,
               (select count(*) from erp.document_variants where document_id = ${graph.document}::uuid)::text as variants,
               (select count(*) from erp.blocks where document_variant_id = ${graph.variant}::uuid)::text as blocks`
      .execute(db)).rows[0]!;
    const intact = { documents: "1", versions: "1", variants: "1", blocks: "1" };

    const session = (tenantId: string): DbSessionInput => ({
      tenantId, userId: seedActor, scope: "tenant",
      roles: ["CaseFile.All.ReadWrite", "Organization.All.ReadWrite"],
      groups: [], relationGroupIds: [],
    });
    /** Runs the capability exactly as the maintenance store transaction does. */
    const remove = <T = SeedOwnedDocumentRemovalResult>(
      tenantId: string,
      removal: SeedOwnedDocumentRemoval,
      after?: (trx: Transaction<DB>, result: SeedOwnedDocumentRemovalResult) => Promise<T>,
    ): Promise<T> => withSystemSession(restricted!.db, {
      actorSubject: seedActor, databaseActorId: seedActor, roles: [SYSTEM_BYPASS_ROLE],
      reason: "Seed removal", tenantId,
    }, async (trx) => {
      const result = await removeSeedOwnedDocument(trx, session(tenantId), {
        tenantId, sourceAuthority: AUTHORITY, removal,
      });
      return after ? after(trx, result) : (result as unknown as T);
    });

    // The canonical owned delete alone cannot reach this document: its root is
    // published and an inbound DocumentVersion references it.
    const first = await seedGraph();
    const state = await sql<{ lifecycle_status: string; versions: string }>`
      select d.lifecycle_status, (select count(*) from erp.document_versions v
        where v.tenant_id = d.tenant_id and v.document_id = d.id)::text as versions
      from erp.documents d where d.id = ${first.document}::uuid`.execute(db);
    expect(state.rows[0]).toEqual({ lifecycle_status: "published", versions: "1" });

    // Parent and children are removed, and roll back with the caller.
    await expect(remove(tenant, first.removal, async (trx) => {
      const inside = await sql<{ documents: string; versions: string; blocks: string }>`
        select (select count(*) from erp.documents where id = ${first.document}::uuid)::text as documents,
               (select count(*) from erp.document_versions where document_id = ${first.document}::uuid)::text as versions,
               (select count(*) from erp.blocks where document_variant_id = ${first.variant}::uuid)::text as blocks`
        .execute(trx);
      expect(inside.rows[0]).toEqual({ documents: "0", versions: "0", blocks: "0" });
      throw new Error("ROLLBACK THE CALLER TRANSACTION");
    })).rejects.toThrow("ROLLBACK THE CALLER TRANSACTION");
    expect(await counts(first)).toEqual(intact);

    // Another tenant never sees the document, however exact the identities.
    await expect(remove(foreignTenant, first.removal)).rejects.toThrow(/cannot be deleted/);
    // A session that is not the maintenance tenant's is refused outright.
    await expect(withSystemSession(restricted.db, {
      actorSubject: seedActor, databaseActorId: seedActor, roles: [SYSTEM_BYPASS_ROLE],
      reason: "Seed removal", tenantId: tenant,
    }, (trx) => removeSeedOwnedDocument(trx, session(foreignTenant), {
      tenantId: tenant, sourceAuthority: AUTHORITY, removal: first.removal,
    }))).rejects.toThrow(/maintenance tenant session/);
    expect(await counts(first)).toEqual(intact);

    // An owned child the host plan does not name.
    const unexpectedChild = await seedGraph();
    await asSeed(db, async (trx) => {
      await sql`insert into erp.blocks(id,tenant_id,document_variant_id,document_variant_id_position,definition_key,definition_version,values,source_authority)
        values(${randomUUID()}::uuid,${tenant}::uuid,${unexpectedChild.variant}::uuid,1,'TextBlock',1,${jsonbLiteral({ markdown: "Extra" })},${AUTHORITY})`.execute(trx);
    });
    await expect(remove(tenant, unexpectedChild.removal)).rejects.toThrow(/differs from the seed plan/);

    // A version the host plan does not name: the privileged routine refuses.
    const unexpectedVersion = await seedGraph();
    await asSeed(db, async (trx) => {
      await sql`insert into erp.document_versions(id,tenant_id,document_id,version_label,status,is_major_version,version_number,source_authority)
        values(${randomUUID()}::uuid,${tenant}::uuid,${unexpectedVersion.document}::uuid,'1.1','published',false,2,${AUTHORITY})`.execute(trx);
    });
    await expect(remove(tenant, unexpectedVersion.removal)).rejects.toThrow(/do not match the seed plan/);
    expect(await counts(unexpectedVersion)).toEqual({ ...intact, versions: "2" });

    const adoptedVersion = await seedGraph();
    await asSeed(db, async (trx) => {
      await sql`update erp.document_versions set source_authority = null
        where id = ${adoptedVersion.version}::uuid`.execute(trx);
    });
    await expect(remove(tenant, adoptedVersion.removal)).rejects.toThrow(/version is not owned by this seed/);
    expect(await counts(adoptedVersion)).toEqual(intact);

    // A child a user owns rather than the seed.
    const userOwned = await seedGraph();
    await asSeed(db, async (trx) => {
      await sql`update erp.blocks set source_authority = null where id = ${userOwned.block}::uuid`.execute(trx);
    });
    await expect(remove(tenant, userOwned.removal)).rejects.toThrow(/not owned by this seed/);
    expect(await counts(userOwned)).toEqual(intact);

    // A child another actor has since changed.
    const edited = await seedGraph();
    const editor = randomUUID();
    await withSystemSession(db, {
      actorSubject: editor, databaseActorId: editor, roles: [SYSTEM_BYPASS_ROLE],
      reason: "User edit", tenantId: tenant,
    }, async (trx) => {
      await sql`update erp.blocks set values = ${jsonbLiteral({ markdown: "Edited" })}
        where id = ${edited.block}::uuid`.execute(trx);
    });
    await expect(remove(tenant, edited.removal)).rejects.toThrow(/changed outside this seed/);
    expect(await counts(edited)).toEqual(intact);

    // The existing document guards still hold: a locked block stays.
    const locked = await seedGraph();
    await db.transaction().execute(async (trx) => {
      await sql`select set_config('app.document_command', 'follow', true)`.execute(trx);
      await sql`update erp.blocks set locked = true where id = ${locked.block}::uuid`.execute(trx);
    });
    await expect(remove(tenant, locked.removal)).rejects.toThrow(/cannot be deleted/);
    expect(await counts(locked)).toEqual(intact);

    // A version that retains managed binary content stays.
    const retained = await seedGraph();
    await asSeed(db, async (trx) => {
      await sql`update erp.document_versions
        set file_name = 'seed.pdf', mime_type = 'application/pdf', checksum = ${"a".repeat(64)},
          storage_location = 'seed.pdf'
        where id = ${retained.version}::uuid`.execute(trx);
    });
    await expect(remove(tenant, retained.removal)).rejects.toThrow(/retains managed content/);
    expect(await counts(retained)).toEqual(intact);

    const registered = await seedGraph();
    const published = await seedGraph();
    const received = await seedGraph();
    await asSeed(db, async (trx) => {
      await sql`update erp.documents set registered_at = now()
        where id = ${registered.document}::uuid`.execute(trx);
      await sql`update erp.documents set published_at = now()
        where id = ${published.document}::uuid`.execute(trx);
      await sql`update erp.documents set received_at = now()
        where id = ${received.document}::uuid`.execute(trx);
      await sql`update erp.documents set registered_at = now()
        where id = ${retained.document}::uuid`.execute(trx);
    });
    await expect(remove(tenant, received.removal)).rejects.toThrow(/retention/i);
    expect(await counts(received)).toEqual(intact);

    // The privileged routine is unreachable outside a maintenance session.
    await expect(restricted.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenant}, true), set_config('app.user_id', ${seedActor}, true)`.execute(trx);
      await sql`select document_internal.remove_seed_document_versions(
        ${first.document}::uuid, array[${first.version}]::uuid[], ${AUTHORITY}) as removed`.execute(trx);
    })).rejects.toThrow(/requires a maintenance session/);

    // Exercise the real maintenance port of a disposable tenant with a
    // ledger. It pairs the protected document deletion with the host's own
    // ledger update, using the same transaction identity for both.
    const fixture = await seedGraph();
    await sql`create table platform.seed_document_removal_fixture_ledger (
      tenant_id uuid not null, document_id uuid not null, primary key (tenant_id, document_id)
    )`.execute(db);
    await sql`grant select, delete on platform.seed_document_removal_fixture_ledger to openshapeforge_app`.execute(db);
    await sql`insert into platform.seed_document_removal_fixture_ledger values
      (${tenant}::uuid, ${fixture.document}::uuid), (${tenant}::uuid, ${registered.document}::uuid),
      (${tenant}::uuid, ${published.document}::uuid), (${tenant}::uuid, ${retained.document}::uuid)`.execute(db);
    const contribution = {
      name: "seed-document-removal-proof",
      actorId: seedActor,
      operations: ["Document.deleteWithContents"],
      actingRelation: { sourceAuthority: AUTHORITY },
      storeConnection: "application" as const,
    };
    const owner: RuntimeModule = {
      name: "seed-removal-proof",
      maintenance: [contribution],
      seeds: [{ name: "seed-removal-proof", maintenanceOptIn: () => true,
        apply: async () => ({ present: true, skipped: false, rows: 0 }) }],
    };
    const platform = new ModulePlatformRuntime(restricted.db);
    const previousDatabase = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();
    const runRemoval = (graph: Graph, rollback = false) => runRegisteredSeedJob(
      owner, db, owner.name, "synthetic seed removal proof",
      runner => runner({ contribution: contribution.name, tenantSlug: "fixture-" + tenant, reason: "remove fixture seed" },
        context => context.store.transaction(async tx => {
          const pending = await tx.query(
            "select document_id from platform.seed_document_removal_fixture_ledger where tenant_id=$1 and document_id=$2",
            [tenant, graph.document],
          );
          if (pending.length === 0) return 0;
          if (!context.documents) throw new Error("Missing registered seed document capability");
          await context.documents.removeSeedOwned(tx, graph.removal);
          await tx.query("delete from platform.seed_document_removal_fixture_ledger where tenant_id=$1 and document_id=$2",
            [tenant, graph.document]);
          if (rollback) throw new Error("fixture removal rollback");
          return 1;
        })),
      { platform: platform.services, modules: [owner] },
    );
    try {
      await expect(runRemoval(fixture, true)).rejects.toThrow("fixture removal rollback");
      expect(await counts(fixture)).toEqual(intact);
      expect(await runRemoval(fixture)).toBe(1);
      expect(await counts(fixture)).toEqual({ documents: "0", versions: "0", variants: "0", blocks: "0" });
      expect(await runRemoval(fixture)).toBe(0);
      for (const graph of [registered, published]) {
        expect(await runRemoval(graph)).toBe(1);
        expect(await counts(graph)).toEqual({ documents: "0", versions: "0", variants: "0", blocks: "0" });
      }
      await expect(runRemoval(retained)).rejects.toThrow(/retains managed content/);
      expect(await counts(retained)).toEqual(intact);
      const remaining = await sql<{ document_id: string }>`select document_id from platform.seed_document_removal_fixture_ledger`.execute(db);
      expect(remaining.rows.map(row => row.document_id)).toEqual([retained.document]);
    } finally {
      if (previousDatabase === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabase;
    }

    // The committed removal.
    const result = await remove(tenant, first.removal);
    expect(result.documentId).toBe(first.document);
    expect(result.removed).toEqual({ Document: 1, DocumentVariant: 1, Block: 1, DocumentVersion: 1 });
    expect(await counts(first)).toEqual({ documents: "0", versions: "0", variants: "0", blocks: "0" });
  } finally {
    await restricted?.close();
    await privileged?.close();
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.close();
  }
}, 180_000);
