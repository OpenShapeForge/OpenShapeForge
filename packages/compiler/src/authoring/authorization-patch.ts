// SPDX-License-Identifier: BUSL-1.1
/**
 * `kind: authorizationPatch` — overlaying a realm file from an earlier layer.
 *
 * A host that consumes the compiler as a package inherits the base
 * `authorization.yaml` and, until this existed, had two ways to change one
 * thing in it: ship a full replacement (refused — "Layer collision on
 * authorization.yaml") or ship a second realm file (refused — two documents
 * cannot claim the same realm). Renaming the entity-role client, adding a
 * client, or granting a realm role one more composite therefore meant a fork
 * of the whole file, kept in step with the base by hand.
 *
 * The patch sits at the SAME relative path as the realm file it targets
 * (`authorization.yaml` patches `authorization.yaml`,
 * `authorization.control.yaml` patches `authorization.control.yaml`) and
 * declares `kind: authorizationPatch`. Path-targeted like `appShellPatch`:
 * realm files are discovered by filename, so the filename is the one handle an
 * overlay author can predict.
 *
 * Semantics, applied in this order:
 *
 *   1. `renameClient: { from, to }` rewrites every REFERENCE to a client id in
 *      the base document — `keycloak.entityRoleClient`, `keycloak.clients[].id`,
 *      the client keys of `realmRoles.*.composites`, `clientRoles`,
 *      `users[].clientRoles` and `serviceAccountClientRoles`. It moves the
 *      identity only; the client's `name`, `secret` and `devSecret` are
 *      ordinary fields the patch body sets under the NEW id.
 *   2. The rest of the body strategic-merges onto the (renamed) base: objects
 *      deep-merge, `null` deletes a property, `keycloak.clients[]` merges by
 *      `id` (`$delete: true` removes one), other arrays replace wholesale —
 *      except role-name lists (`clientRoles.<client>`,
 *      `realmRoles.<role>.composites.<client>`, `realmRoles.<role>.includes`),
 *      which UNION: base order first, patch additions appended. A grant list
 *      is a set, and "add one composite" restating fifteen others is how a
 *      grant silently goes missing.
 *   3. The merged document is validated as an `authorizationConfig`, so a
 *      patch that produces an unusable realm fails here, naming the patch,
 *      rather than in the generator naming the merged file nobody wrote.
 *
 * A role-name list may only narrow relative to what an earlier layer already
 * declared at that exact path — `assertAuthorizationGrantsOnlyNarrow`, called
 * from the layer resolver right after each patch is applied, the same point
 * `assertCrudPolicyOnlyNarrows` checks `entityPatch`'s CRUD exposure. Adding
 * to a list an earlier layer already has is refused; adding to a path no
 * earlier layer declared (a brand-new grant) is not. See that function for
 * the null-then-readd escape hatch.
 */
import { authoringValidator } from "./schema-validation.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export const AUTHORIZATION_PATCH_KIND = "authorizationPatch";

/**
 * Filenames the Keycloak generator reads as realm authoring, at the root of
 * the resolved tree: `authorization.yaml` and `authorization.<realm>.yaml`.
 * Kept in step with `generate-keycloak-artifacts.ts`; a patch anywhere else
 * would be merged into a file the generator never opens.
 */
export const AUTHORIZATION_FILENAME_RE = /^authorization(\.[^.]+)*\.yaml$/;

export function isAuthorizationFilePath(relativePath: string): boolean {
  return !relativePath.includes("/") && AUTHORIZATION_FILENAME_RE.test(relativePath);
}

/**
 * Top-level keys a patch body may carry: every authorizationConfig section
 * plus the rename directive. `schemaVersion` is deliberately absent — the
 * base's version is the document's version, and a patch that bumped it would
 * change how every field of the base is read.
 */
const PATCH_BODY_KEYS = new Set([
  "renameClient",
  "realm",
  "keycloak",
  "realmRoles",
  "clientRoles",
  "groups",
  "users",
]);

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: JsonValue | undefined): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${what} must be a non-empty string.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// renameClient
// ---------------------------------------------------------------------------

