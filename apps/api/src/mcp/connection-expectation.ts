// SPDX-License-Identifier: BUSL-1.1
import { isDelegatedConnection } from "./connection-delegation.js";
/**
 * The expected-Connection control of one declarative Service invocation, and
 * the capture that gives a caller something to expect.
 *
 * A caller that holds a durable identity for the provider account it
 * synchronized from may demand that THIS invocation runs against exactly that
 * Connection (`RuntimeDeclarativeServiceRequest.expectedConnection`). The
 * control is a REFUSAL, never a selection: Connections are resolved and
 * authorized for the live session exactly as they are without it, and the
 * expectation then refuses the invocation unless the Connection whose
 * credentials are about to be read is the expected one.
 *
 * The capture (`ConnectionUseRecorder`) is the same event, read rather than
 * judged: at each credential boundary it records the identity of the row whose
 * credentials the call is about to use, and afterwards answers whether that
 * was ONE Connection. Both sides derive the identity from the same row with
 * the same function below, which is what makes the answer usable: a reference
 * captured at a boundary is, by construction, one the expectation check at
 * that same boundary accepts. A caller therefore needs no precheck and no MCP
 * invocation context — it reads its first page, keeps the answer, and presents
 * it back on every later page of the run.
 *
 * Three properties the placement of the check carries, and which a check in
 * only one place would lose:
 *
 *   - It is verified where the credentials are obtained, per binding
 *     (dispatch-tenant-connection.ts, dispatch-personal-connection.ts), so a
 *     replacement that lands between an earlier validation and the provider
 *     call cannot reach the new account.
 *   - A composed call is checked once over its captured steps BEFORE the first
 *     binding runs (dispatch-derived-tool.ts), so a gap known up front never
 *     becomes a half-done call with one write in the wrong account.
 *   - Nothing here reads or writes the database and nothing is held across the
 *     provider call: the comparison is over rows the caller's own authorized
 *     resolution already produced.
 *
 * NESTING is the fourth, and the reason the controls live in an
 * ambient core-owned store rather than only in one call's arguments. A
 * binding on the platform-owned native transport runs a canonical Operation
 * in-process, and that Operation may open a Connection's credentials
 * (`modules/connection-secrets.ts`) or invoke another declarative Service of
 * its own. Those are credential boundaries of the SAME invocation: a scope
 * that said "every provider call" while ignoring them would be a refusal
 * nothing performs, and a capture that ignored them could name one Connection
 * for an invocation that reached two. So the controls travel for the whole
 * dynamic extent of the invocation, and every nested boundary is checked
 * against the same expectation and recorded into the same run of the capture.
 *
 * A caller names the Connection it demands in one of two ways, and both are
 * resolved against the row at the boundary rather than used to select it:
 *
 *   - the core-minted, non-reversible invocation source reference
 *     (modules/source-reference.ts). It commits the tenant, the scope, the
 *     acting person for a personal scope, the connection table and the
 *     connection ROW — so a different tenant's Connection, another person's
 *     personal Connection, a replacement row holding the very same
 *     credentials, and a forged reference all simply fail to match. This is
 *     what `ConnectionUseRecorder` hands back, so it is what a run presents on
 *     its second and every later page.
 *   - the Connection's own id, scoped to the tenant of the session that
 *     presented it. This exists for the page a reference cannot cover: the
 *     FIRST one. A sync reads the Connection it is authorized to synchronize
 *     from, holds that id, and only then invokes the Service — and between
 *     those two moments an administrator may replace the Connection, so the
 *     first page can execute against a replacement and capture its records
 *     under the id of the Connection the sync believed it read. An id the
 *     caller already holds closes exactly that window, and nothing more: it
 *     authorizes nothing, selects nothing, and a malformed id refuses rather
 *     than matching loosely. Unlike the reference it commits the tenant and
 *     the ROW only — the scope and the connection table of the boundary are
 *     properties of the row the resolution produced, not of the caller's
 *     claim — so a caller that needs those pinned too presents the reference
 *     the first page captured.
 *
 * The refusal is one answer for every one of those cases: it tells the caller
 * to resolve its sync identity, and it tells it nothing about which
 * Connections exist.
 *
 * The two never widen each other. An expectation is a CONJUNCTION of the
 * requirements the invocation and its enclosing invocations set, each resolved
 * against the one row at each boundary, so adding a requirement can only
 * shrink the set of rows that pass. Two representations that name the same row
 * both pass; two that name different rows leave no row able to pass, which is
 * the fail-closed answer rather than a choice between them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ownedByActingRelation } from "../db/acting-relation.js";
import { HttpError } from "../rest/http-error.js";
import {
  mintInvocationSourceReference,
  sameInvocationSourceReference,
} from "../modules/source-reference.js";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import type { RuntimeDeclarativeServiceCapabilities } from "@openshapeforge/plugin-runtime";

/**
 * One way a caller names the Connection it demands, as core reads it.
 *
 * `connection-id` carries the tenant of the session that presented the id, not
 * the id alone. The id is a caller-supplied value rather than a core-minted
 * one, so the tenant it was scoped to is pinned at the moment it is read and
 * compared against the tenant of the row at the boundary — a session acting in
 * another tenant cannot satisfy it with a row of the same id, however the
 * expectation reached that session.
 */
