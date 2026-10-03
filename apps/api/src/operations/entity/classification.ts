// SPDX-License-Identifier: BUSL-1.1
import type { GeneratedCrudAuthorization } from "./types.js";

/** Entity writers may read classified values; read-only grants do not suffice. */
export function canReadClassifiedColumns(
  authorization: GeneratedCrudAuthorization | undefined,
  session: { roles?: readonly string[] | null } | null | undefined,
): boolean {
  const roles = authorization?.roles;
  return [...(roles?.create ?? []), ...(roles?.update ?? []), ...(roles?.delete ?? [])]
    .some(role => session?.roles?.includes(role));
}
