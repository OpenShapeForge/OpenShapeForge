// SPDX-License-Identifier: BUSL-1.1
/**
 * The REST sweep's transport helpers, shared by the CRUD sweep and the
 * reference-policy sweep: one request over the in-process app or E2E_API_URL,
 * envelope unwrapping, lease and confirmation handling, the create body
 * builder and row tracking.
 */
import { expect } from "bun:test";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { REST_MOUNT_PATH } from "../../generated-rest-routes.js";
import {
  apiApp,
  createdRows,
  remoteUrl,
  type Identity,
} from "../../../graphql/__tests__/e2e/harness.js";
import {
  eligibleTables,
  createRow,
  fieldName,
  foreignKeyTargets,
  isMutableColumn,
  nextMarker,
  pluginCreateInput,
  contractSample,
  tables,
  tablesByName,
} from "../../../graphql/__tests__/e2e/entity-factory.js";
import {
  acknowledgementRequired,
  challengeAnswerFor,
  isEntityBackedCreate,
  leaseRequired,
  operationIdFor,
  versionRequired,
} from "../../../graphql/__tests__/e2e/operations.js";

export const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;

export const restTables = tables.filter((table) => table.source?.rest);
export const restCreateTables = eligibleTables.filter(
  (table) => table.source?.rest?.operations.create,
);

export type RestResponse = { status: number; body: any };

export function recordPayload(response: RestResponse): any {
  return response.body.data;
}

export function listPayload(response: RestResponse): any {
  const data = response.body.data;
  return { ...data, items: data.items.map((item: any) => item.data) };
}

export async function rest(
  identity: Identity | null,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  options: { rawPayload?: string } = {},
): Promise<RestResponse> {
  const headers = new Headers();
  if (identity) {
    applyTrustedContextHeaders(headers, identity, { secret: SECRET });
  }
  const body =
    options.rawPayload ?? (payload === undefined ? undefined : JSON.stringify(payload));
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (remoteUrl) {
    const response = await fetch(`${remoteUrl}${url}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  const response = await (await apiApp()).inject({
    method,
    url,
    headers: Object.fromEntries(headers.entries()),
    ...(body === undefined ? {} : { payload: body }),
  });
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  };
}

/** The lease request itself, for tests that assert on its refusal. */
export function requestLease(
  table: (typeof restTables)[number],
  identity: Identity,
  id: string,
  intent: "update" | "delete",
): Promise<RestResponse> {
  return rest(identity, "POST", "/api/operation-leases", {
    operationId: operationIdFor(table, intent),
    targetId: id,
  });
}

/** Version + lease controls when the Operation demands them, `{}` otherwise. */
export async function acquireLease(
  table: (typeof restTables)[number],
  identity: Identity,
  id: string,
  intent: "update" | "delete",
): Promise<Record<string, string>> {
  if (!leaseRequired(table, intent)) {
    if (!versionRequired(table, intent)) return {};
    const base = `${REST_MOUNT_PATH}/${table.source!.rest!.basePath}`;
    const current = await rest(identity, "GET", `${base}/${id}`);
    expect(current.status).toBe(200);
    const expectedVersion = recordPayload(current)?.updatedAt;
    expect(expectedVersion).toBeString();
    return { expectedVersion };
  }
  const acquired = await requestLease(table, identity, id, intent);
  expect(acquired.status).toBe(201);
  return {
    expectedVersion: acquired.body.data.targetVersion,
    leaseToken: acquired.body.data.leaseToken,
  };
}

/**
 * Deletes through REST the way a client must: lease, then delete, then answer
 * the confirmation challenge if one is issued. Returns the final response.
 */
export async function restDelete(
  table: (typeof restTables)[number],
  identity: Identity,
  id: string,
): Promise<RestResponse> {
  const base = `${REST_MOUNT_PATH}/${table.source!.rest!.basePath}`;
  const lease = await acquireLease(table, identity, id, "delete");
  const first = await rest(identity, "DELETE", `${base}/${id}`, {
    ...lease,
    ...(acknowledgementRequired(table, "delete") ? { confirmed: true } : {}),
  });
  if (first.status !== 428) return first;
  expect(first.body.error.code).toBe("CONFIRMATION_REQUIRED");
  expect(first.body.error.retryAt).toBeUndefined();
  expect(first.body.error.data.confirmation.expiresAt).toBeString();
  const row = recordPayload(await rest(identity, "GET", `${base}/${id}`));
  return rest(identity, "DELETE", `${base}/${id}`, {
    ...lease,
    confirmationToken: first.body.error.data.confirmation.challengeToken,
    confirmationAnswer: challengeAnswerFor(table, "delete", row),
  });
}

/**
 * Builds a valid REST create body: sample values for required non-FK columns,
 * recursively created (GraphQL-tracked) rows for required foreign keys —
 * the same assembly rules as entity-factory's createRow. A plugin-backed
 * create takes its authored input contract instead.
 */
export async function buildCreateBody(
  table: (typeof restTables)[number],
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<Record<string, unknown>> {
  if (!isEntityBackedCreate(table)) return pluginCreateInput(table, identity, overrides, depth);
  return buildColumnBody(table, identity, overrides, depth);
}

export async function buildColumnBody(
  table: (typeof restTables)[number],
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<Record<string, unknown>> {
  if (depth > 5) throw new Error(`REST FK dependency chain too deep while creating ${table.name}`);
  const fkTargets = foreignKeyTargets(table);
  const body: Record<string, unknown> = { ...overrides };
  for (const column of table.columns) {
    if (!isMutableColumn(column)) continue;
    const field = fieldName(column);
    if (field in body) continue;
    const fkTarget = fkTargets.get(column.name);
    if (fkTarget) {
      if (column.required) {
        body[field] = await createForeignKeyTarget(fkTarget, identity, depth + 1);
      }
      continue;
    }
    if (column.required) {
      body[field] = contractSample(table, column, nextMarker());
    }
  }
  return body;
}

export async function createForeignKeyTarget(
  target: string,
  identity: Identity,
  depth = 0,
): Promise<string> {
  const fullCrudTarget = tablesByName.get(target);
  if (fullCrudTarget) return createRestRow(fullCrudTarget, identity, {}, depth);

  const restTarget = restCreateTables.find((table) => table.name === target);
  if (!restTarget) throw new Error(`REST FK target ${target} has no create operation`);
  return createRow(restTarget, identity, {}, depth + 1);
}

export function trackRestRow(table: (typeof restTables)[number], id: string, identity: Identity) {
  createdRows.push({ table, id, identity });
}

export async function createRestRow(
  table: (typeof restTables)[number],
  identity: Identity,
  overrides: Record<string, unknown> = {},
  depth = 0,
): Promise<string> {
  const response = await rest(
    identity,
    "POST",
    `${REST_MOUNT_PATH}/${table.source!.rest!.basePath}`,
    await buildCreateBody(table, identity, overrides, depth),
  );
  expect(response.status).toBe(201);
  const id = recordPayload(response).id as string;
  trackRestRow(table, id, identity);
  return id;
}
