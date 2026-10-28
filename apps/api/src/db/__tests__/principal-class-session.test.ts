// SPDX-License-Identifier: BUSL-1.1
/**
 * The principal class and the application principal reach the database, and
 * survive the one join that does not rebuild them.
 *
 * Two independently developed rules meet here. `createDbSessionContext`
 * DERIVES `principalClass` and `appPrincipalId` from what the carrier supplied
 * — a resolved integration, or the class the server itself established about
 * the login (the bearer verifier's verdict, or the one a trusted-context
 * producer signed into its bundle) — and never from a field a caller can set,
 * and never from the identity link, which names a party rather than a kind of
 * principal. `activeDbSessionContext` hands the ALREADY DERIVED session
 * back to work that must join the caller's transaction without holding the
 * context that transaction was opened from (auth/api-key/service.ts).
 *
 * Deriving a session from such a context is lossy in exactly the direction
 * that matters: a context carries no `appPrincipal` and no `principalKind`, so
 * every verified person would be re-read as `unknown` and a resolved
 * application would be stripped to none. `withDbSession` therefore recognises
 * the active session BY IDENTITY and reuses it. What is proven:
 *
 *   - each carrier shape reaches `app.current_principal_class()`,
 *     `app.current_app_principal()` and `app.current_app_credential()` as the
 *     server classified it — including the v2 bundles whose verified link names
 *     a person party, confirmed and pending, which are `unknown` and not a
 *     person's class, while the audit identity and the acting Relation that
 *     link carries still arrive;
 *   - handing the active session back verbatim joins the SAME transaction
 *     (compared on `txid_current()`) with both values intact, for every shape
 *     — including the three the derivation cannot reproduce;
 *   - `independent: true` opens a second transaction and still carries them;
 *   - a COPY of that context is not the active session, so it is derived and
 *     then refused by the nested fence. The fence is not loosened: a session
 *     that really is different is still refused, in both directions — the
 *     same application on a DIFFERENT credential among them, which is the one
 *     substitution an integration id cannot distinguish.
 *   - the session itself is frozen, so neither the callback's argument nor the
 *     accessor's answer can be edited into a different principal and handed
 *     back — the last describe block states that on its own.
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
  createDbSessionContext,
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
const credentialId = randomUUID();

/**
 * The carriers this layer classifies, as a resolver hands them over.
 *
 * `linkedPerson`, `pendingPerson`, `linkedService` and `unclassified` are all
 * the same payload-v2 trusted-context bundle: the producer that predates the
 * signed class names its user and carries no verdict. What separates them is
 * the identity link the resolver attached — a confirmed person party, an
 * unconfirmed candidate, a person party under a signed service verdict, and
 * no link at all — and the point of having all four is that the link makes NO
 * difference to the class. `personWithRelation` is the same link under a
 * signed `person`, which is the only thing that does.
 */
const carriers = {
  /** A signed person who is also linked: the ordinary logged-in employee. */
  personWithRelation: {
    tenantId, userId, principalKind: "person",
    relation: {
      status: "linked", relationId, identityId, issuer: "https://identity.test",
      subject: userId,
    },
  },
  /**
   * The same verified link to the same person Relation, on a carrier that
   * states no kind. The most person-like session the server can hold without
   * having classified a person — and `link_identity` lets an administrator
   * point a service identity at exactly this Relation, so the party proves
   * nothing about the principal.
   */
  linkedPerson: {
    tenantId, userId,
    relation: {
      status: "linked", relationId, identityId, issuer: "https://identity.test",
      subject: userId,
    },
  },
  /** A candidate an e-mail matched and nobody confirmed. */
  pendingPerson: {
    tenantId, userId,
    relation: {
      status: "pending_confirmation", relationId, identityId,
      issuer: "https://identity.test", subject: userId,
    },
  },
  /** A signed service verdict that the link does not lift. */
  linkedService: {
    tenantId, userId, principalKind: "service",
    relation: {
      status: "linked", relationId, identityId, issuer: "https://identity.test",
      subject: userId,
    },
  },
  personWithoutRelation: { tenantId, userId, principalKind: "person" },
  application: {
    tenantId, userId, principalKind: "service",
    appPrincipal: { integrationId, credentialId },
  },
  service: { tenantId, userId, principalKind: "service" },
  unclassified: { tenantId, userId },
} satisfies Record<string, DbSessionInput>;

