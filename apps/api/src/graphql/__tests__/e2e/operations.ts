// SPDX-License-Identifier: BUSL-1.1
/**
 * Canonical-Operations awareness for the e2e suites.
 *
 * A current (`authoringVersion >= 2`) entity is driven through its authored
 * Operation contracts: an update or delete may demand a record version and an
 * edit lease, a delete may demand a typed confirmation challenge, and a create
 * may be plugin-backed with an input contract of its own. The suites derive
 * every one of those facts from the same contract catalog the runtime reads,
 * so an entity conversion that adds a lease or a challenge is covered the
 * moment it lands rather than when someone remembers to update a test.
 *
 * Leases are acquired over REST (`/api/operation-leases`): the central lease
 * service has no GraphQL projection, so the GraphQL suites reach it the way a
 * web client would — through the harness's in-process API app, or the
 * deployed one in remote runs.
 */
import { expect } from "bun:test";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import {
  entityOperationContract,
  entityOperationRef,
  isGeneratedCrudOperationEnabled,
} from "../../generated-crud.js";
import type { EntityOperationContract } from "../../../operations/entity/types.js";
import { OPERATION_LEASES_PATH } from "../../../rest/edit-lease-routes.js";
import { REST_MOUNT_PATH } from "../../../rest/rest-paths.js";
import { apiApp, remoteUrl, type GeneratedTable, type Identity } from "./harness.js";

export type Intent = "list" | "get" | "create" | "update" | "delete";
export type MutationIntent = "update" | "delete";

/** Transport controls a canonical mutation may have to carry. */
export type MutationControls = {
  expectedVersion?: string;
  leaseToken?: string;
  confirmed?: boolean;
  confirmationToken?: string;
  confirmationAnswer?: string;
};

/** Authored as canonical Operations (v2 and later). */
export function isCanonical(table: GeneratedTable): boolean {
  return (table.source?.authoringVersion ?? 1) >= 2;
}

/**
 * The authored Operation behind one CRUD intent, or undefined when the table
 * is v1 or does not expose the intent. Read from the runtime's own catalog so
 * the suite and the API can never disagree about what a mutation requires.
 */
export function operationContractFor(
  table: GeneratedTable,
  intent: Intent,
): EntityOperationContract | undefined {
  if (!isCanonical(table) || !isGeneratedCrudOperationEnabled(table, intent)) return undefined;
  return entityOperationContract(entityOperationRef(table, intent).id);
}

/** `Entity.intent`, the id every transport's lease service keys on. */
export function operationIdFor(table: GeneratedTable, intent: Intent): string {
  return `${table.source!.authoringEntityName}.${intent}`;
}

/**
 * Whether `create` accepts the entity's own columns. A plugin-backed create
 * (`implementation.type === "plugin"`) has an authored input contract of its
 * own — nested objects, idempotency keys, artifact handles — that the column
 * manifest cannot describe, so the manifest-driven create sweeps do not apply
 * to it and fixture rows for such a table are inserted through the engine.
 */
export function isEntityBackedCreate(table: GeneratedTable): boolean {
  const contract = operationContractFor(table, "create");
  return contract === undefined || contract.implementation?.type !== "plugin";
}

/**
 * Whether a plugin-backed create also creates records of other entities —
 * a document with its first version, say. The contract says so: such a
 * create promises, in its required output, a reference to a record that did
 * not exist before the call (`currentVersionId`). The entity delete then
 * refuses while those companions exist, and removing them is the plugin's
 * contract, not the generic delete's. A plugin create that only computes
 * its own columns (a milestone's frozen amount) deletes like any record.
 */
export function createsCompanionRecords(table: GeneratedTable): boolean {
  const contract = operationContractFor(table, "create");
  if (contract?.implementation?.type !== "plugin") return false;
  const required = (contract.output as { schema?: { required?: string[] } } | undefined)?.schema?.required ?? [];
  const references = new Set(
    (table.source?.graphql?.relationships ?? [])
      .filter((relationship) => relationship.resolve === "belongsTo" && relationship.fieldKey)
      .map((relationship) => relationship.fieldKey!),
  );
  return required.some((field) => references.has(field));
}

/** Whether the create's contract lets the caller supply `field` at the top level. */
export function createOffersField(table: GeneratedTable, field: string): boolean {
  if (isEntityBackedCreate(table)) return true;
  const contract = operationContractFor(table, "create");
  const schema = (contract?.input as { schema?: { properties?: Record<string, unknown> } } | undefined)?.schema;
  return field in (schema?.properties ?? {});
}

export function versionRequired(table: GeneratedTable, intent: MutationIntent): boolean {
  return operationContractFor(table, intent)?.concurrency?.version !== undefined;
}

export function leaseRequired(table: GeneratedTable, intent: MutationIntent): boolean {
  return operationContractFor(table, intent)?.concurrency?.editLease !== undefined;
}

export function acknowledgementRequired(
  table: GeneratedTable,
  intent: MutationIntent,
): boolean {
  return operationContractFor(table, intent)?.interaction.confirmation.mode === "acknowledgement";
}

