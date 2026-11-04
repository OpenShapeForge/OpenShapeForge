// SPDX-License-Identifier: BUSL-1.1
/**
 * The expected-Connection control, as a predicate.
 *
 * What it must mean, pinned here: a reference names ONE Connection row of one
 * tenant at one scope, and nothing else satisfies it — not another row of the
 * same Adapter, not a replacement holding the very same credentials, not
 * another tenant's row with the same id, not another person's personal row,
 * and not a string a caller made up. The execution-boundary behaviour is in
 * expected-connection.e2e.test.ts; this file is the meaning the boundary
 * leans on.
 *
 * The same meaning holds of the other way a caller names a Connection — its
 * own id, scoped to the tenant of the session that presented it — which exists
 * for the first call of a run, where no reference exists yet. It accepts
 * exactly the row of that id in that tenant: a replacement is refused, a
 * malformed id is refused before anything compares it, and the same id under
 * another tenant's session is refused as well. And neither representation may
 * widen the other: an invocation held to both is held to both.
 *
 * The capture side is the same meaning read rather than judged: what ONE
 * invocation obtained credentials from, and the round trip that makes the
 * answer worth handing out — a reference captured at a boundary must satisfy
 * the expectation check at that same boundary, or a caller could never present
 * it back.
 */
import { describe, expect, it } from "bun:test";
import type { IdentityLinkState } from "../../auth/identity-link.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";
import { mintInvocationSourceReference } from "../../modules/source-reference.js";
import {
  DECLARATIVE_CONNECTION_CAPABILITIES,
  EXPECTED_CONNECTION_UNAVAILABLE_CODE,
  ambientConnectionControls,
  assertConnectionControls,
  assertExpectedConnection,
  connectionMatchesExpectation,
  createConnectionUseRecorder,
  inheritConnectionControls,
  parseConnectionExpectation,
  parseDeclarativeConnectionCapabilities,
  withConnectionControls,
} from "../connection-expectation.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "99999999-9999-4999-8999-999999999999";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const RELATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_RELATION_ID = "44444444-4444-4444-8444-444444444444";
const TABLE = "public.connections_test";
const CONNECTION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const link = (relationId: string): IdentityLinkState => ({
  identityId: "55555555-5555-4555-8555-555555555555",
  issuer: "http://localhost:8181/realms/openshapeforge",
  subject: USER_ID,
  status: "linked",
  relationId,
  displayName: "Expectation tester",
  relationType: "person",
  candidateRelationId: null,
  linkedBy: null,
  needsRoleAssignment: false,
  roles: [],
});

const session = (
  overrides: Partial<TrustedSessionContext> = {},
): TrustedSessionContext => ({
  tenantId: TENANT_ID,
  userId: USER_ID,
  roles: ["reader"],
  groups: [],
  scope: "self",
  credential: "bearer",
  relation: link(RELATION_ID),
  ...overrides,
});

const expectation = (sourceReference: string, context = session()) =>
  parseConnectionExpectation(
    { sourceReference, appliesTo: "every-provider-call" },
    context,
  )!;

/** The other representation: the Connection's own id, as a caller holds it. */
const idExpectation = (connectionId: string, context = session()) =>
  parseConnectionExpectation(
    { connectionId, appliesTo: "every-provider-call" },
    context,
  )!;

/** The refusal's one message, which names no representation and no row. */
const REFUSAL = /expectation names/;

const tenantReference = (
  connectionId: string,
  tenantId = TENANT_ID,
  connectionTable = TABLE,
) =>
  mintInvocationSourceReference({
    tenantId,
    actorId: null,
    scope: "tenant",
    connectionTable,
    connectionId,
  });

const personalReference = (connectionId: string, actorId = USER_ID) =>
  mintInvocationSourceReference({
    tenantId: TENANT_ID,
    actorId,
    scope: "personal",
    connectionTable: TABLE,
    connectionId,
  });

const matches = (
  sourceReference: string,
  connection: Record<string, unknown> | undefined,
  context = session(),
) =>
  connectionMatchesExpectation({
    expectation: expectation(sourceReference),
    session: context,
    connectionTable: TABLE,
    connection,
  });

/** The same predicate over an expectation set from a Connection id. */
const matchesId = (
  connectionId: string,
  connection: Record<string, unknown> | undefined,
  context = session(),
  presentedBy = context,
) =>
  connectionMatchesExpectation({
    expectation: idExpectation(connectionId, presentedBy),
    session: context,
    connectionTable: TABLE,
    connection,
  });

