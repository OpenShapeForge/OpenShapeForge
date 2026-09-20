// SPDX-License-Identifier: BUSL-1.1
/** The tenant app's fields on top of the shared session augmentation. */
import "@openshapeforge/auth/session";

declare module "next-auth" {
  interface Session {
    tenantId: string;
    actorType: string;
    /**
     * Keycloak group paths the user belongs to. Forwarded to the API in
     * the trusted-context bundle and used by app-level group gates.
     */
    groups: string[];
  }
}
