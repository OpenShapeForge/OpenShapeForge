// SPDX-License-Identifier: BUSL-1.1
/**
 * A database rule that refuses a write reaches REST and GraphQL as a readable
 * 4xx carrying the rule's own message and hint — not INTERNAL_SERVER_ERROR.
 * (The MCP envelope renders the same body through toHttpError; that rendering
 * is pinned by tool-failure-envelope.unit.test.ts.)
 *
 * Installs a BEFORE INSERT trigger on one generated table of the scratch
 * database for the duration of the suite. The trigger refuses any row whose
 * values contain a marker unique to this run, so it cannot interfere with
 * rows other suites write, and drops itself in afterAll.
 */
import { afterAll, beforeAll, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { applyTrustedContextHeaders } from "@openshapeforge/auth";
import { createApiApp } from "../../roles/api.js";
import { REST_MOUNT_PATH } from "../generated-rest-routes.js";
import {
  describe,
  getRuntime,
  gql,
  registerSuiteLifecycle,
  remoteUrl,
  seed,
  tenantA,
  test,
  type Identity,
} from "../../graphql/__tests__/e2e/harness.js";
import {
  createRow,
  fieldName,
  foreignKeyTargets,
  isMutableColumn,
  sampleValue,
  tables,
  tablesByName,
  textColumnFor,
} from "../../graphql/__tests__/e2e/entity-factory.js";

registerSuiteLifecycle();

const SECRET = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET ?? null;

/** Tables REST and GraphQL expose for create, with a text column to plant the marker in. */
const candidates = tables.filter(
  (candidate) =>
    candidate.source?.rest?.operations.create &&
    candidate.source?.graphql &&
    textColumnFor(candidate) !== undefined,
);
/** Chosen in beforeAll: the first candidate whose relation exists in this database. */
let table: (typeof tables)[number] | undefined;
let markerColumn: ReturnType<typeof textColumnFor>;

async function relationExists(schema: string, name: string): Promise<boolean> {
  const result = await sql<{ present: boolean }>`
    SELECT to_regclass(${`${schema}.${name}`}) IS NOT NULL AS present
  `.execute(getRuntime().db);
  return result.rows[0]?.present === true;
}
const MARKER = `refuse-${seed}-${randomUUID().slice(0, 8)}`;
const RULE_MESSAGE = "Titles that carry the refusal marker are not accepted by this deployment.";
const RULE_HINT = "Remove the marker and submit again.";
const RULE_DETAIL = "Refused by the e2e refusal trigger.";
const FUNCTION_NAME = `e2e_refuse_${seed.replace(/[^a-z0-9]/gi, "_")}`;

let app: ReturnType<typeof createApiApp> | null = null;
function getApp() {
  app ??= createApiApp(
    process.env.DATABASE_URL
      ? { cors: false, databaseUrl: process.env.DATABASE_URL }
      : { cors: false },
  );
  return app;
}

beforeAll(async () => {
  for (const candidate of candidates) {
    if (await relationExists(candidate.schema, candidate.table)) {
      table = candidate;
      markerColumn = textColumnFor(candidate);
      break;
    }
  }
  if (!table) return;
  const db = getRuntime().db;
  await sql
    .raw(
      `CREATE OR REPLACE FUNCTION public.${FUNCTION_NAME}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF to_jsonb(NEW)::text LIKE '%${MARKER}%' THEN
           RAISE EXCEPTION '${RULE_MESSAGE}' USING HINT = '${RULE_HINT}', DETAIL = '${RULE_DETAIL}';
         END IF;
         RETURN NEW;
       END $$;
       DROP TRIGGER IF EXISTS ${FUNCTION_NAME} ON ${table.schema}.${table.table};
       CREATE TRIGGER ${FUNCTION_NAME} BEFORE INSERT ON ${table.schema}.${table.table}
         FOR EACH ROW EXECUTE FUNCTION public.${FUNCTION_NAME}();`,
    )
    .execute(db);
});

afterAll(async () => {
  if (table) {
    await sql
      .raw(
        `DROP TRIGGER IF EXISTS ${FUNCTION_NAME} ON ${table.schema}.${table.table};
         DROP FUNCTION IF EXISTS public.${FUNCTION_NAME}();`,
      )
      .execute(getRuntime().db);
  }
  await app?.close();
  app = null;
});

async function inject(
  identity: Identity,
  method: "POST",
  url: string,
  payload: unknown,
): Promise<{ status: number; body: any }> {
  const headers = new Headers({ "content-type": "application/json" });
  applyTrustedContextHeaders(headers, identity, { secret: SECRET });
  const body = JSON.stringify(payload);
  if (remoteUrl) {
    const response = await fetch(`${remoteUrl}${url}`, { method, headers, body });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }
  const response = await getApp().inject({
    method,
    url,
    headers: Object.fromEntries(headers.entries()),
    payload: body,
  });
  return {
    status: response.statusCode,
    body: response.body ? JSON.parse(response.body) : undefined,
  };
}

/** A create body satisfying every required column, with `overrides` applied last. */
async function createBody(
  identity: Identity,
  overrides: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const fkTargets = foreignKeyTargets(table!);
  const body: Record<string, unknown> = {};
  for (const column of table!.columns) {
    if (!isMutableColumn(column)) continue;
    const field = fieldName(column);
    if (field in overrides) continue;
    const fkTarget = fkTargets.get(column.name);
    if (fkTarget) {
      if (column.required) {
        body[field] = await createRow(tablesByName.get(fkTarget)!, identity);
      }
      continue;
    }
    if (column.required) body[field] = sampleValue(column, `refusal-${seed}`);
  }
  return { ...body, ...overrides };
}

const REFUSED = {
  code: "OPERATION_REFUSED",
  message: RULE_MESSAGE,
  detail: RULE_DETAIL,
  hint: RULE_HINT,
};

describe("a trigger's refusal", () => {
  test("the manifest has a table every transport can create", () => {
    expect(table).toBeDefined();
    expect(markerColumn).toBeDefined();
  });

  test("REST answers 409 OPERATION_REFUSED with the trigger's message, detail and hint", async () => {
    const body = await createBody(tenantA, { [fieldName(markerColumn!)]: MARKER });
    const response = await inject(
      tenantA,
      "POST",
      `${REST_MOUNT_PATH}/${table!.source!.rest!.basePath}`,
      body,
    );
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: REFUSED });
  });

  test("GraphQL answers the code unmasked, with the trigger's message", async () => {
    const graphql = table!.source!.graphql!;
    const input = await createBody(tenantA, { [fieldName(markerColumn!)]: MARKER });
    const response = await gql(
      tenantA,
      `mutation($input: Create${graphql.typeName}Input!) {
         ${graphql.createMutationName}(input: $input) { id }
       }`,
      { input },
    );
    expect(response.data?.[graphql.createMutationName] ?? null).toBeNull();
    expect(response.errors).toHaveLength(1);
    expect(response.errors?.[0]?.message).toBe(RULE_MESSAGE);
    expect(response.errors?.[0]?.extensions).toMatchObject({
      code: "OPERATION_REFUSED",
      hint: RULE_HINT,
    });
  });

  test("a row without the marker is still accepted", async () => {
    const id = await createRow(table!, tenantA);
    expect(id).toBeTruthy();
  });
});