type ConnectionRequirement =
  | { readonly by: "source-reference"; readonly sourceReference: string }
  | {
      readonly by: "connection-id";
      readonly tenantId: string;
      readonly connectionId: string;
    };

/**
 * A parsed, frozen expectation: every requirement in it must hold of the one
 * row at each credential boundary. Only `parseConnectionExpectation` mints one
 * (with exactly one requirement) and only `inheritConnectionControls` composes
 * two, which is what keeps the list a conjunction that can never widen.
 *
 * At most one requirement per representation: composing two of the same
 * representation either finds them identical, and keeps one, or finds them
 * naming different rows, and refuses there.
 */
export type ConnectionExpectation = {
  readonly requirements: readonly ConnectionRequirement[];
};

/**
 * RFC 4122 shape, the one every id this host accepts has (`db/session.ts`
 * holds the canonical pattern for the layer that reads rows by id; a
 * connection id is a `uuid` column there). A caller-supplied id is checked
 * against it before anything compares it, so a malformed or empty id refuses
 * rather than reaching a comparison it could never win.
 */
const CONNECTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The one list of expectation scopes this core enforces.
 *
 * `parseConnectionExpectation` admits exactly these and the capability
 * advertisement publishes exactly these, from this single constant — so a host
 * can never advertise a scope its own parser refuses, nor enforce one it never
 * advertised. Adding a scope is adding a value here AND the per-binding check
 * that makes it true; nothing else may widen it.
 */
const ENFORCED_EXPECTATION_SCOPES = ["every-provider-call"] as const;

/**
 * What this build enforces, in the shape a plugin reads before it sets
 * `expectedConnection`.
 *
 * Deep-frozen at module scope and handed out by reference: a plugin that
 * reaches it through a platform service or an Operation context cannot grow,
 * shrink or rewrite the advertisement for anyone — itself included. It is
 * published only by the runtime that registered the engine carrying it
 * (mcp/runtime-executors.ts, modules/platform.ts), so its presence is the
 * engine's own claim rather than a constant this file exports to everybody.
 */
export const DECLARATIVE_CONNECTION_CAPABILITIES: RuntimeDeclarativeServiceCapabilities =
  Object.freeze({
    expectedConnection: Object.freeze([...ENFORCED_EXPECTATION_SCOPES]),
  });

/**
 * Accept a capability advertisement a registered engine carries, or refuse the
 * registration.
 *
 * Core trusts only its own enforcement, not a shape: a host wiring that hands
 * over an engine claiming a scope this build has no check for would make the
 * published signal a lie, and a plugin reads that signal INSTEAD of a
 * post-call confirmation. So the claim is narrowed against
 * `ENFORCED_EXPECTATION_SCOPES` and a surprising one stops boot.
 */