describe("reading the caller's expectation", () => {
  it("accepts exactly the published shapes", () => {
    expect(
      parseConnectionExpectation(
        { sourceReference: "msr1.abc", appliesTo: "every-provider-call" },
        session(),
      ),
    ).toEqual({
      requirements: [{ by: "source-reference", sourceReference: "msr1.abc" }],
    });
    // The id is read together with the tenant of the session presenting it:
    // the value a caller supplies is never a tenant-free identity.
    expect(
      parseConnectionExpectation(
        { connectionId: CONNECTION_A, appliesTo: "every-provider-call" },
        session(),
      ),
    ).toEqual({
      requirements: [
        { by: "connection-id", tenantId: TENANT_ID, connectionId: CONNECTION_A },
      ],
    });
  });

  it("treats an absent expectation as no expectation", () => {
    expect(parseConnectionExpectation(undefined, session())).toBeUndefined();
    expect(parseConnectionExpectation(null, session())).toBeUndefined();
  });

  it("refuses anything it does not fully recognise", () => {
    for (const raw of [
      "msr1.abc",
      42,
      [{ sourceReference: "msr1.abc", appliesTo: "every-provider-call" }],
      {},
      { sourceReference: "msr1.abc" },
      { connectionId: CONNECTION_A },
      { appliesTo: "every-provider-call" },
      { sourceReference: "", appliesTo: "every-provider-call" },
      { sourceReference: "msr1.abc", appliesTo: "first-provider-call" },
      { connectionId: CONNECTION_A, appliesTo: "first-provider-call" },
      { sourceReference: "msr1.abc", appliesTo: "every-provider-call", binding: 1 },
      { sourceReference: ["msr1.abc"], appliesTo: "every-provider-call" },
      // The two ways of naming a Connection are mutually exclusive by shape.
      // Admitting both would let a caller present an id a host reads next to a
      // reference it ignores, and believe it had set the stricter of the two.
      {
        sourceReference: "msr1.abc",
        connectionId: CONNECTION_A,
        appliesTo: "every-provider-call",
      },
    ]) {
      expect(() => parseConnectionExpectation(raw, session())).toThrow(REFUSAL);
    }
  });

  it("refuses an id that is not the shape of a Connection id", () => {
    // A malformed id can never match a row, so admitting it would only move
    // the refusal to the credential boundary — and a truncated or padded id
    // must not be read as the one it resembles.
    for (const connectionId of [
      "",
      "not-a-uuid",
      CONNECTION_A.slice(0, -1),
      `${CONNECTION_A}a`,
      ` ${CONNECTION_A}`,
      `${CONNECTION_A}\n`,
      CONNECTION_A.replace("-", ""),
      // A nil UUID and a non-RFC-4122 variant: neither is an id this host mints.
      "00000000-0000-0000-0000-000000000000",
      "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa",
      42,
      null,
      [CONNECTION_A],
      { id: CONNECTION_A },
    ]) {
      expect(() =>
        parseConnectionExpectation(
          { connectionId, appliesTo: "every-provider-call" },
          session(),
        ),
      ).toThrow(REFUSAL);
    }
  });

  it("refuses an id a session with no tenant cannot scope", () => {
    // An id is tenant-scoped at the moment it is read. A session with no
    // tenant has nothing to scope it to, so there is no expectation to set —
    // and a reference, which carries its own tenant, is unaffected.
    expect(() =>
      parseConnectionExpectation(
        { connectionId: CONNECTION_A, appliesTo: "every-provider-call" },
        session({ tenantId: null }),
      ),
    ).toThrow(REFUSAL);
    expect(
      parseConnectionExpectation(
        {
          sourceReference: tenantReference(CONNECTION_A),
          appliesTo: "every-provider-call",
        },
        session({ tenantId: null }),
      ),
    ).toEqual({
      requirements: [
        {
          by: "source-reference",
          sourceReference: tenantReference(CONNECTION_A),
        },
      ],
    });
  });
});

