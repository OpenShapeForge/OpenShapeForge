// SPDX-License-Identifier: BUSL-1.1
/**
 * Removal of a proven seed-owned Document graph, for registered maintenance
 * seeding only (modules/maintenance.ts), inside the transaction the caller
 * already holds.
 *
 * The canonical `Document.deleteWithContents` cannot serve this: it runs in
 * its own Operation transaction, it refuses a versioned Document that is not
 * `draft`, and the inbound DocumentVersion reference blocks it. Nothing here
 * relaxes a rule for an ordinary caller. The graph, its locks, its catalogue
 * proof and every generic guard are the canonical ones
 * (owned-delete-execution.ts); this module adds the seed proof on top and
 * removes the versions through the privileged routine that owns that
 * invariant (`document_internal.remove_seed_document_versions`).
 *
 * What the proof establishes, under the row locks the generic machinery
 * already took, before any effect:
 *
 *   - the discovered graph is EXACTLY the identity set the host plan named,
 *     per planned entity. An unexpected child, a missing one, a member of
 *     another tenant or another document refuses the whole removal;
 *   - every member carries the seeding contribution's registered
 *     `sourceAuthority`. A record a user created carries none;
 *   - no member, and no named version, was ever written by an actor other
 *     than the seeding contribution, as the audit history records it;
 *   - the named versions are the document's complete version set and retain
 *     no managed content, which the privileged routine re-establishes for
 *     itself under its own lock.
 *
 * Shared references, locked or retained content and extension references are
 * refused by the generic guards and the plan's own boundary queries, which
 * run here unchanged.
 */
import { operationFailure, type OwnedDeletePlan } from "@openshapeforge/operations";
import { sql, type Transaction } from "kysely";
import { postgresArrayLiteral } from "../db/sql-helpers.js";
import type { DbSessionInput } from "../db/session.js";
import type { DB } from "../generated/db/types.js";
import { getGeneratedCrudTables } from "./entity/catalog.js";
import { fieldNameForColumn } from "./entity/columns.js";
import { executeOwnedDeleteGraph, type OwnedDeleteProof } from "./owned-delete-execution.js";
// The compiled catalogue, not the Operation runtime: the runtime owns the
// maintenance entry point, so importing it here would close an import cycle.
import rawCatalog from "../generated/operations/catalog.json" with { type: "json" };
import type { OperationContract } from "./runtime.js";

/** The canonical owned delete whose compiled plan defines the owned graph. */
export const SEED_DOCUMENT_REMOVAL_OPERATION = "Document.deleteWithContents";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SeedOwnedDocumentRemoval = {
  /** The seed-owned Document identity the host plan names. */
  documentId: string;
  /** Every DocumentVersion identity the host plan expects to remove. */
  versionIds: readonly string[];
  /**
   * Every owned member identity the host plan expects to remove, by authoring
   * entity name, including the Document itself. The key set must cover the
   * compiled plan exactly, so a later owned child of Document fails this path
   * closed until the host plan names it.
   */
  ownedMembers: Readonly<Record<string, readonly string[]>>;
};

export type SeedOwnedDocumentRemovalResult = {
  documentId: string;
  /** Rows removed per authoring entity, with DocumentVersion counted apart. */
  removed: Readonly<Record<string, number>>;
};

export type SeedOwnedDocumentRemovalRequest = {
  /** The tenant of the maintenance invocation; never caller input. */
  tenantId: string;
  /** The seeding contribution's registered source authority. */
  sourceAuthority: string;
  removal: SeedOwnedDocumentRemoval;
};

function refuseSeed(reason: string): never {
  throw operationFailure({
    code: "OPERATION_REFUSED",
    message: `This seed-owned document cannot be removed: ${reason}.`,
    retryable: false,
  });
}

function invalid(reason: string): never {
  throw operationFailure({ code: "VALIDATION", message: `Seed document removal ${reason}.`, retryable: false });
}

function identitySet(values: readonly string[], label: string): ReadonlySet<string> {
  const set = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !UUID.test(value)) invalid(`needs UUID ${label} identities`);
    if (set.has(value)) invalid(`cannot repeat a ${label} identity`);
    set.add(value);
  }
  return set;
}

function sameSet(left: ReadonlySet<string>, right: readonly string[]): boolean {
  return left.size === right.length && right.every(id => left.has(id));
}

/** The compiled owned graph of a Document, as the canonical Operation uses it. */
export function seedDocumentRemovalPlan(): OwnedDeletePlan {
  const operations = (rawCatalog as unknown as { operations: OperationContract[] }).operations;
  const operation = operations.find(candidate => candidate.key === SEED_DOCUMENT_REMOVAL_OPERATION);
  const binding = operation?.implementation;
  if (binding?.type !== "ownedDelete" || binding.plan.root !== "Document") {
    throw new Error(`Seed document removal needs the canonical ${SEED_DOCUMENT_REMOVAL_OPERATION} owned delete.`);
  }
  return binding.plan;
}