export function parseDeclarativeConnectionCapabilities(
  raw: unknown,
): RuntimeDeclarativeServiceCapabilities {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("A declarative Service engine must carry its capabilities.");
  }
  const keys = Object.keys(raw as Record<string, unknown>);
  const scopes = (raw as { expectedConnection?: unknown }).expectedConnection;
  if (
    keys.length !== 1 ||
    keys[0] !== "expectedConnection" ||
    !Array.isArray(scopes) ||
    new Set(scopes).size !== scopes.length ||
    !scopes.every((scope) =>
      (ENFORCED_EXPECTATION_SCOPES as readonly unknown[]).includes(scope),
    )
  ) {
    throw new Error(
      "A declarative Service engine may only advertise expected-Connection scopes " +
        `this core enforces (${ENFORCED_EXPECTATION_SCOPES.join(", ")}).`,
    );
  }
  return Object.freeze({ expectedConnection: Object.freeze([...scopes]) });
}

export const EXPECTED_CONNECTION_UNAVAILABLE_CODE = "EXPECTED_CONNECTION_UNAVAILABLE";

/**
 * The one refusal. A conflict rather than a not-found: the caller is
 * authenticated and authorized, and what has to be resolved is the durable
 * identity it presented. Deliberately the same answer whether the expected
 * Connection was retired, replaced, named in another tenant, malformed or
 * never this session's to use — and the same for either representation, so
 * which one was presented reveals nothing about what exists.
 */
export function expectedConnectionUnavailable(): HttpError {
  return new HttpError(
    409,
    EXPECTED_CONNECTION_UNAVAILABLE_CODE,
    "This invocation requires exactly the Connection its expectation names; " +
      "that is not the Connection it would run against. Resolve the stored " +
      "source identity before retrying.",
  );
}

/**
 * Whether a failure IS that refusal, for the one caller that must not treat it
 * as an ordinary step failure: a binding declared `optional` absorbs an
 * unavailable source, and this is not one (dispatch-derived-binding.ts).
 *
 * Narrow on purpose. Only `expectedConnectionUnavailable` builds this error, so
 * matching the core error type with the core code recognises exactly what core
 * threw — a module that returns or rethrows something of its own carrying the
 * same code is not it, and is handled like any other failure.
 */
export function isExpectedConnectionUnavailable(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.code === EXPECTED_CONNECTION_UNAVAILABLE_CODE
  );
}

/**
 * Read the caller's `expectedConnection` as core's own control, or refuse.
 *
 * Closed on purpose: an unknown scope value, an unknown key, a missing one, or
 * both naming keys at once refuses rather than running with a weaker
 * expectation than the caller believes it set. The two representations are
 * mutually exclusive by shape — exactly `appliesTo` plus exactly one of them —
 * so a caller cannot present an id a host reads and a reference it ignores.
 *
 * `session` is the live session the expectation arrived on, and is what scopes
 * a presented Connection id to its tenant. A session with no tenant can scope
 * no id and is refused; the reference representation carries its own tenant
 * and does not need one.
 */
export function parseConnectionExpectation(
  raw: unknown,
  session: TrustedSessionContext,
): ConnectionExpectation | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw expectedConnectionUnavailable();
  }
  const candidate = raw as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "appliesTo" ||
    !(ENFORCED_EXPECTATION_SCOPES as readonly unknown[]).includes(candidate.appliesTo)
  ) {
    throw expectedConnectionUnavailable();
  }
  if (
    keys[1] === "sourceReference" &&
    typeof candidate.sourceReference === "string" &&
    candidate.sourceReference.length > 0
  ) {
    return oneRequirement({
      by: "source-reference",
      sourceReference: candidate.sourceReference,
    });
  }
  if (
    keys[1] === "connectionId" &&
    typeof candidate.connectionId === "string" &&
    CONNECTION_ID_PATTERN.test(candidate.connectionId) &&
    session.tenantId
  ) {
    return oneRequirement({
      by: "connection-id",
      tenantId: session.tenantId,
      connectionId: candidate.connectionId,
    });
  }
  throw expectedConnectionUnavailable();
}