describe("which connection satisfies an expectation", () => {
  it("accepts the organization connection the reference was minted for", () => {
    expect(matches(tenantReference(CONNECTION_A), { id: CONNECTION_A })).toBe(true);
    expect(
      matches(tenantReference(CONNECTION_A), { id: CONNECTION_A, ownerUserId: null }),
    ).toBe(true);
  });

  it("refuses a replacement row, including one holding the same credentials", () => {
    // What a portal migration looks like: the old Connection is gone and a new
    // one carries byte-identical configuration. Identity is the ROW, so the
    // equivalent key buys nothing.
    const values = { apiToken: "same-token", subdomain: "acme" };
    expect(
      matches(tenantReference(CONNECTION_A), { id: CONNECTION_B, values }),
    ).toBe(false);
    expect(
      matches(tenantReference(CONNECTION_B), { id: CONNECTION_A, values }),
    ).toBe(false);
  });

  it("refuses a retired connection, having nothing to compare", () => {
    expect(matches(tenantReference(CONNECTION_A), undefined)).toBe(false);
    expect(matches(tenantReference(CONNECTION_A), {})).toBe(false);
    expect(matches(tenantReference(CONNECTION_A), { id: "" })).toBe(false);
  });

  it("refuses another tenant's reference and another tenant's session", () => {
    expect(
      matches(tenantReference(CONNECTION_A, OTHER_TENANT_ID), { id: CONNECTION_A }),
    ).toBe(false);
    expect(
      matches(
        tenantReference(CONNECTION_A),
        { id: CONNECTION_A },
        session({ tenantId: OTHER_TENANT_ID }),
      ),
    ).toBe(false);
    // A session with no tenant has no identity to compare at all.
    expect(
      matches(
        tenantReference(CONNECTION_A),
        { id: CONNECTION_A },
        session({ tenantId: null }),
      ),
    ).toBe(false);
  });

  it("refuses a connection of the same id on another connection table", () => {
    expect(
      matches(tenantReference(CONNECTION_A, TENANT_ID, "public.other_test"), {
        id: CONNECTION_A,
      }),
    ).toBe(false);
  });

  it("keeps the personal and organization scopes apart", () => {
    const personal = { id: CONNECTION_A, ownerUserId: RELATION_ID };
    expect(matches(personalReference(CONNECTION_A), personal)).toBe(true);
    // The same row, read by a session that is not its owner: a tenant-scope
    // identity, which the personal reference does not name.
    expect(
      matches(
        personalReference(CONNECTION_A),
        personal,
        session({ relation: link(OTHER_RELATION_ID) }),
      ),
    ).toBe(false);
    expect(matches(tenantReference(CONNECTION_A), personal)).toBe(false);
    expect(matches(personalReference(CONNECTION_A), { id: CONNECTION_A })).toBe(false);
    // Another person's personal reference for the same row.
    expect(
      matches(
        personalReference(CONNECTION_A, "66666666-6666-4666-8666-666666666666"),
        personal,
      ),
    ).toBe(false);
  });

  it("refuses a reference nobody minted", () => {
    for (const forged of [
      "msr1.not-a-digest",
      "",
      "msr1.",
      tenantReference(CONNECTION_A).slice(0, -1),
      `${tenantReference(CONNECTION_A)}x`,
      JSON.stringify({ tenantId: TENANT_ID, connectionId: CONNECTION_A }),
    ]) {
      expect(
        connectionMatchesExpectation({
          expectation: {
            requirements: [{ by: "source-reference", sourceReference: forged }],
          },
          session: session(),
          connectionTable: TABLE,
          connection: { id: CONNECTION_A },
        }),
      ).toBe(false);
    }
  });

  it("refuses an expectation with nothing to demand", () => {
    // Unreachable through the parser, which always mints exactly one
    // requirement. Pinned because the alternative reading of "every
    // requirement holds" is that an empty one holds vacuously — which would
    // turn a control the caller set into no control at all.
    expect(
      connectionMatchesExpectation({
        expectation: { requirements: [] },
        session: session(),
        connectionTable: TABLE,
        connection: { id: CONNECTION_A },
      }),
    ).toBe(false);
  });
});

/**
 * The same question for the other representation.
 *
 * This is the one a sync can set on its FIRST call, from the id it read off
 * the Connection it means to synchronize from — the call that captures the
 * records, and the call a reference cannot cover because no reference exists
 * yet. So what it accepts has to be exactly as narrow: that row, in that
 * tenant.
 */
describe("which connection satisfies an expected Connection id", () => {
  it("accepts exactly the row of that id", () => {
    expect(matchesId(CONNECTION_A, { id: CONNECTION_A })).toBe(true);
    expect(matchesId(CONNECTION_A, { id: CONNECTION_A, ownerUserId: null })).toBe(
      true,
    );
    // A personal row is still that row; its scope is a property of the row the
    // resolution produced, not of the id the caller presented.
    expect(
      matchesId(CONNECTION_A, { id: CONNECTION_A, ownerUserId: RELATION_ID }),
    ).toBe(true);
  });

  it("refuses the replacement the race would substitute", () => {
    // The demonstrated failure: the sync read A, and by the time the first
    // page resolves its Connection the authorized row is B. Byte-identical
    // credentials buy the replacement nothing — identity is the row.
    const values = { apiToken: "same-token", subdomain: "acme" };
    expect(matchesId(CONNECTION_A, { id: CONNECTION_B, values })).toBe(false);
    expect(matchesId(CONNECTION_B, { id: CONNECTION_A, values })).toBe(false);
  });

  it("refuses a retired connection, having nothing to compare", () => {
    expect(matchesId(CONNECTION_A, undefined)).toBe(false);
    expect(matchesId(CONNECTION_A, {})).toBe(false);
    expect(matchesId(CONNECTION_A, { id: "" })).toBe(false);
  });

  it("refuses the same id read by another tenant's session", () => {
    // The id was scoped to the tenant that presented it. A session acting in
    // another tenant cannot satisfy it with a row of that id, however the
    // expectation reached that session — a replayed job, say, or a carried
    // queue state. Nothing in the comparison falls back to the id alone.
    expect(
      matchesId(
        CONNECTION_A,
        { id: CONNECTION_A },
        session({ tenantId: OTHER_TENANT_ID }),
        session(),
      ),
    ).toBe(false);
    expect(
      matchesId(
        CONNECTION_A,
        { id: CONNECTION_A },
        session(),
        session({ tenantId: OTHER_TENANT_ID }),
      ),
    ).toBe(false);
    // And a boundary whose session has no tenant can name no row at all.
    expect(
      matchesId(
        CONNECTION_A,
        { id: CONNECTION_A },
        session({ tenantId: null }),
        session(),
      ),
    ).toBe(false);
  });

  it("refuses a personal row this session does not act for", () => {
    // Unreachable through an authorized resolution, which never hands this
    // session another person's personal row. Pinned because the id variant
    // takes the scope from the row: a row with no identity under this session
    // must still be no match.
    expect(
      matchesId(
        CONNECTION_A,
        { id: CONNECTION_A, ownerUserId: RELATION_ID },
        session({ userId: null }),
      ),
    ).toBe(false);
  });
});