export type ClientRename = { from: string; to: string };

function parseRename(value: JsonValue, origin: string): ClientRename {
  if (!isPlainObject(value)) {
    throw new Error(`${origin}: renameClient must be an object { from, to }.`);
  }
  const unknown = Object.keys(value).filter((key) => key !== "from" && key !== "to");
  if (unknown.length > 0) {
    throw new Error(
      `${origin}: renameClient has unknown field(s): ${unknown.sort().join(", ")}. ` +
        "It only moves the id; set name/secret/devSecret under keycloak.clients.",
    );
  }
  const from = nonEmptyString(value.from, `${origin}: renameClient.from`);
  const to = nonEmptyString(value.to, `${origin}: renameClient.to`);
  if (from === to) {
    throw new Error(`${origin}: renameClient.from and .to are both "${from}".`);
  }
  return { from, to };
}

function baseClientIds(base: JsonObject): string[] {
  const keycloak = isPlainObject(base.keycloak) ? base.keycloak : {};
  const clients = Array.isArray(keycloak.clients) ? keycloak.clients : [];
  return clients.flatMap((client) =>
    isPlainObject(client) && typeof client.id === "string" ? [client.id] : [],
  );
}

function renameKeys(map: JsonValue | undefined, rename: ClientRename): JsonValue | undefined {
  if (!isPlainObject(map)) return map;
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(map)) {
    result[key === rename.from ? rename.to : key] = value;
  }
  return result;
}

function renameRealmRoles(roles: JsonValue | undefined, rename: ClientRename): JsonValue | undefined {
  if (!isPlainObject(roles)) return roles;
  const result: JsonObject = {};
  for (const [name, def] of Object.entries(roles)) {
    result[name] = isPlainObject(def) && def.composites !== undefined
      ? { ...def, composites: renameKeys(def.composites, rename)! }
      : def;
  }
  return result;
}

/**
 * Every place an authorizationConfig refers to a client by id, rewritten.
 * Explicit paths rather than a document-wide string replace: a role named
 * after a client, a description mentioning it, or a redirect URI containing
 * it must stay exactly as authored.
 */