function oneRequirement(requirement: ConnectionRequirement): ConnectionExpectation {
  return Object.freeze({
    requirements: Object.freeze([Object.freeze(requirement)]),
  });
}

/** One connection row, as the live session identifies it. */
type ConnectionInContext = {
  session: TrustedSessionContext;
  connectionTable: string;
  connection: Record<string, unknown> | undefined;
};

/**
 * The core-minted reference for one connection row under this session, or
 * `undefined` when this host cannot name the row at all.
 *
 * The one derivation both sides use. It is exactly how
 * invocation-source-resolution.ts derives the identity when it mints a source
 * reference, so none of the three can drift: the acting person's ownership
 * decides the scope, and a session without a tenant — or a personal row under
 * a session with no verified person — has no identity to mint.
 */
function connectionSourceReference(input: ConnectionInContext): string | undefined {
  const { connection, session } = input;
  const connectionId = connection?.id;
  if (
    !session.tenantId ||
    typeof connectionId !== "string" ||
    connectionId.length === 0
  ) {
    return undefined;
  }
  const personal = isDelegatedConnection(session, input.connectionTable, connection) || ownedByActingRelation(connection?.ownerUserId, session);
  if (personal && !session.userId) return undefined;
  try {
    return mintInvocationSourceReference({
      tenantId: session.tenantId,
      actorId: personal ? session.userId : null,
      scope: personal ? "personal" : "tenant",
      connectionTable: input.connectionTable,
      connectionId,
    });
  } catch {
    // An identity this host cannot even express has no reference.
    return undefined;
  }
}

/**
 * Whether one requirement holds of the row this boundary is about to use,
 * whose own identity under this session is `actual`.
 *
 * Both representations end in the same comparison over the same derivation,
 * which is what keeps one notion of identity in this module. For a presented
 * id that means minting the identity that id WOULD have at this very boundary
 * — the row's own scope, acting person and connection table, under the tenant
 * the id was scoped to — and comparing it with the actual row's. So the id
 * variant accepts exactly: same tenant, same row. An id this host cannot even
 * express an identity for does not match.
 */
function requirementHolds(
  requirement: ConnectionRequirement,
  input: ConnectionInContext,
  actual: string,
): boolean {
  if (requirement.by === "source-reference") {
    return sameInvocationSourceReference(requirement.sourceReference, actual);
  }
  const claimed = connectionSourceReference({
    session: { ...input.session, tenantId: requirement.tenantId },
    connectionTable: input.connectionTable,
    connection: { ...input.connection, id: requirement.connectionId },
  });
  return claimed !== undefined && sameInvocationSourceReference(claimed, actual);
}

/**
 * Whether one connection row IS the expected Connection for this session. A
 * row this host cannot name is not a match, and neither is a row that fails
 * any one of the expectation's requirements — an expectation with nothing to
 * demand least of all.
 */
export function connectionMatchesExpectation(
  input: ConnectionInContext & { expectation: ConnectionExpectation },
): boolean {
  const minted = connectionSourceReference(input);
  if (minted === undefined) return false;
  const { requirements } = input.expectation;
  return (
    requirements.length > 0 &&
    requirements.every((requirement) =>
      requirementHolds(requirement, input, minted),
    )
  );
}

/** Refuse unless the connection about to be used is the expected one. */
export function assertExpectedConnection(
  input: ConnectionInContext & {
    expectation: ConnectionExpectation | undefined;
  },
): void {
  if (!input.expectation) return;
  if (
    !connectionMatchesExpectation({
      expectation: input.expectation,
      session: input.session,
      connectionTable: input.connectionTable,
      connection: input.connection,
    })
  ) {
    throw expectedConnectionUnavailable();
  }
}

/**
 * What one invocation obtained Connection credentials from. The host's shape
 * of RuntimeDeclarativeServiceConnectionUse; `one-connection` carries the bare
 * reference, and the caller that answers a plugin wraps it in the published
 * expectation shape.
 */
