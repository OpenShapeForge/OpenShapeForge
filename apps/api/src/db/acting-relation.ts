// SPDX-License-Identifier: BUSL-1.1
/**
 * The Relation a session acts as. The one implementation lives in
 * @openshapeforge/plugin-runtime so plugins record "…door" fields exactly as
 * the host's owner policies compare them (#937); re-exported here for the
 * host's callers.
 */
export { actingRelationId, ownedByActingRelation, type ActingRelationSource } from "@openshapeforge/plugin-runtime/acting-relation";
