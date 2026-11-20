// SPDX-License-Identifier: BUSL-1.1
import type { GeneratedCrudAuthorization } from "./types.js";

/** Entity writers may read classified values; read-only grants do not suffice. */
export function canReadClassifiedColumns(
  authorization: GeneratedCrudAuthorization | undefined,
  session: { roles?: readonly string[] | null } | null | undefined,
): boolean {
  const roles = authorization?.roles;
  // Read once: a module session capability answers `roles` with a fresh
  // frozen copy per read, and this runs per row and column of a list.
  const held = session?.roles;
  if (!held?.length) return false;
  return [...(roles?.create ?? []), ...(roles?.update ?? []), ...(roles?.delete ?? [])]
    .some(role => held.includes(role));
}