/** Where each planned entity records the authority that owns its rows. */
function authorityColumns(plan: OwnedDeletePlan): ReadonlyMap<string, string> {
  const tables = getGeneratedCrudTables();
  const columns = new Map<string, string>();
  for (const step of plan.discover) {
    const table = tables.find(candidate => candidate.source?.authoringEntityName === step.entity && !candidate.subtype);
    const column = table?.columns.find(candidate => fieldNameForColumn(candidate) === "sourceAuthority");
    if (!column) {
      throw operationFailure({
        code: "INVALID_DEFINITION",
        message: "The database cannot prove seed ownership of this document graph.",
      });
    }
    columns.set(step.entity, column.name);
  }
  return columns;
}

export async function removeSeedOwnedDocument(
  trx: Transaction<DB>,
  session: DbSessionInput,
  request: SeedOwnedDocumentRemovalRequest,
): Promise<SeedOwnedDocumentRemovalResult> {
  const { tenantId, sourceAuthority, removal } = request;
  const actor = session.userId;
  if (!UUID.test(tenantId) || session.tenantId !== tenantId || !actor) {
    invalid("requires the maintenance tenant session");
  }
  if (typeof sourceAuthority !== "string" || sourceAuthority.length === 0) {
    invalid("requires the contribution's registered source authority");
  }
  if (typeof removal?.documentId !== "string" || !UUID.test(removal.documentId)) {
    invalid("needs a UUID document identity");
  }
  const plan = seedDocumentRemovalPlan();
  const authority = authorityColumns(plan);
  const versionIds = identitySet(removal.versionIds ?? [], "DocumentVersion");
  const ownedMembers: Readonly<Record<string, readonly string[]>> = removal.ownedMembers ?? {};
  const expected = new Map<string, ReadonlySet<string>>();
  if (Object.keys(ownedMembers).length !== plan.discover.length ||
      !plan.discover.every(step => Object.hasOwn(ownedMembers, step.entity))) {
    invalid("must name every owned member entity of the compiled plan exactly once");
  }
  for (const step of plan.discover) {
    expected.set(step.entity, identitySet(ownedMembers[step.entity] ?? [], step.entity));
  }
  const roots = expected.get(plan.root)!;
  if (roots.size !== 1 || !roots.has(removal.documentId)) {
    invalid("must name the document itself as the only root member");
  }

  let removedVersions = 0;
  const prove = async ({ trx: proofTrx, tenant, members, rows }: OwnedDeleteProof) => {
    for (const step of plan.discover) {
      if (!sameSet(expected.get(step.entity)!, members.get(step.entity) ?? [])) {
        refuseSeed("its graph differs from the seed plan");
      }
    }
    const audited = [...versionIds];
    for (const step of plan.discover) {
      const column = authority.get(step.entity)!;
      for (const id of members.get(step.entity) ?? []) {
        const row = rows.get(step.entity)?.get(id);
        if (!row || row[column] !== sourceAuthority) refuseSeed("a member is not owned by this seed");
        audited.push(id);
      }
    }
    // The audit history is what distinguishes a seed-owned record a user has
    // since edited from one no other actor ever touched. A member whose
    // history names any other actor stays.
    const touched = await sql<{ present: boolean }>`select exists (
      select 1 from platform.entity_events
      where tenant_id = ${tenant}::uuid
        and aggregate_id = any(${postgresArrayLiteral(audited)}::text[])
        and coalesce(payload->'audit'->>'actorId', '') <> ${actor}
    ) as present`.execute(proofTrx);
    if (touched.rows[0]?.present !== false) refuseSeed("a member was changed outside this seed");

    const outcome = await sql<{ removed: number }>`select document_internal.remove_seed_document_versions(
      ${removal.documentId}::uuid, ${postgresArrayLiteral([...versionIds])}::uuid[], ${sourceAuthority}
    ) as removed`.execute(proofTrx);
    removedVersions = Number(outcome.rows[0]?.removed ?? -1);
    if (removedVersions !== versionIds.size) refuseSeed("its versions could not be removed as planned");
  };

  const counts = await executeOwnedDeleteGraph(trx, session, plan, tenantId, removal.documentId, {
    operationKey: SEED_DOCUMENT_REMOVAL_OPERATION, lifecycle: "proven", prove,
  });
  return {
    documentId: removal.documentId,
    removed: Object.freeze({ ...counts, DocumentVersion: removedVersions }),
  };
}
