// SPDX-License-Identifier: BUSL-1.1
/**
 * The principal class and the application principal reach the database, and
 * survive the one join that does not rebuild them.
 *
 * Two independently developed rules meet here. `createDbSessionContext`
 * DERIVES `principalClass` and `appPrincipalId` from what the carrier supplied
 * — a resolved integration, the bearer verifier's verdict, or the identity
 * link read back from `platform.identity_relations` — and never from a field a
 * caller can set. `activeDbSessionContext` hands the ALREADY DERIVED session
 * back to work that must join the caller's transaction without holding the
 * context that transaction was opened from (auth/api-key/service.ts).
 *
 * Deriving a session from such a context is lossy in exactly the direction
 * that matters: a context carries no `appPrincipal` and no `principalKind`, so
 * a verified person who has no Relation would be re-read as `unknown` and a
 * resolved application would be stripped to none. `withDbSession` therefore
 * recognises the active session BY IDENTITY and reuses it. What is proven:
 *
 *   - each carrier shape reaches `app.current_principal_class()` and
 *     `app.current_app_principal()` as the server classified it;
 *   - handing the active session back verbatim joins the SAME transaction
 *     (compared on `txid_current()`) with both values intact, for every shape
 *     — including the two the derivation cannot reproduce;
 *   - `independent: true` opens a second transaction and still carries them;
 *   - a COPY of that context is not the active session, so it is derived and
 *     then refused by the nested fence. The fence is not loosened: a session
 *     that really is different is still refused, in both directions.
 *
 * Skips wholesale when no PostgreSQL is reachable; point
 * `SCRATCH_ADMIN_DATABASE_URL` at an isolated server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { applyAppHelpersMigration } from "../migrations/app-helpers.js";
import {
  activeDbSessionContext,
  withDbSession,
  type DbSessionContext,
  type DbSessionInput,
} from "../session.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const scratchName = `principal_class_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const tenantId = randomUUID();
const userId = randomUUID();
const relationId = randomUUID();
const identityId = randomUUID();
const integrationId = randomUUID();

/**
 * The five carriers this layer classifies, as a resolver hands them over.
 *
 * `personWithRelation` and `unclassified` differ ONLY in the identity link —
 * the v2 trusted-context bundle that predates the signed class names its user
 * and carries no verdict, and is classified from the link or not at all.
 */
const carriers = {
  personWithRelation: {
    tenantId, userId,
    relation: { status: "linked", relationId, identityId, issuer: "https://identity.test", subject: userId },
  },
  personWithoutRelation: { tenantId, userId, principalKind: "person" },
  application: { tenantId, userId, principalKind: "service", appPrincipal: { integrationId } },
  service: { tenantId, userId, principalKind: "service" },
  unclassified: { tenantId, userId },
} satisfies Record<string, DbSessionInput>;

type Carrier = keyof typeof carriers;

/** What the server decided, as the database reads it back. */
const expected: Record<Carrier, { principalClass: string; appPrincipal: string | null }> = {
  personWithRelation: { principalClass: "person", appPrincipal: null },
  personWithoutRelation: { principalClass: "person", appPrincipal: null },
  application: { principalClass: "application", appPrincipal: integrationId },
  service: { principalClass: "service", appPrincipal: null },
  unclassified: { principalClass: "unknown", appPrincipal: null },
};

/** The carriers whose class the derivation cannot reproduce from a context. */
const notDerivable: readonly Carrier[] = ["personWithoutRelation", "application", "service"];

let admin: SQL | null = null;
let runtime: DatabaseRuntime | null = null;

function scratchUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${scratchName}`;
  return url.toString();
}

async function serverReachable(): Promise<boolean> {
  const probe = new SQL(ADMIN_URL, { max: 1 });
  try {
    await probe.unsafe("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}

type Observed = { principalClass: string; appPrincipal: string | null; txid: string };

async function observe(trx: unknown): Promise<Observed> {
  const row = await sql<{ principal_class: string; app_principal: string | null; txid: string }>`
    select app.current_principal_class() as principal_class,
           app.current_app_principal()::text as app_principal,
           txid_current()::text as txid
  `.execute(trx as never);
  const first = row.rows[0]!;
  return {
    principalClass: first.principal_class,
    appPrincipal: first.app_principal,
    txid: first.txid,
  };
}

/** Open a session for `carrier`, then run `nested` with the session it derived. */
function inSession<T>(
  carrier: Carrier,
  nested: (outer: Observed, active: DbSessionContext) => Promise<T>,
): Promise<T> {
  return withDbSession(runtime!.db, carriers[carrier], async (trx) => {
    const outer = await observe(trx);
    const active = activeDbSessionContext(runtime!.db)!;
    return nested(outer, active);
  });
}

beforeAll(async () => {
  if (!(await serverReachable())) {
    console.log(
      `[principal class] SKIPPED — no PostgreSQL at ${new URL(ADMIN_URL).host}. ` +
        "Set SCRATCH_ADMIN_DATABASE_URL to an isolated server to run this suite.",
    );
    return;
  }
  admin = new SQL(ADMIN_URL, { max: 1 });
  await admin.unsafe(`create database "${scratchName}"`);
  runtime = createDatabaseRuntime({ databaseUrl: scratchUrl(), maxConnections: 4 });
  await applyAppHelpersMigration(runtime.db);
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  await admin?.unsafe(`drop database if exists "${scratchName}" with (force)`);
  await admin?.close();
}, 60_000);

describe("the principal class in the database session", () => {
  test("every carrier reaches the database as the server classified it", async () => {
    if (!runtime) return;
    for (const carrier of Object.keys(carriers) as Carrier[]) {
      const observed = await inSession(carrier, async (outer) => outer);
      expect({ carrier, ...observed, txid: undefined }).toMatchObject({
        carrier,
        ...expected[carrier],
      });
    }
  });

  test("the active session handed back verbatim joins it with both values intact", async () => {
    if (!runtime) return;
    for (const carrier of Object.keys(carriers) as Carrier[]) {
      const { outer, inner } = await inSession(carrier, async (outer, active) => ({
        outer,
        inner: await withDbSession(runtime!.db, active, (trx) => observe(trx)),
      }));
      // The same transaction, not merely the same answer.
      expect({ carrier, ...inner }).toMatchObject({ carrier, ...expected[carrier], txid: outer.txid });
    }
  });

  test("an independent rejoin opens its own transaction and still carries them", async () => {
    if (!runtime) return;
    for (const carrier of notDerivable) {
      const { outer, inner } = await inSession(carrier, async (outer, active) => ({
        outer,
        inner: await withDbSession(
          runtime!.db,
          active,
          (trx) => observe(trx),
          { independent: true },
        ),
      }));
      expect({ carrier, ...inner, txid: undefined }).toMatchObject({ carrier, ...expected[carrier] });
      expect(inner.txid).not.toBe(outer.txid);
    }
  });

  test("a copy of the active session is derived, and then refused", async () => {
    if (!runtime) return;
    for (const carrier of notDerivable) {
      await expect(
        inSession(carrier, (_outer, active) =>
          withDbSession(runtime!.db, { ...active }, (trx) => observe(trx))),
      ).rejects.toThrow("Nested database work cannot replace the active session.");
    }
    // The link-derived person is the one shape a copy DOES reproduce: its
    // class comes from the audit identity the context still carries.
    const copied = await inSession("personWithRelation", (_outer, active) =>
      withDbSession(runtime!.db, { ...active }, (trx) => observe(trx)));
    expect(copied).toMatchObject(expected.personWithRelation);
  });

  test("nested work cannot exchange an application session for a person's, or back", async () => {
    if (!runtime) return;
    await expect(
      withDbSession(runtime.db, carriers.application, () =>
        withDbSession(runtime!.db, carriers.personWithRelation, (trx) => observe(trx))),
    ).rejects.toThrow("Nested database work cannot replace the active session.");
    await expect(
      withDbSession(runtime.db, carriers.personWithRelation, () =>
        withDbSession(runtime!.db, carriers.application, (trx) => observe(trx))),
    ).rejects.toThrow("Nested database work cannot replace the active session.");
    // And an application cannot be swapped for a DIFFERENT application.
    await expect(
      withDbSession(runtime.db, carriers.application, () =>
        withDbSession(
          runtime!.db,
          { tenantId, userId, principalKind: "service", appPrincipal: { integrationId: randomUUID() } },
          (trx) => observe(trx),
        )),
    ).rejects.toThrow("Nested database work cannot replace the active session.");
  });
});