export function renameClientReferences(base: JsonObject, rename: ClientRename, origin: string): JsonObject {
  const ids = baseClientIds(base);
  const keycloak = isPlainObject(base.keycloak) ? base.keycloak : {};
  const referencedAsRoleClient =
    keycloak.entityRoleClient === rename.from || keycloak.client === rename.from;
  if (!ids.includes(rename.from) && !referencedAsRoleClient) {
    throw new Error(
      `${origin}: renameClient.from "${rename.from}" is not a client of the realm being patched ` +
        `(clients: ${ids.length > 0 ? ids.map((id) => `"${id}"`).join(", ") : "none"}).`,
    );
  }
  if (ids.includes(rename.to)) {
    throw new Error(
      `${origin}: renameClient.to "${rename.to}" already exists in the realm being patched. ` +
        "A rename moves one client; to fold two together, edit the owning layer.",
    );
  }

  const renamedKeycloak: JsonObject = { ...keycloak };
  if (renamedKeycloak.entityRoleClient === rename.from) renamedKeycloak.entityRoleClient = rename.to;
  if (renamedKeycloak.client === rename.from) renamedKeycloak.client = rename.to;
  if (Array.isArray(renamedKeycloak.clients)) {
    renamedKeycloak.clients = renamedKeycloak.clients.map((client) => {
      if (!isPlainObject(client)) return client;
      const next: JsonObject = { ...client };
      if (next.id === rename.from) next.id = rename.to;
      if (next.serviceAccountClientRoles !== undefined) {
        next.serviceAccountClientRoles = renameKeys(next.serviceAccountClientRoles, rename)!;
      }
      return next;
    });
  }
  if (renamedKeycloak.realmRoles !== undefined) {
    renamedKeycloak.realmRoles = renameRealmRoles(renamedKeycloak.realmRoles, rename)!;
  }

  const result: JsonObject = { ...base, keycloak: renamedKeycloak };
  if (result.realmRoles !== undefined) result.realmRoles = renameRealmRoles(result.realmRoles, rename)!;
  if (result.clientRoles !== undefined) result.clientRoles = renameKeys(result.clientRoles, rename)!;
  if (Array.isArray(result.users)) {
    result.users = result.users.map((user) =>
      isPlainObject(user) && user.clientRoles !== undefined
        ? { ...user, clientRoles: renameKeys(user.clientRoles, rename)! }
        : user,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function unionRoleNames(base: string[], patch: string[]): string[] {
  const result = [...base];
  for (const name of patch) {
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

/**
 * Strategic merge with one addition over `strategicMerge` in layers.ts: at the
 * paths where a string list is a set of role grants (`isRoleList`), lists
 * union instead of replacing. Objects are walked here so the path is known;
 * arrays and scalars defer to the shared rules.
 */
function mergeValue(
  base: JsonValue,
  patch: JsonValue,
  path: string[],
  merge: (base: JsonValue, patch: JsonValue) => JsonValue,
): JsonValue {
  if (isRoleList(path) && isStringList(base) && isStringList(patch)) {
    return unionRoleNames(base, patch);
  }
  if (isPlainObject(base) && isPlainObject(patch)) {
    const result: JsonObject = { ...base };
    for (const [key, patchValue] of Object.entries(patch)) {
      if (patchValue === null) {
        delete result[key];
      } else if (key in result) {
        result[key] = mergeValue(result[key]!, patchValue, [...path, key], merge);
      } else {
        result[key] = patchValue;
      }
    }
    return result;
  }
  // Arrays (keyed or not) and scalars: the shared strategic-merge rules.
  return merge(base, patch);
}

/**
 * `clientRoles.<client>`, `realmRoles.<role>.composites.<client>`,
 * `realmRoles.<role>.includes` and the v1 `keycloak.realmRoles` equivalents.
 */
function isRoleList(path: string[]): boolean {
  const segments = path[0] === "keycloak" ? path.slice(1) : path;
  if (segments.length === 2 && segments[0] === "clientRoles") return true;
  if (segments[0] !== "realmRoles") return false;
  if (segments.length === 3 && segments[2] === "includes") return true;
  return segments.length === 4 && segments[2] === "composites";
}

// ---------------------------------------------------------------------------
// Monotonic narrowing across layers
// ---------------------------------------------------------------------------

/**
 * Every role-name list already declared in `doc`, keyed by its exact path
 * (`clientRoles.<client>`, `realmRoles.<role>.composites.<client>`,
 * `realmRoles.<role>.includes`) so a later patch's result can be compared
 * against the same path in an earlier one.
 */
function roleListsByPath(doc: JsonValue): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!isPlainObject(doc)) return result;
  const clientRoles = isPlainObject(doc.clientRoles) ? doc.clientRoles : {};
  for (const [client, list] of Object.entries(clientRoles)) {
    if (isStringList(list)) result.set(`clientRoles.${client}`, list);
  }
  const realmRoles = isPlainObject(doc.realmRoles) ? doc.realmRoles : {};
  for (const [role, def] of Object.entries(realmRoles)) {
    if (!isPlainObject(def)) continue;
    if (isStringList(def.includes)) result.set(`realmRoles.${role}.includes`, def.includes);
    const composites = isPlainObject(def.composites) ? def.composites : {};
    for (const [client, list] of Object.entries(composites)) {
      if (isStringList(list)) result.set(`realmRoles.${role}.composites.${client}`, list);
    }
  }
  return result;
}

/**
 * Authorization grants are a monotonic security policy across layers, the
 * same invariant `assertCrudPolicyOnlyNarrows` (layers.ts) already enforces
 * for `entityPatch`'s CRUD exposure: a later `authorizationPatch` may drop a
 * grant an earlier layer already declared at an exact path, or leave it
 * alone, but it may not add to a grant list an earlier layer already
 * declared there — that is restoring or widening access a single-file review
 * of the later patch cannot see, since the base list it is unioning onto
 * lives in a different file entirely.
 *
 * A path with NO prior declaration (a brand-new client's grants, a brand-new
 * realm role, a composite target a role never named before) is not a
 * restore or a widen of anything — it is unrestricted.
 *
 * The escape hatch: set the key to `null` in one layer (deleting it, so the
 * path has no prior declaration as far as this check is concerned) and give
 * the full desired list in a later layer. That later assignment takes the
 * plain-replacement branch of `mergeValue`, not the union branch, so it is
 * an explicit, single-file-visible declaration of the whole grant set rather
 * than an invisible append — the same "state the whole thing" discipline
 * `docs/authoring.md` already asks for when taking a grant away.
 */
export function assertAuthorizationGrantsOnlyNarrow(
  base: JsonValue,
  merged: JsonValue,
  origin: string,
): void {
  const before = roleListsByPath(base);
  const after = roleListsByPath(merged);
  const widened: string[] = [];
  for (const [path, afterList] of after) {
    const beforeList = before.get(path);
    if (beforeList === undefined) continue; // no prior declaration: not a widen
    const added = afterList.filter((name) => !beforeList.includes(name));
    if (added.length > 0) {
      widened.push(`${path} (+${added.join(", ")})`);
    }
  }
  if (widened.length > 0) {
    throw new Error(
      `${origin} widens authorization grants an earlier layer already declared: ${widened.join("; ")}. ` +
        "An authorizationPatch may only narrow a grant list an earlier layer already declared; " +
        "set the key to null in one layer and give the full desired list in a later one to widen intentionally.",
    );
  }
}

export type ApplyAuthorizationPatchOptions = {
  /** The shared strategic merge (injected to keep this module free of a cycle with layers.ts). */
  strategicMerge: (base: JsonValue, patch: JsonValue) => JsonValue;
  /** Human-readable source of the patch, for error messages. */
  origin: string;
};

/**
 * Applies one `authorizationPatch` document to one `authorizationConfig`
 * document and returns the merged config. Pure: neither input is mutated.
 */
export function applyAuthorizationPatch(
  baseDoc: JsonValue,
  patchDoc: JsonValue,
  { strategicMerge, origin }: ApplyAuthorizationPatchOptions,
): JsonObject {
  if (!isPlainObject(baseDoc) || baseDoc.kind !== "authorizationConfig") {
    throw new Error(
      `${origin} targets a document of kind "${isPlainObject(baseDoc) ? String(baseDoc.kind ?? "(none)") : "(none)"}"; ` +
        "an authorizationPatch can only patch an authorizationConfig.",
    );
  }
  if (!isPlainObject(patchDoc) || patchDoc.kind !== AUTHORIZATION_PATCH_KIND) {
    throw new Error(`${origin} is not an ${AUTHORIZATION_PATCH_KIND} document.`);
  }
  const { kind: _kind, renameClient, ...body } = patchDoc;
  const unknown = Object.keys(body).filter((key) => !PATCH_BODY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${origin} has unknown field(s): ${unknown.sort().join(", ")}. ` +
        `An authorizationPatch may carry ${[...PATCH_BODY_KEYS].join(", ")}` +
        (unknown.includes("schemaVersion")
          ? "; schemaVersion is the base document's and cannot be patched."
          : "."),
    );
  }

  let base: JsonObject = baseDoc;
  if (renameClient !== undefined) {
    base = renameClientReferences(base, parseRename(renameClient, origin), origin);
  }

  const merged = mergeValue(base, body, [], strategicMerge) as JsonObject;

  // The merged document is what the generator reads; the validator names the
  // patch so an author is pointed at the file they can edit.
  authoringValidator().validate(merged, `${origin} (merged result)`);
  return merged;
}
