// SPDX-License-Identifier: BUSL-1.1
/**
 * The host's answer to "who is this session", for runtime modules.
 *
 * A module that acts for an external application needs the application's
 * identity for three things authorization does not provide: the namespace its
 * idempotency keys live in, the provenance it stores on the rows it writes,
 * and the actor on the event it appends. Every one of those must survive a
 * hostile caller, so none of them may be read from request input — not a
 * header, not a path parameter, not a key id a client happens to know.
 *
 * So the module asks the host, and the host answers from
 * {@link resolvePrincipalClass}: the same server-sourced classification the
 * record-action axis matches its subjects against. One derivation, one answer,
 * no second opinion for a module to drift from.
 *
 * Two properties make this safe to hand to plugin code:
 *
 *   - it is the LIVE session or nothing. A module can construct an object
 *     shaped like a session and put any integration id on it; `acceptsSession`
 *     refuses it, because the only object that passes is the one core handed
 *     to this invocation. That object is itself a detached, deeply frozen
 *     snapshot (`createModuleSessionCapability`), so the module cannot reach
 *     the answer by editing the session it was legitimately given either —
 *     `appPrincipal` is not the object core holds, and it is not writable;
 *   - it authorizes nothing. The answer is an identity, never a permission. A
 *     module that needs to know whether it MAY do something asks the record
 *     services, whose policy lives in core.
 */
import type {
  RuntimeApplicationPrincipal,
  RuntimePrincipalClass,
  RuntimePrincipalServices,
} from "@openshapeforge/plugin-runtime";
import { operationFailure } from "@openshapeforge/operations";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { resolvePrincipalClass, UUID_PATTERN } from "../db/session.js";

function refusal(): never {
  throw operationFailure({
    code: "FORBIDDEN",
    message: "Principal classification requires the live verified session.",
    retryable: false,
  });
}

/** Core-only classification of the live verified session. */
export class PrincipalRuntime {
  readonly services: RuntimePrincipalServices<TrustedSessionContext>;

  constructor(options: { acceptsSession(session: TrustedSessionContext): boolean }) {
    this.services = Object.freeze({
      classOf: (session: TrustedSessionContext): RuntimePrincipalClass => {
        if (!options.acceptsSession(session)) refusal();
        return resolvePrincipalClass(session);
      },
      application: (
        session: TrustedSessionContext,
      ): RuntimeApplicationPrincipal | undefined => {
        if (!options.acceptsSession(session)) refusal();
        // The class, not the field: a carrier that somehow produced an
        // `appPrincipal` without being classified as an application is a bug
        // in the credential layer, and this is the wrong place to honour it.
        if (resolvePrincipalClass(session) !== "application") return undefined;
        const integrationId = session.appPrincipal?.integrationId;
        // The resolver reads a uuid primary key. Anything else means some
        // other path invented a principal, which must not become a namespace
        // or an audited actor.
        if (!integrationId || !UUID_PATTERN.test(integrationId)) refusal();
        return Object.freeze({ integrationId });
      },
    });
  }
}