describe("the assertion the execution boundary makes", () => {
  it("passes without an expectation and for the expected connection", () => {
    expect(() =>
      assertExpectedConnection({
        expectation: undefined,
        session: session(),
        connectionTable: TABLE,
        connection: { id: CONNECTION_B },
      }),
    ).not.toThrow();
    expect(() =>
      assertExpectedConnection({
        expectation: expectation(tenantReference(CONNECTION_A)),
        session: session(),
        connectionTable: TABLE,
        connection: { id: CONNECTION_A },
      }),
    ).not.toThrow();
  });

  it("passes for the expected connection named by its id", () => {
    expect(() =>
      assertExpectedConnection({
        expectation: idExpectation(CONNECTION_A),
        session: session(),
        connectionTable: TABLE,
        connection: { id: CONNECTION_A },
      }),
    ).not.toThrow();
  });

  it("refuses with one conflict that distinguishes no case from another", () => {
    const cases: {
      expectation: ReturnType<typeof expectation>;
      connection: Record<string, unknown> | undefined;
    }[] = [
      // A replacement, a retirement and a scope mismatch, by reference...
      { expectation: expectation(tenantReference(CONNECTION_A)), connection: { id: CONNECTION_B } },
      { expectation: expectation(tenantReference(CONNECTION_A)), connection: undefined },
      {
        expectation: expectation(tenantReference(CONNECTION_A)),
        connection: { id: CONNECTION_A, ownerUserId: RELATION_ID },
      },
      // ...and the same three refusals when the caller presented an id, plus
      // an id of another tenant. Which representation was presented, and
      // whether the Connection exists at all, must be equally unreadable.
      { expectation: idExpectation(CONNECTION_A), connection: { id: CONNECTION_B } },
      { expectation: idExpectation(CONNECTION_A), connection: undefined },
      {
        expectation: idExpectation(CONNECTION_A, session({ tenantId: OTHER_TENANT_ID })),
        connection: { id: CONNECTION_A },
      },
    ];
    const refusals = cases.map((one) => {
      try {
        assertExpectedConnection({
          expectation: one.expectation,
          session: session(),
          connectionTable: TABLE,
          connection: one.connection,
        });
        return undefined;
      } catch (error) {
        return error as { status: number; code: string; message: string };
      }
    });
    expect(refusals.map((refusal) => refusal?.code)).toEqual(
      cases.map(() => EXPECTED_CONNECTION_UNAVAILABLE_CODE),
    );
    expect(refusals.map((refusal) => refusal?.status)).toEqual(
      cases.map(() => 409),
    );
    // One message for every case.
    expect(new Set(refusals.map((refusal) => refusal?.message)).size).toBe(1);
    expect(refusals[0]?.message).not.toContain(CONNECTION_A);
    expect(refusals[0]?.message).not.toContain(CONNECTION_B);
    expect(refusals[0]?.message).not.toContain(TENANT_ID);
  });
});