describe("a system constraint violation", () => {
  const fkCandidates = tables.filter((candidate) => {
    if (!candidate.source?.rest?.operations.create) return false;
    const targets = foreignKeyTargets(candidate);
    return candidate.columns.some(
      (column) => targets.has(column.name) && isMutableColumn(column),
    );
  });

  test("a foreign key pointing at nothing is 404 REFERENCE_NOT_FOUND naming the field, never the constraint", async () => {
    let withOptionalFk: (typeof tables)[number] | undefined;
    for (const candidate of fkCandidates) {
      if (await relationExists(candidate.schema, candidate.table)) {
        withOptionalFk = candidate;
        break;
      }
    }
    expect(withOptionalFk).toBeDefined();
    if (!withOptionalFk) return;
    const targets = foreignKeyTargets(withOptionalFk);
    const fkColumn = withOptionalFk.columns.find(
      (column) => targets.has(column.name) && isMutableColumn(column),
    )!;
    const body: Record<string, unknown> = {};
    for (const column of withOptionalFk.columns) {
      if (!isMutableColumn(column) || column === fkColumn) continue;
      const field = fieldName(column);
      const target = targets.get(column.name);
      if (target) {
        if (column.required) body[field] = await createRow(tablesByName.get(target)!, tenantA);
        continue;
      }
      if (column.required) body[field] = sampleValue(column, `fk-${seed}`);
    }
    body[fieldName(fkColumn)] = randomUUID();
    const response = await inject(
      tenantA,
      "POST",
      `${REST_MOUNT_PATH}/${withOptionalFk.source!.rest!.basePath}`,
      body,
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("REFERENCE_NOT_FOUND");
    expect(response.body.error.message).toContain(fieldName(fkColumn));
    const text = JSON.stringify(response.body);
    expect(text).not.toContain("fkey");
    expect(text).not.toContain(fkColumn.name);
    expect(text).not.toContain(withOptionalFk.table);
  });
});