type Carrier = keyof typeof carriers;

/** What the server decided, as the database reads it back. */
const expected: Record<
  Carrier,
  { principalClass: string; appPrincipal: string | null; appCredential: string | null }
> = {
  personWithRelation: { principalClass: "person", appPrincipal: null, appCredential: null },
  // A verified link is not a person, confirmed or pending. The audit identity
  // and the acting Relation it carries are still this session's own
  // (`app.audit_identity_id`, `app.relation_id`, asserted below); the CLASS is
  // not a person's, so the named-action axis holds nothing for it.
  linkedPerson: { principalClass: "unknown", appPrincipal: null, appCredential: null },
  pendingPerson: { principalClass: "unknown", appPrincipal: null, appCredential: null },
  linkedService: { principalClass: "service", appPrincipal: null, appCredential: null },
  personWithoutRelation: { principalClass: "person", appPrincipal: null, appCredential: null },
  application: {
    principalClass: "application", appPrincipal: integrationId, appCredential: credentialId,
  },
  service: { principalClass: "service", appPrincipal: null, appCredential: null },
  unclassified: { principalClass: "unknown", appPrincipal: null, appCredential: null },
};

/**
 * The carriers a CONTEXT cannot reproduce.
 *
 * A context carries neither `appPrincipal` nor `principalKind` nor the link,
 * so deriving a session from one answers `unknown` with no application
 * principal — a different session for every carrier that states a kind, and
 * the same one for every carrier that states none.
 */
const notDerivable: readonly Carrier[] =
  ["personWithRelation", "personWithoutRelation", "application", "service", "linkedService"];

/** The carriers a context reproduces exactly, because they hold nothing. */
const derivable: readonly Carrier[] = ["unclassified", "linkedPerson", "pendingPerson"];

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

type Observed = {
  principalClass: string;
  appPrincipal: string | null;
  appCredential: string | null;
  txid: string;
};