describe("what one invocation used", () => {
  const recorderFor = (
    rows: (Record<string, unknown> | undefined)[],
    context = session(),
  ) => {
    const recorder = createConnectionUseRecorder();
    for (const connection of rows) {
      recorder.record({
        session: context,
        connectionTable: TABLE,
        connection,
      });
    }
    return recorder;
  };

  it("says nothing was used when no credentials were obtained", () => {
    // Every binding that ran was the native transport, or none ran at all.
    expect(createConnectionUseRecorder().used()).toEqual({
      outcome: "no-provider-call",
    });
  });

  it("names the one Connection every provider call used", () => {
    const used = recorderFor([
      { id: CONNECTION_A },
      // The same Connection again: a second binding, or a second page.
      { id: CONNECTION_A, ownerUserId: null },
    ]).used();
    expect(used).toEqual({
      outcome: "one-connection",
      sourceReference: tenantReference(CONNECTION_A),
    });
  });

  it("hands back a reference the expectation check accepts", () => {
    // The round trip the whole feature rests on: what one invocation captured
    // is exactly what the next invocation may demand. Were the two derivations
    // to drift, a caller would be refused by its own captured identity.
    for (const connection of [
      { id: CONNECTION_A },
      { id: CONNECTION_B, ownerUserId: RELATION_ID },
    ]) {
      const used = recorderFor([connection]).used();
      expect(used.outcome).toBe("one-connection");
      expect(
        matches(
          (used as { sourceReference: string }).sourceReference,
          connection,
        ),
      ).toBe(true);
    }
  });

  it("keeps the personal and organization scopes apart, as the refusal does", () => {
    expect(recorderFor([{ id: CONNECTION_A, ownerUserId: RELATION_ID }]).used())
      .toEqual({
        outcome: "one-connection",
        sourceReference: personalReference(CONNECTION_A),
      });
    // The same ROW read by a session that does not own it is another identity,
    // so an invocation that touched both has used more than one Connection.
    const bothScopes = createConnectionUseRecorder();
    const row = { id: CONNECTION_A, ownerUserId: RELATION_ID };
    bothScopes.record({ session: session(), connectionTable: TABLE, connection: row });
    bothScopes.record({
      session: session({ relation: link(OTHER_RELATION_ID) }),
      connectionTable: TABLE,
      connection: row,
    });
    expect(bothScopes.used()).toEqual({ outcome: "no-single-connection" });
  });

  it("refuses to call two Connections one", () => {
    // A Service whose bindings span two accounts — two Adapters, or a personal
    // next to an organization Connection. There is no single identity to bind
    // a run to, and picking the first would be the very mistake this prevents.
    expect(recorderFor([{ id: CONNECTION_A }, { id: CONNECTION_B }]).used()).toEqual({
      outcome: "no-single-connection",
    });
    expect(
      recorderFor([
        { id: CONNECTION_A },
        { id: CONNECTION_B, ownerUserId: RELATION_ID },
      ]).used(),
    ).toEqual({ outcome: "no-single-connection" });
    // Another connection table is another identity too.
    const acrossTables = createConnectionUseRecorder();
    acrossTables.record({
      session: session(),
      connectionTable: TABLE,
      connection: { id: CONNECTION_A },
    });
    acrossTables.record({
      session: session(),
      connectionTable: "public.other_test",
      connection: { id: CONNECTION_A },
    });
    expect(acrossTables.used()).toEqual({ outcome: "no-single-connection" });
  });

  it("does not report a row it cannot name as no provider call", () => {
    // Credentials were obtained, so "nothing was used" would be a lie, and
    // there is no identity either. It errs towards refusing to name one.
    for (const rows of [
      [undefined],
      [{}],
      [{ id: "" }],
      [{ id: CONNECTION_A }, {}],
    ]) {
      expect(recorderFor(rows).used()).toEqual({
        outcome: "no-single-connection",
      });
    }
    // A session with no tenant has no identity at all to mint.
    expect(
      recorderFor([{ id: CONNECTION_A }], session({ tenantId: null })).used(),
    ).toEqual({ outcome: "no-single-connection" });
  });
});

describe("the credential boundary, as one step", () => {
  const boundary = (
    connection: Record<string, unknown> | undefined,
    controls: Parameters<typeof assertConnectionControls>[0]["controls"],
  ) =>
    assertConnectionControls({
      controls,
      session: session(),
      connectionTable: TABLE,
      connection,
    });

  it("records what passed, with or without an expectation", () => {
    for (const expectedConnection of [
      undefined,
      expectation(tenantReference(CONNECTION_A)),
    ]) {
      const connectionUse = createConnectionUseRecorder();
      boundary(
        { id: CONNECTION_A },
        {
          ...(expectedConnection ? { expectedConnection } : {}),
          connectionUse,
        },
      );
      expect(connectionUse.used()).toEqual({
        outcome: "one-connection",
        sourceReference: tenantReference(CONNECTION_A),
      });
    }
  });

  it("records nothing when it refuses", () => {
    // The invocation never reached that account, so it must not be reported as
    // one this invocation used — and the refusal is unchanged.
    const connectionUse = createConnectionUseRecorder();
    expect(() =>
      boundary(
        { id: CONNECTION_B },
        {
          expectedConnection: expectation(tenantReference(CONNECTION_A)),
          connectionUse,
        },
      ),
    ).toThrow(REFUSAL);
    expect(connectionUse.used()).toEqual({ outcome: "no-provider-call" });
  });

  it("records nothing when it refuses an expected id", () => {
    const connectionUse = createConnectionUseRecorder();
    expect(() =>
      boundary(
        { id: CONNECTION_B },
        { expectedConnection: idExpectation(CONNECTION_A), connectionUse },
      ),
    ).toThrow(REFUSAL);
    expect(connectionUse.used()).toEqual({ outcome: "no-provider-call" });
  });

  it("hands back the reference form for a row demanded by id", () => {
    // The first page sets an id and the capture answers with the core-minted
    // reference, which is what every later page presents. Were the capture to
    // echo the representation it was given, a run would lose the scope and the
    // connection table the reference commits.
    const connectionUse = createConnectionUseRecorder();
    boundary(
      { id: CONNECTION_A },
      { expectedConnection: idExpectation(CONNECTION_A), connectionUse },
    );
    expect(connectionUse.used()).toEqual({
      outcome: "one-connection",
      sourceReference: tenantReference(CONNECTION_A),
    });
  });

  it("is a no-op for a call with no controls at all", () => {
    expect(() => boundary({ id: CONNECTION_A }, undefined)).not.toThrow();
    expect(() => boundary(undefined, {})).not.toThrow();
  });
});

