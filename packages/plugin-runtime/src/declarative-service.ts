// SPDX-License-Identifier: BUSL-1.1
/**
 * The controls a plugin may set on ONE declarative Service invocation, what
 * core answers about the Connection that invocation used, and the failure
 * codes behind both.
 *
 * All of it exists for the same reason. A plugin that synchronizes records with
 * a provider holds a DURABLE identity for the account it synchronized from: the
 * records it queued carry provider ids that only mean anything in that one
 * account. The Connection behind an Adapter, however, is live configuration —
 * an administrator may retire it, replace it, or authorize a second one — and
 * ordinary selection answers with whichever Connection the live session is
 * authorized for NOW. Writing a queued record's provider ids through a
 * replacement would address the wrong account with the right credentials.
 *
 * `expectedConnection` is the opt-in that refuses exactly that. It never
 * selects, widens or revives authority: core authorizes the Connection for the
 * live session as it would without the expectation, and then refuses unless
 * the Connection it is about to read credentials from is the expected one.
 *
 * The expectation needs something to expect, and the durable one is core's own
 * reference, which a plugin cannot construct. So the two halves travel
 * together — core answers a successful invocation with `connectionUse`, which
 * names the Connection that invocation actually obtained provider credentials
 * from, as an expectation ready to present back. A run that reads its first
 * page without an expectation, keeps the answer with its queue state and
 * presents it on every later page is bound to one account from its second call
 * onwards, and fails closed the moment that account's Connection is no longer
 * the one in use.
 *
 * "From its second call onwards" is a gap, and the FIRST call is where the
 * records of a run are captured. Between reading the Connection it means to
 * synchronize from and invoking the Service, an administrator may replace that
 * Connection; the first page then executes against the replacement and stores
 * its records under the id of the Connection the sync believed it read. So the
 * expectation may also be set from the Connection's own id — the value a
 * caller already holds before it has any reference — scoped to the tenant of
 * the session presenting it. Same control, same refusal, one call earlier.
 *
 * None of it is a way to learn anything. A reference or an id that names no
 * Connection this session is authorized for simply refuses, with the same
 * answer as a Connection that was replaced, and `connectionUse` only ever
 * names a Connection the invocation already used under the caller's own
 * authority.
 */

/**
 * The explicit scope of an expectation. `every-provider-call`: every binding
 * of the Service that obtains Connection credentials must obtain them from the
 * expected Connection. A binding that would use any other Connection —
 * including a Connection on another Adapter — refuses the whole invocation.
 *
 * It covers the whole invocation, not only the Service's own bindings. A
 * binding on the platform-owned native transport runs a canonical Operation
 * in-process, and that Operation may itself open a Connection's credentials or
 * invoke a further declarative Service; those are credential boundaries of
 * this same invocation, and each of them is held to the same expectation. A
 * nested invocation may confirm the expectation — by presenting the same value
 * or by naming the same Connection the other way — and may not replace it with
 * another Connection.
 *
 * What it does NOT cover, because no expectation can: work a nested Operation
 * defers rather than performs. A durable job or queued outbox entry runs later,
 * under its own invocation, and carries no expectation from this one.
 *
 * Spelled out rather than implied so the scope can never widen silently: a
 * narrower or wider scope is a NEW value, never a changed meaning of this one,
 * and a value this host does not recognise refuses.
 */
export type RuntimeDeclarativeServiceConnectionExpectationScope =
  "every-provider-call";

/**
 * Bind one invocation to exactly the Connection a durable core-minted source
 * reference names.
 *
 * This is the representation a run carries between its pages: `connectionUse`
 * hands it back, and it commits more than an id does — the tenant, the scope,
 * the acting person for a personal scope, the connection table and the row.
 */
export type RuntimeDeclarativeServiceConnectionExpectationByReference = {
  /**
   * A reference core minted for that Connection (the `sourceReference` of an
   * authorized invocation source). Opaque, non-reversible and not
   * constructible by a plugin: it names a Connection only because core said
   * so, for this tenant and this scope.
   */
  sourceReference: string;
  appliesTo: RuntimeDeclarativeServiceConnectionExpectationScope;
};

/**
 * Bind one invocation to exactly the Connection of a given id, scoped to the
 * tenant of the session that presents it.
 *
 * This is for the one page a reference cannot cover: the FIRST. A sync reads
 * the Connection it is authorized to synchronize from, holds its id, and only
 * then invokes the Service — and an administrator may replace that Connection
 * in between, so the first page can run against the replacement and capture
 * its records under the id of the Connection the sync believed it read. Later
 * pages are covered by presenting what `connectionUse` returned; this covers
 * the first one, from an id the caller already holds.
 *
 * It is the same refusal as the reference variant and grants no more than it:
 * core resolves and authorizes Connections exactly as it would without an
 * expectation, then refuses unless the row whose credentials it is about to
 * read is this one. An id naming a Connection the session may not use refuses
 * identically to one that was replaced, so it discloses nothing. A malformed
 * id refuses rather than matching loosely.
 *
 * It commits the tenant and the row, and — unlike the reference — not the
 * scope or the connection table, which are properties of the row core resolved
 * rather than of this claim. A caller that needs those pinned as well presents
 * the reference its first page captured.
 */