/** The field a `type-current-field` challenge asks the caller to retype, if any. */
export function challengeFieldFor(
  table: GeneratedTable,
  intent: MutationIntent,
): string | undefined {
  const confirmation = operationContractFor(table, intent)?.interaction.confirmation;
  return confirmation?.mode === "challenge" ? confirmation.challenge.field : undefined;
}

/**
 * The answer a challenge expects: the current value of the challenge field,
 * compared as text (the server hashes `to_jsonb(column)::text`). `row` is the
 * camelCase record as any transport serves it.
 */
export function challengeAnswerFor(
  table: GeneratedTable,
  intent: MutationIntent,
  row: Record<string, unknown>,
): string {
  const field = challengeFieldFor(table, intent);
  if (!field) {
    throw new Error(`${operationIdFor(table, intent)} declares no confirmation challenge.`);
  }
  const value = row[field];
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `${operationIdFor(table, intent)} challenge field ${field} is empty on the record.`,
    );
  }
  if (typeof value === "object" && !Array.isArray(value) && "id" in value) {
    return String((value as { id: unknown }).id);
  }
  return String(value);
}

/**
 * Syntactically valid controls for a request that must be refused BEFORE the
 * controls are examined (authorization precedes lease and version checks in
 * the dispatcher). The canonical SDL marks them non-null, so a denial test
 * cannot simply omit them the way a v1 test omits nothing.
 */
export function placeholderControls(
  table: GeneratedTable,
  intent: MutationIntent,
): MutationControls {
  return {
    ...(versionRequired(table, intent)
      ? { expectedVersion: "2026-01-01T00:00:00.000Z" }
      : {}),
    ...(leaseRequired(table, intent) ? { leaseToken: "e2e-placeholder-lease" } : {}),
    ...(acknowledgementRequired(table, intent) ? { confirmed: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// REST transport for the lease service
// ---------------------------------------------------------------------------

type RestResponse = { status: number; body: any };

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;

/**
 * One JSON request against the REST surface, authenticated the way `gql` is:
 * a bearer token when given, otherwise trusted-context headers for `identity`.
 */
export async function restJson(
  identity: Identity | null,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  payload?: unknown,
  options: { bearer?: string } = {},
): Promise<RestResponse> {
  const headers = new Headers();
  if (options.bearer) {
    headers.set("authorization", `Bearer ${options.bearer}`);
  } else if (identity) {
    applyTrustedContextHeaders(headers, identity, { secret: SECRET });
  }
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  if (body !== undefined) headers.set("content-type", "application/json");

  if (remoteUrl) {
    const response = await fetch(`${remoteUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }
  const response = await (await apiApp()).inject({
    method,
    url: path,
    headers: Object.fromEntries(headers.entries()),
    ...(body === undefined ? {} : { payload: body }),
  });
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  };
}

/** Raw lease request — for tests that assert on the refusal itself. */
export function requestLease(
  identity: Identity | null,
  table: GeneratedTable,
  id: string,
  intent: MutationIntent,
  options: { bearer?: string } = {},
): Promise<RestResponse> {
  return restJson(
    identity,
    "POST",
    OPERATION_LEASES_PATH,
    { operationId: operationIdFor(table, intent), targetId: id },
    options,
  );
}

/**
 * The version + lease controls `intent` needs on `id`, acquired for the
 * caller; `{}` when the Operation declares no concurrency. A refusal is a
 * test failure at the call site, not a silently empty control set.
 */
export async function acquireLease(
  identity: Identity | null,
  table: GeneratedTable,
  id: string,
  intent: MutationIntent,
  options: { bearer?: string } = {},
): Promise<MutationControls> {
  if (!leaseRequired(table, intent)) {
    if (!versionRequired(table, intent)) return {};
    const basePath = table.source?.rest?.basePath;
    if (!basePath) {
      throw new Error(
        `${operationIdFor(table, intent)} requires a version, but the test fixture has no REST read projection.`,
      );
    }
    const current = await restJson(
      identity,
      "GET",
      `${REST_MOUNT_PATH}/${basePath}/${id}`,
      undefined,
      options,
    );
    const expectedVersion = current.body?.data?.updatedAt ?? current.body?.updatedAt;
    if (current.status !== 200 || typeof expectedVersion !== "string") {
      throw new Error(
        `Version for ${operationIdFor(table, intent)} on ${id} was unavailable: ` +
          `${current.status} ${JSON.stringify(current.body?.error ?? current.body)}`,
      );
    }
    return { expectedVersion };
  }
  const acquired = await requestLease(identity, table, id, intent, options);
  if (acquired.status !== 201) {
    throw new Error(
      `Lease for ${operationIdFor(table, intent)} on ${id} was refused: ` +
        `${acquired.status} ${JSON.stringify(acquired.body?.error ?? acquired.body)}`,
    );
  }
  return {
    expectedVersion: acquired.body.data.targetVersion as string,
    leaseToken: acquired.body.data.leaseToken as string,
  };
}

export async function releaseLease(
  identity: Identity | null,
  leaseToken: string,
  options: { bearer?: string } = {},
): Promise<void> {
  const released = await restJson(
    identity,
    "POST",
    `${OPERATION_LEASES_PATH}/release`,
    { leaseToken },
    options,
  );
  expect(released.status).toBe(200);
}