async function observe(trx: unknown): Promise<Observed> {
  const row = await sql<{
    principal_class: string; app_principal: string | null;
    app_credential: string | null; txid: string;
  }>`
    select app.current_principal_class() as principal_class,
           app.current_app_principal()::text as app_principal,
           app.current_app_credential()::text as app_credential,
           txid_current()::text as txid
  `.execute(trx as never);
  const first = row.rows[0]!;
  return {
    principalClass: first.principal_class,
    appPrincipal: first.app_principal,
    appCredential: first.app_credential,
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

  test("a link still carries its audit identity and acting Relation", async () => {
    if (!runtime) return;
    // The class is about personhood; these two are about which identity acted
    // and which party it acts as. Narrowing the first must not quietly drop
    // the other two, or a v2 session would lose its audit trail and its
    // owner-axis row scope along with a class it never needed.
    for (const carrier of ["linkedPerson", "pendingPerson", "linkedService"] as const) {
      const observed = await withDbSession(runtime.db, carriers[carrier], async (trx) => {
        const row = await sql<{ audit: string; relation: string | null; principal: string }>`
          select current_setting('app.audit_identity_id') as audit,
                 nullif(current_setting('app.relation_id', true), '') as relation,
                 app.current_principal_class() as principal
        `.execute(trx);
        return row.rows[0]!;
      });
      expect({ carrier, ...observed }).toEqual({
        carrier,
        audit: identityId,
        // `app.relation_id` follows the acting-Relation rule, which requires a
        // CONFIRMED link — so the pending candidate has none, exactly as before.
        relation: carrier === "pendingPerson" ? null : relationId,
        principal: expected[carrier].principalClass,
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
    for (const carrier of Object.keys(carriers) as Carrier[]) {
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
    // The carriers a copy DOES reproduce are the ones that hold nothing:
    // `unknown` with no application principal is what deriving from a context
    // answers, so for these it is not a substitution at all.
    for (const carrier of derivable) {
      const copied = await inSession(carrier, (_outer, active) =>
        withDbSession(runtime!.db, { ...active }, (trx) => observe(trx)));
      expect({ carrier, ...copied, txid: undefined })
        .toMatchObject({ carrier, ...expected[carrier] });
    }
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
    // And the same link under a signed person is not interchangeable with the
    // same link under no class: the fence compares the derived class, so a
    // nested v2 session cannot continue a verified person's transaction.
    await expect(
      withDbSession(runtime.db, carriers.personWithRelation, () =>
        withDbSession(runtime!.db, carriers.linkedPerson, (trx) => observe(trx))),
    ).rejects.toThrow("Nested database work cannot replace the active session.");
    await expect(
      withDbSession(runtime.db, carriers.linkedPerson, () =>
        withDbSession(runtime!.db, carriers.personWithRelation, (trx) => observe(trx))),
    ).rejects.toThrow("Nested database work cannot replace the active session.");
    // And an application cannot be swapped for a DIFFERENT application.
    await expect(
      withDbSession(runtime.db, carriers.application, () =>
        withDbSession(
          runtime!.db,
          {
            tenantId, userId, principalKind: "service",
            appPrincipal: { integrationId: randomUUID(), credentialId: randomUUID() },
          },
          (trx) => observe(trx),
        )),
    ).rejects.toThrow("Nested database work cannot replace the active session.");
    // Nor for the SAME application on another key. The integration id is
    // chosen to survive rotation, so it is the credential that says which row
    // the record-action fence re-reads for revocation and expiry — swapping it
    // mid-transaction would let a withdrawn key finish another key's work.
    await expect(
      withDbSession(runtime.db, carriers.application, () =>
        withDbSession(
          runtime!.db,
          {
            tenantId, userId, principalKind: "service",
            appPrincipal: { integrationId, credentialId: randomUUID() },
          },
          (trx) => observe(trx),
        )),
    ).rejects.toThrow("Nested database work cannot replace the active session.");
  });
});

/**
 * The session a rejoin is recognised by cannot be EDITED into another one.
 *
 * The catalog's join needs the derived session itself, so the object reaches
 * code outside db/session.ts twice: as the second argument of every
 * `withDbSession` callback, and through `activeDbSessionContext`. Both used to
 * hand out the mutable object the transaction's GUCs had been written from, and
 * the nested fence then compared that object against ITSELF, field by field,
 * and agreed. So a caller holding it could write a different tenant, a longer
 * role set or `principalClass: "person"` onto it and hand it back with
 * `independent: true`, and a second transaction opened with the edited fields —
 * while every service-level check that reads the session rather than the GUCs
 * (`auth/api-key/service.ts` checks tenant, user, class and app principal on
 * it) saw the edited values too.
 *
 * Nothing here asserts that HTTP input can reach this: it cannot, and that is
 * not what makes the fix worth having. The session object is passed by
 * reference to in-process code that the fence exists to constrain — nested
 * canonical Operations, plugin runtime work, the provisioning service — so
 * "no request can set this field" is not the same claim as "no holder of the
 * object can". These tests are about the second.
 *
 * Both halves are stated: the edit fails at the assignment, and even when a
 * caller gets an edited object by another route, no transaction opened from it
 * carries a tenant, a role, a principal class or an application principal the
 * carrier did not have.
 */
describe("the active session is immutable, and a rejoin cannot be redirected", () => {
  const otherTenant = randomUUID();

  /**
   * The fields the DERIVATION reads back off a context, with the value an
   * escalation would want. An object carrying one of these is a different
   * session, and the fence says so.
   */
  const derived: readonly [string, unknown][] = [
    ["tenantId", otherTenant],
    ["userId", randomUUID()],
    ["scope", "tenant"],
    ["relationId", randomUUID()],
    ["roles", ["Platform.ApiKeys.Manage"]],
  ];

  /**
   * The fields a context carries and no carrier input produces, so the
   * derivation cannot read them back at all. Writing one onto a copy is not
   * refused — it is IGNORED, which is the other half of the same answer.
   */
  const ignored: readonly [string, unknown][] = [
    ["principalClass", "person"],
    ["appPrincipalId", randomUUID()],
    ["appCredentialId", randomUUID()],
  ];

  /** What the database says about the session a transaction really runs under. */
  async function settings(trx: unknown) {
    const row = await sql<{
      tenant: string; user_id: string; roles: string; scope: string;
      principal_class: string; app_principal: string | null;
      app_credential: string | null; relation: string | null;
    }>`
      select current_setting('app.tenant_id', true) as tenant,
             current_setting('app.user_id', true) as user_id,
             current_setting('app.roles', true) as roles,
             current_setting('app.scope', true) as scope,
             app.current_principal_class() as principal_class,
             app.current_app_principal()::text as app_principal,
             app.current_app_credential()::text as app_credential,
             nullif(current_setting('app.relation_id', true), '') as relation
    `.execute(trx as never);
    return row.rows[0]!;
  }

  test("the session handed to the callback is the frozen one, not a copy of it", async () => {
    if (!runtime) return;
    await withDbSession(runtime.db, carriers.service, async (_trx, session) => {
      // The callback's argument and the accessor's answer are one object, so
      // there is no second, editable view of the active session to find.
      expect(activeDbSessionContext(runtime!.db)).toBe(session);
      expect(Object.isFrozen(session)).toBe(true);
      expect(Object.isFrozen(session.roles)).toBe(true);
      expect(Object.isFrozen(session.groups)).toBe(true);
      expect(Object.isFrozen(session.relationGroupIds)).toBe(true);
    });
  });

  test("the carrier's own arrays are copied, not frozen where they lie", async () => {
    const roles = ["Relations.All.Read"];
    const groups = [randomUUID()];
    const relationGroupIds = [randomUUID()];
    const session = createDbSessionContext({
      tenantId, userId, principalKind: "service", roles, groups, relationGroupIds,
    });
    for (const [label, own, sealed] of [
      ["roles", roles, session.roles],
      ["groups", groups, session.groups],
      ["relationGroupIds", relationGroupIds, session.relationGroupIds],
    ] as const) {
      // The session's array is frozen…
      expect([label, Object.isFrozen(sealed)]).toEqual([label, true]);
      // …and it is not the CARRIER's array. Freezing one of those would reach
      // back out of this layer into code entitled to keep editing its own
      // (modules/maintenance.ts assigns `session.roles`, and a fixture in
      // accounts/member-actions-db.test.ts pushes onto one), so each is
      // copied before it is sealed.
      expect([label, Object.isFrozen(own)]).toEqual([label, false]);
      expect([label, sealed === (own as readonly string[])]).toEqual([label, false]);
      expect([label, [...sealed]]).toEqual([label, [...own]]);
    }
    // So editing the carrier's arrays afterwards reaches nothing derived.
    roles.push("Platform.ApiKeys.Manage");
    groups.push(randomUUID());
    relationGroupIds.push(randomUUID());
    expect(session.roles).toEqual(["Relations.All.Read"]);
    expect(session.groups).toHaveLength(1);
    expect(session.relationGroupIds).toHaveLength(1);
  });

  test("a later edit of the carrier cannot reach the running transaction", async () => {
    if (!runtime) return;
    const roles = ["Relations.All.Read"];
    const observed = await withDbSession(
      runtime.db,
      { tenantId, userId, principalKind: "service" as const, roles },
      async (trx, session) => {
        roles.push("Platform.ApiKeys.Manage");
        expect(session.roles).toEqual(["Relations.All.Read"]);
        return settings(trx);
      },
    );
    expect(observed).toMatchObject({
      roles: "Relations.All.Read", principal_class: "service",
    });
  });

  test("every field a mutation would want refuses the assignment", async () => {
    if (!runtime) return;
    await withDbSession(runtime.db, carriers.service, async (_trx, session) => {
      for (const [field, value] of [...derived, ...ignored]) {
        const before = (session as unknown as Record<string, unknown>)[field];
        // Strict code, which a module is, throws rather than dropping the
        // write. Caught so the FIELD is what this asserts either way.
        expect(() => {
          (session as unknown as Record<string, unknown>)[field] = value;
        }).toThrow();
        expect({ field, value: (session as unknown as Record<string, unknown>)[field] })
          .toEqual({ field, value: before });
      }
      // And the role set cannot be grown in place.
      expect(() => (session.roles as string[]).push("Platform.ApiKeys.Manage")).toThrow();
      expect(session.roles).toEqual([]);
    });
  });

  test("an edited copy is a different session, nested and independent alike", async () => {
    if (!runtime) return;
    // The route a caller has left: build its OWN object with the fields it
    // wants. That object is not the active session, so it is derived and then
    // held to the fence — for the nested transaction and the independent one.
    for (const [field, value] of derived) {
      for (const independent of [false, true]) {
        await expect(
          withDbSession(runtime.db, carriers.service, (_trx, session) =>
            withDbSession(
              runtime!.db,
              { ...session, [field]: value } as never,
              (trx) => settings(trx),
              { independent },
            )),
        ).rejects.toThrow("Nested database work cannot replace the active session.");
      }
    }
  });

  test("a class or an application principal written onto a copy is ignored", async () => {
    if (!runtime) return;
    // `unclassified` is the carrier a copy reproduces exactly, so these two
    // fields are the ONLY difference and the fence has nothing to refuse. What
    // reaches the database is still the carrier's own answer: a session cannot
    // be talked into a class, only derived into one.
    for (const [field, value] of ignored) {
      for (const independent of [false, true]) {
        const observed = await withDbSession(runtime.db, carriers.unclassified,
          (_trx, session) => withDbSession(
            runtime!.db,
            { ...session, [field]: value } as never,
            (trx) => settings(trx),
            { independent },
          ));
        expect({ field, independent, ...observed }).toMatchObject({
          field, independent, principal_class: "unknown", app_principal: null,
          app_credential: null,
        });
      }
    }
  });

  test("an independent rejoin runs under the carrier's own session, not an edited one", async () => {
    if (!runtime) return;
    const observed = await withDbSession(runtime.db, carriers.service, async (_trx, session) => {
      // A prototype child, which `Object.freeze` does not reach. Assigning
      // through it does not even get that far: a non-writable inherited
      // property refuses the write, so shadowing takes `defineProperty`.
      const shadowed = Object.create(session) as Record<string, unknown>;
      expect(() => { shadowed.tenantId = otherTenant; }).toThrow();
      for (const [field, value] of [["tenantId", otherTenant], ["principalClass", "person"],
        ["roles", ["Platform.ApiKeys.Manage"]]] as const) {
        Object.defineProperty(shadowed, field, { value, enumerable: true, configurable: true });
      }
      // Still not the active session, so it is derived — and `tenantId` alone
      // is enough for the fence to refuse it, independent or not.
      await expect(withDbSession(runtime!.db, shadowed as never, (trx) => settings(trx),
        { independent: true })).rejects.toThrow(
          "Nested database work cannot replace the active session.");

      // And the genuine object still joins and still opens an independent
      // transaction, under the session the carrier produced.
      return withDbSession(runtime!.db, session, (trx) => settings(trx), { independent: true });
    });
    expect(observed).toEqual({
      tenant: tenantId,
      user_id: userId,
      roles: "",
      scope: "self",
      principal_class: "service",
      app_principal: null,
      app_credential: null,
      relation: null,
    });
  });

  test("a cross-tenant session is refused whether it is nested or independent", async () => {
    if (!runtime) return;
    for (const independent of [false, true]) {
      await expect(
        withDbSession(runtime.db, carriers.service, () =>
          withDbSession(
            runtime!.db,
            { tenantId: otherTenant, userId, principalKind: "service" },
            (trx) => settings(trx),
            { independent },
          )),
      ).rejects.toThrow("Nested database work cannot replace the active session.");
    }
  });
});