export type RuntimeDeclarativeServiceConnectionExpectationById = {
  /** The Connection's own id, as the caller read it from that Connection. */
  connectionId: string;
  appliesTo: RuntimeDeclarativeServiceConnectionExpectationScope;
};

/**
 * Bind one invocation to exactly one Connection, named either way.
 *
 * Mutually exclusive by shape, and a host checks that: an expectation carrying
 * both naming keys, or neither, refuses rather than running with whichever one
 * the host happens to read. The expectation is verified where the credentials
 * are obtained, per binding, not only at an earlier validation step — so a
 * replacement that lands between validation and execution fails the invocation
 * closed rather than reaching the new account.
 */
export type RuntimeDeclarativeServiceConnectionExpectation =
  | RuntimeDeclarativeServiceConnectionExpectationByReference
  | RuntimeDeclarativeServiceConnectionExpectationById;

/**
 * What a host ENFORCES for `expectedConnection` — the signal a plugin reads
 * BEFORE it sets the control, never a post-call confirmation.
 *
 * The control is a refusal, so a host that silently ignored it would run the
 * invocation against whichever Connection the live session is authorized for
 * and answer `data` — success, in the wrong account. A caller cannot tell that
 * apart from an honoured expectation by looking at the result: both succeed,
 * and `connectionUse` is core's observation of the call it just made, not
 * proof that the control was armed before it. So the question has to be
 * answerable first, which is what this is.
 *
 * It advertises CAPABILITY, never permission and never a Connection: it says
 * what this runtime does with the control, nothing about what the caller may
 * reach. A denied invocation is still denied, identically, on a host that
 * advertises everything.
 *
 * Only a runtime whose declarative engine checks the expectation at every
 * credential boundary of every provider call publishes it. The whole property
 * is therefore absent on a host that predates the control — which is the point:
 * `undefined` is the answer "this host does not enforce it", and a plugin that
 * needs the control must refuse there rather than invoke the Service and hope.
 * Read it as a list, not a boolean: a scope missing from it is not enforced,
 * however the property's presence might suggest otherwise.
 */
export type RuntimeDeclarativeServiceCapabilities = {
  /**
   * The `appliesTo` scopes this runtime enforces, each at every credential
   * boundary of every provider call of the invocation. A scope absent here is
   * not enforced by this host, and an invocation that sets it is refused by
   * the same parser rather than run with a weaker expectation.
   */
  readonly expectedConnection: readonly RuntimeDeclarativeServiceConnectionExpectationScope[];
};

/**
 * What ONE invocation actually obtained Connection credentials from, as core
 * observed it at each credential boundary it crossed.
 *
 * It is an observation, never a selection or a promise: the next invocation
 * resolves and authorizes Connections exactly as this one did. Presenting
 * `expectedConnection` back is what turns the observation into a constraint.
 *
 * The three outcomes are exhaustive and deliberately distinct, because only
 * the first one is an identity a caller may bind to. Core reports one
 * Connection only when every provider call of the invocation obtained its
 * credentials from that Connection — the same condition the returned
 * expectation would have been checked against had it been set on this
 * invocation. A Service whose bindings span two accounts, or a Connection
 * core cannot name for this session, is reported as what it is rather than
 * collapsed into one of them.
 */
export type RuntimeDeclarativeServiceConnectionUse =
  /**
   * Every provider call obtained its credentials from one Connection, and
   * this is the expectation that names it. Present it verbatim on a later
   * invocation of the same run.
   *
   * Always the core-minted reference form, whichever way the invocation that
   * produced it named its own expectation: a captured answer is the durable
   * identity of a run, so it commits the scope and the connection table too.
   *
   * "Every provider call" includes the ones a native binding's canonical
   * Operation made in-process, so a Service that reads from one account and
   * synchronizes through an Operation that reaches a second is reported as
   * `no-single-connection` rather than as either of them.
   */
  | {
      outcome: "one-connection";
      expectedConnection: RuntimeDeclarativeServiceConnectionExpectationByReference;
    }
  /**
   * Provider credentials were obtained, but not all from one Connection core
   * can name: the Service's bindings used more than one (two Adapters, say, or
   * a personal and an organization Connection), or one of them has no identity
   * for this session. There is no single account to bind a run to, so a caller
   * that needs one must refuse rather than pick.
   */
  | { outcome: "no-single-connection" }
  /**
   * No binding obtained Connection credentials at all — every binding that
   * ran was the platform-owned native transport, which executes a canonical
   * Operation in-process under the caller's own session. Nothing external was
   * addressed, so there is no provider account to name.
   */
  | { outcome: "no-provider-call" };

/**
 * The invocation did not run against the expected Connection: it was retired,
 * replaced, the Service would have used another one, or the expectation was
 * not one this session could resolve at all — a malformed id, an id of another
 * tenant, a reference nobody minted, a shape this host does not recognise.
 * Never retryable, and deliberately indistinguishable between those cases.
 */
export const RUNTIME_EXPECTED_CONNECTION_UNAVAILABLE_CODE =
  "EXPECTED_CONNECTION_UNAVAILABLE" as const;

/** The code above, for a caller that switches on a declarative failure. */
export type RuntimeDeclarativeServiceFailureCode =
  typeof RUNTIME_EXPECTED_CONNECTION_UNAVAILABLE_CODE;