/**
 * The controls of an invocation reaching the credential boundaries NESTED
 * inside it.
 *
 * A binding on the platform-owned native transport runs a canonical Operation
 * in-process, and that Operation can open a Connection's credentials or invoke
 * a further declarative Service. Those are boundaries of the same invocation:
 * if they ran uncontrolled, `every-provider-call` would refuse nothing there
 * and the capture could name one Connection for a run that reached two. The
 * execution-boundary behaviour is in expected-connection.e2e.test.ts and
 * nested-connection-controls.unit.test.ts; this is the composition rule those
 * lean on.
 */
describe("controls that reach a nested invocation", () => {
  const record = (
    recorder: ReturnType<typeof createConnectionUseRecorder>,
    connectionId: string,
  ) =>
    recorder.record({
      session: session(),
      connectionTable: TABLE,
      connection: { id: connectionId },
    });

  it("is absent at the top level and gone again afterwards", async () => {
    expect(ambientConnectionControls()).toBeUndefined();
    const controls = inheritConnectionControls(undefined);
    expect(controls.expectedConnection).toBeUndefined();
    await withConnectionControls(controls, async () => {
      expect(ambientConnectionControls()).toBe(controls);
    });
    // The store is the invocation's dynamic extent, not a global: a later,
    // unrelated invocation must not inherit a finished one's expectation.
    expect(ambientConnectionControls()).toBeUndefined();
  });

  it("hands a nested invocation the expectation it cannot see", async () => {
    const outer = inheritConnectionControls(
      expectation(tenantReference(CONNECTION_A)),
    );
    await withConnectionControls(outer, async () => {
      // A nested caller that sets nothing — the ordinary case, and the gap:
      // without inheritance it would run with no expectation at all.
      const inner = inheritConnectionControls(undefined);
      expect(inner.expectedConnection).toEqual(outer.expectedConnection);
      // Confirming the same reference is allowed and changes nothing.
      expect(
        inheritConnectionControls(expectation(tenantReference(CONNECTION_A)))
          .expectedConnection,
      ).toEqual(outer.expectedConnection);
    });
  });

  it("refuses a nested invocation that names another Connection", async () => {
    // References are a deterministic function of one row's identity, so two
    // different strings name two different rows and no Connection satisfies
    // both. Refusing at the nested entry is before any provider effect of it.
    // The same holds of two ids, which are compared with their tenants.
    for (const [outer, inner] of [
      [
        expectation(tenantReference(CONNECTION_A)),
        expectation(tenantReference(CONNECTION_B)),
      ],
      [idExpectation(CONNECTION_A), idExpectation(CONNECTION_B)],
      [
        idExpectation(CONNECTION_A),
        idExpectation(CONNECTION_A, session({ tenantId: OTHER_TENANT_ID })),
      ],
    ] as const) {
      await withConnectionControls(
        inheritConnectionControls(outer),
        async () => {
          const refusal = (() => {
            try {
              inheritConnectionControls(inner);
              return undefined;
            } catch (error) {
              return error as { code?: string };
            }
          })();
          expect(refusal?.code).toBe(EXPECTED_CONNECTION_UNAVAILABLE_CODE);
        },
      );
    }
  });

  it("holds a nested invocation to both ways of naming a Connection", async () => {
    // The combination the two representations make possible: an outer
    // invocation bound by id and a nested one presenting the reference it
    // captured, or the reverse. Neither may be dropped and neither may be
    // preferred — a reference does not reveal the id it names, so the only
    // safe reading is that both must hold of the row at every boundary.
    const outer = inheritConnectionControls(idExpectation(CONNECTION_A));
    await withConnectionControls(outer, async () => {
      const inner = inheritConnectionControls(
        expectation(tenantReference(CONNECTION_A)),
      );
      expect(inner.expectedConnection?.requirements).toEqual([
        { by: "connection-id", tenantId: TENANT_ID, connectionId: CONNECTION_A },
        {
          by: "source-reference",
          sourceReference: tenantReference(CONNECTION_A),
        },
      ]);
      // Both name the same row, so that row passes...
      expect(() =>
        assertConnectionControls({
          controls: inner,
          session: session(),
          connectionTable: TABLE,
          connection: { id: CONNECTION_A },
        }),
      ).not.toThrow();
      // ...and no other row can.
      expect(() =>
        assertConnectionControls({
          controls: inner,
          session: session(),
          connectionTable: TABLE,
          connection: { id: CONNECTION_B },
        }),
      ).toThrow(REFUSAL);
    });
  });

  it("lets no row pass when the two namings disagree", async () => {
    // Fail closed rather than choose. The disagreement cannot be detected at
    // the nested entry — there is nothing to compare — so it lands at the
    // first credential boundary instead, which is still before any
    // Connection's credentials are read.
    const outer = inheritConnectionControls(idExpectation(CONNECTION_A));
    await withConnectionControls(outer, async () => {
      const inner = inheritConnectionControls(
        expectation(tenantReference(CONNECTION_B)),
      );
      for (const connection of [{ id: CONNECTION_A }, { id: CONNECTION_B }]) {
        expect(() =>
          assertConnectionControls({
            controls: inner,
            session: session(),
            connectionTable: TABLE,
            connection,
          }),
        ).toThrow(REFUSAL);
      }
      expect(inner.connectionUse!.used()).toEqual({
        outcome: "no-provider-call",
      });
    });
  });

  it("hands a nested invocation an inherited id expectation", async () => {
    const outer = inheritConnectionControls(idExpectation(CONNECTION_A));
    await withConnectionControls(outer, async () => {
      // Set nothing: the gap that made the ambient store necessary.
      expect(inheritConnectionControls(undefined).expectedConnection).toEqual(
        outer.expectedConnection,
      );
      // Confirming the same id changes nothing.
      expect(
        inheritConnectionControls(idExpectation(CONNECTION_A))
          .expectedConnection,
      ).toEqual(outer.expectedConnection);
    });
  });

  it("counts a nested Connection in the enclosing invocation's capture", async () => {
    const outer = inheritConnectionControls(undefined);
    record(outer.connectionUse!, CONNECTION_A);
    await withConnectionControls(outer, async () => {
      const inner = inheritConnectionControls(undefined);
      record(inner.connectionUse!, CONNECTION_B);
      // The nested invocation answers its own caller with what IT used.
      expect(inner.connectionUse!.used()).toEqual({
        outcome: "one-connection",
        sourceReference: tenantReference(CONNECTION_B),
      });
    });
    // And the enclosing invocation can no longer claim one account. This is
    // the false `one-connection` the sharing exists to prevent: a caller that
    // bound a paginated run to it would address the wrong account later.
    expect(outer.connectionUse!.used()).toEqual({
      outcome: "no-single-connection",
    });
  });

  it("leaves a capture naming one Connection when the nested call used it too", async () => {
    const outer = inheritConnectionControls(undefined);
    record(outer.connectionUse!, CONNECTION_A);
    await withConnectionControls(outer, async () => {
      record(inheritConnectionControls(undefined).connectionUse!, CONNECTION_A);
    });
    expect(outer.connectionUse!.used()).toEqual({
      outcome: "one-connection",
      sourceReference: tenantReference(CONNECTION_A),
    });
  });

  it("records a nested boundary nowhere when it refuses", async () => {
    const outer = inheritConnectionControls(
      expectation(tenantReference(CONNECTION_A)),
    );
    await withConnectionControls(outer, async () => {
      const inner = inheritConnectionControls(undefined);
      expect(() =>
        assertConnectionControls({
          controls: inner,
          session: session(),
          connectionTable: TABLE,
          connection: { id: CONNECTION_B },
        }),
      ).toThrow(REFUSAL);
      expect(inner.connectionUse!.used()).toEqual({
        outcome: "no-provider-call",
      });
    });
    expect(outer.connectionUse!.used()).toEqual({ outcome: "no-provider-call" });
  });

  it("keeps concurrent invocations' controls apart", async () => {
    const first = inheritConnectionControls(
      expectation(tenantReference(CONNECTION_A)),
    );
    const second = inheritConnectionControls(
      expectation(tenantReference(CONNECTION_B)),
    );
    const seen = await Promise.all([
      withConnectionControls(first, async () => {
        await Promise.resolve();
        return ambientConnectionControls();
      }),
      withConnectionControls(second, async () => {
        await Promise.resolve();
        return ambientConnectionControls();
      }),
    ]);
    expect(seen).toEqual([first, second]);
  });
});

