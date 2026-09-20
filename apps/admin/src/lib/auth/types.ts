// SPDX-License-Identifier: BUSL-1.1
/**
 * The control plane's fields on top of the shared session augmentation.
 *
 * Deliberately NO `tenantId`, `actorType` or `groups`: control-realm tokens
 * carry no `tid` claim and the realm authors no groups, so any code that
 * reaches for a tenant here is a compile error instead of an empty string that
 * type-checks, renders, and is wrong.
 */
import "@openshapeforge/auth/session";

declare module "next-auth" {
  interface Session {
    /**
     * True when `roles` contains `platform-operator`. Authenticating against
     * the control realm is NOT authorization to use the control plane — this
     * is. See `src/lib/server/route-authz.ts` for the gate that enforces it.
     */
    isPlatformOperator: boolean;
  }
}