export type ConnectionUse =
  | { outcome: "one-connection"; sourceReference: string }
  | { outcome: "no-single-connection" }
  | { outcome: "no-provider-call" };

/**
 * Collects the Connections ONE invocation obtains credentials from.
 *
 * Created by the caller that needs the answer and carried in the call's
 * closure, never through module input or a module-visible result: an
 * interceptor can neither read, write nor drop it, so the answer is core's
 * own observation rather than something a module can assert.
 *
 * It records at the credential boundary, where `assertExpectedConnection`
 * refuses — the moment a Connection's values are about to be read, refreshed
 * and sent. That is deliberately earlier than the provider's reply: a binding
 * whose call then fails has still reached for that account, and an optional
 * binding that swallows the failure must not leave the invocation looking as
 * if only one account was involved. The capture errs towards
 * `no-single-connection`, never towards naming one Connection that was not
 * alone.
 */
export type ConnectionUseRecorder = {
  /** Record the row whose credentials a provider call is about to use. */
  record(input: ConnectionInContext): void;
  /** What the invocation used, read once it is over. */
  used(): ConnectionUse;
};

/**
 * A recorder for one invocation, optionally feeding the ENCLOSING invocation's
 * recorder as well.
 *
 * A nested invocation answers its own caller with what it alone used, so it
 * needs its own set. But the credential boundary it crosses is also a boundary
 * of the invocation that contains it, so the same observation goes to the
 * parent: an inner call that reaches a second account is what turns the outer
 * answer into `no-single-connection`, instead of leaving it naming one
 * Connection the invocation was not alone in using. The parent is core's own
 * recorder from the ambient store, never anything module code supplied.
 */
export function createConnectionUseRecorder(
  parent?: ConnectionUseRecorder,
): ConnectionUseRecorder {
  const references = new Set<string>();
  let unidentified = false;
  return {
    record(input) {
      parent?.record(input);
      const reference = connectionSourceReference(input);
      if (reference === undefined) {
        // Credentials were obtained from a row this host cannot name. That is
        // not "no provider call", and it is not an identity either.
        unidentified = true;
        return;
      }
      references.add(reference);
    },
    used() {
      if (references.size === 0) {
        return unidentified
          ? { outcome: "no-single-connection" }
          : { outcome: "no-provider-call" };
      }
      if (unidentified || references.size > 1) {
        return { outcome: "no-single-connection" };
      }
      return {
        outcome: "one-connection",
        sourceReference: [...references][0]!,
      };
    },
  };
}

/**
 * Core's own controls over the Connections of ONE call: the caller's
 * expectation and core's record of what was used.
 *
 * Never module input and never part of a module-visible result. They travel
 * two ways, both core's: in the call's own closure (mcp/tool-dispatch.ts), and
 * in the ambient store below for the credential boundaries the call's
 * arguments do not reach. An interceptor can set, read or drop neither.
 */
export type ConnectionControls = {
  /** Refuse unless every provider call uses exactly this Connection. */
  expectedConnection?: ConnectionExpectation;
  /** Collects the Connection(s) the provider calls actually used. */
  connectionUse?: ConnectionUseRecorder;
};

/**
 * The whole credential boundary, in one call: refuse unless this row is the
 * expected Connection, and — having passed — record it as a Connection this
 * invocation uses.
 *
 * One function so the two cannot be applied to different rows or in the wrong
 * order. A refusal records nothing: an invocation that never reached an
 * account must not report having used one.
 */
export function assertConnectionControls(
  input: ConnectionInContext & { controls: ConnectionControls | undefined },
): void {
  const { controls, ...connection } = input;
  assertExpectedConnection({
    ...connection,
    expectation: controls?.expectedConnection,
  });
  controls?.connectionUse?.record(connection);
}