/**
 * The capability advertisement a plugin reads BEFORE it sets the control.
 *
 * It is the only thing a caller can go on: a host that ignored
 * `expectedConnection` would run the invocation against whichever Connection
 * the session is authorized for and answer a success, indistinguishable from
 * an honoured expectation. So what matters here is that the advertisement
 * cannot say more than this core's own parser and checks do, and that nobody
 * downstream can restate it.
 */
describe("what this core advertises that it enforces", () => {
  it("advertises exactly the scopes its own parser admits", () => {
    expect(DECLARATIVE_CONNECTION_CAPABILITIES).toEqual({
      expectedConnection: ["every-provider-call"],
    });
    // Not a list that happens to agree today: every advertised scope must be
    // one an invocation may actually set, and a scope that is not advertised
    // must be refused rather than silently run with a weaker expectation. Both
    // representations are checked against the one advertisement, so a scope
    // could not come to be enforced for one of them only.
    for (const appliesTo of DECLARATIVE_CONNECTION_CAPABILITIES.expectedConnection) {
      expect(
        parseConnectionExpectation(
          { sourceReference: tenantReference(CONNECTION_A), appliesTo },
          session(),
        ),
      ).toEqual({
        requirements: [
          {
            by: "source-reference",
            sourceReference: tenantReference(CONNECTION_A),
          },
        ],
      });
      expect(
        parseConnectionExpectation(
          { connectionId: CONNECTION_A, appliesTo },
          session(),
        ),
      ).toEqual({
        requirements: [
          {
            by: "connection-id",
            tenantId: TENANT_ID,
            connectionId: CONNECTION_A,
          },
        ],
      });
    }
    for (const appliesTo of ["every-provider-call-ish", "first-provider-call", ""]) {
      expect(() =>
        parseConnectionExpectation(
          { sourceReference: tenantReference(CONNECTION_A), appliesTo },
          session(),
        ),
      ).toThrow(REFUSAL);
      expect(() =>
        parseConnectionExpectation(
          { connectionId: CONNECTION_A, appliesTo },
          session(),
        ),
      ).toThrow(REFUSAL);
    }
  });

  it("hands out a claim nobody can widen, shrink or rewrite", () => {
    // One frozen object, shared by reference with every plugin that reads it
    // from a platform service or an Operation context: a module that tried to
    // add a scope would otherwise be advertising a refusal nothing performs —
    // to every other module as well.
    expect(Object.isFrozen(DECLARATIVE_CONNECTION_CAPABILITIES)).toBe(true);
    expect(
      Object.isFrozen(DECLARATIVE_CONNECTION_CAPABILITIES.expectedConnection),
    ).toBe(true);
    const forged = DECLARATIVE_CONNECTION_CAPABILITIES as unknown as {
      expectedConnection: string[];
    };
    expect(() => forged.expectedConnection.push("first-provider-call")).toThrow();
    expect(() => {
      forged.expectedConnection = ["first-provider-call"];
    }).toThrow();
    expect(DECLARATIVE_CONNECTION_CAPABILITIES).toEqual({
      expectedConnection: ["every-provider-call"],
    });
  });

  it("accepts an engine's claim only for what this core enforces", () => {
    const accepted = parseDeclarativeConnectionCapabilities(
      DECLARATIVE_CONNECTION_CAPABILITIES,
    );
    expect(accepted).toEqual({ expectedConnection: ["every-provider-call"] });
    // A detached frozen copy: the registration result cannot be reached back
    // through the object the caller handed over.
    const claim = { expectedConnection: ["every-provider-call"] };
    const narrowed = parseDeclarativeConnectionCapabilities(claim);
    claim.expectedConnection.push("first-provider-call");
    expect(narrowed.expectedConnection).toEqual(["every-provider-call"]);
    expect(Object.isFrozen(narrowed)).toBe(true);
    expect(Object.isFrozen(narrowed.expectedConnection)).toBe(true);
    // An empty list is a host that enforces nothing, which is an honest claim.
    expect(parseDeclarativeConnectionCapabilities({ expectedConnection: [] }))
      .toEqual({ expectedConnection: [] });
  });

  it("refuses a claim this core cannot keep", () => {
    for (const claim of [
      undefined,
      null,
      "every-provider-call",
      [],
      [{ expectedConnection: [] }],
      {},
      { expectedConnection: "every-provider-call" },
      { expectedConnection: ["every-provider-call", "every-provider-call"] },
      { expectedConnection: ["first-provider-call"] },
      { expectedConnection: ["every-provider-call", "first-provider-call"] },
      { expectedConnection: [1] },
      // An extra key is a claim about something this core does not know, so it
      // is not read as a superset of one it does.
      {
        expectedConnection: ["every-provider-call"],
        expectedTenant: ["every-provider-call"],
      },
    ]) {
      expect(() => parseDeclarativeConnectionCapabilities(claim)).toThrow(
        /declarative Service engine/,
      );
    }
  });
});