/**
 * The controls of the declarative invocation this code is running inside.
 *
 * Core-owned and module-invisible: the store is private to this module, the
 * values are placed only by `withConnectionControls` at an invocation's own
 * entry, and nothing exported here lets a caller write one. Its reach is the
 * invocation's dynamic extent, which is exactly what the `every-provider-call`
 * scope means — a native binding's canonical Operation, anything that
 * Operation opens a Connection for, and any further declarative Service it
 * invokes, are all inside the invocation that set the control.
 *
 * Work a nested Operation DEFERS instead of doing — a durable job, a queued
 * outbox entry — runs later under its own invocation and its own session, and
 * is deliberately not reached: it is not a provider call of this invocation,
 * and binding it to this invocation's expectation would claim a guarantee this
 * store cannot keep.
 */
const activeConnectionControls = new AsyncLocalStorage<ConnectionControls>();

/** Run one invocation with its controls in force for everything it reaches. */
export function withConnectionControls<T>(
  controls: ConnectionControls,
  work: () => Promise<T>,
): Promise<T> {
  return activeConnectionControls.run(controls, work);
}

/**
 * The enclosing invocation's controls, for a credential boundary that is not
 * reached through its own call arguments. `undefined` at the top level, which
 * is the ordinary case and means there is nothing to enforce or record.
 */
export function ambientConnectionControls(): ConnectionControls | undefined {
  return activeConnectionControls.getStore();
}

/**
 * The controls for an invocation that may be nested: the enclosing
 * invocation's expectation and capture, narrowed by this invocation's own
 * request.
 *
 * An inherited expectation is never dropped and never widened. A nested caller
 * that presents a different value of the SAME representation cannot be
 * satisfied — each is a deterministic function of one row's identity, so two
 * different values name two different rows and no single Connection matches
 * both — and that is refused here, at the nested invocation's entry, before
 * any provider effect of it. A nested caller that presents the same value, or
 * none, runs under the inherited one.
 *
 * A nested caller that presents the OTHER representation is held to both. The
 * two cannot be compared with each other — a reference does not reveal the id
 * it names — so neither may be dropped and neither may be preferred: the row
 * at each credential boundary is resolved against both, and only a row that is
 * the one each of them names passes. Two that name different rows therefore
 * leave every boundary refusing, which is the same fail-closed outcome one
 * step later than the entry, and still before any Connection's credentials are
 * read.
 */
export function inheritConnectionControls(
  requested: ConnectionExpectation | undefined,
): ConnectionControls {
  const inherited = activeConnectionControls.getStore();
  const expectedConnection = narrowedExpectation(
    inherited?.expectedConnection,
    requested,
  );
  return {
    ...(expectedConnection ? { expectedConnection } : {}),
    connectionUse: createConnectionUseRecorder(inherited?.connectionUse),
  };
}

function narrowedExpectation(
  inherited: ConnectionExpectation | undefined,
  requested: ConnectionExpectation | undefined,
): ConnectionExpectation | undefined {
  if (!inherited) return requested;
  if (!requested) return inherited;
  const requirements = [...inherited.requirements];
  for (const candidate of requested.requirements) {
    // At most one requirement per representation, so this finds the only one
    // the candidate could be comparable with.
    const held = requirements.find((one) => one.by === candidate.by);
    if (!held) {
      requirements.push(candidate);
      continue;
    }
    if (!sameRequirement(held, candidate)) throw expectedConnectionUnavailable();
  }
  return Object.freeze({ requirements: Object.freeze(requirements) });
}

/**
 * Whether two requirements of the same representation name the same row.
 * Comparable only within a representation: across the two there is nothing to
 * compare, and `narrowedExpectation` keeps both instead.
 */
function sameRequirement(
  left: ConnectionRequirement,
  right: ConnectionRequirement,
): boolean {
  if (left.by === "source-reference" && right.by === "source-reference") {
    return sameInvocationSourceReference(
      left.sourceReference,
      right.sourceReference,
    );
  }
  if (left.by === "connection-id" && right.by === "connection-id") {
    return (
      left.tenantId === right.tenantId &&
      left.connectionId === right.connectionId
    );
  }
  return false;
}
