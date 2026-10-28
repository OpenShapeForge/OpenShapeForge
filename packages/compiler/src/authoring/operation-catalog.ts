// SPDX-License-Identifier: BUSL-1.1
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationCatalogDefinition, OperationCatalogWebInterface } from "./types.js";
import { authoringValidator } from "./schema-validation.js";

export type LoadedOperationCatalog = {
  path: string;
  document: OperationCatalogDefinition;
};

/**
 * The canonical id a catalog operation is registered under. Authors may pin
 * it with `id`; otherwise it is `<plugin>.<key>`. The compiler keys the static
 * registry on this and the web manifest joins the authored catalog back to the
 * compiled contract with it, so both derive it here rather than each guessing.
 */
export function moduleOperationId(
  catalog: Pick<OperationCatalogDefinition, "plugin">,
  key: string,
  definition: Pick<OperationCatalogDefinition["operations"][string], "id">,
): string {
  return definition.id ?? `${catalog.plugin}.${key}`;
}

/**
 * Web placement invariants the JSON schema cannot state: a placement must name
 * an operation and a page that exist, an empty page would be a dead menu
 * entry, and a landing operation runs unprompted on page open, so it must be a
 * read that needs no input and there can be only one per page.
 */
function assertWebInterface(path: string, catalog: OperationCatalogDefinition): void {
  const web = catalog.interfaces.web;
  if (!web) return;
  const landingByPage = new Map<string, string>();
  const populatedPages = new Set<string>();
  for (const [key, placement] of Object.entries(web.operations ?? {})) {
    const operation = catalog.operations[key];
    if (!operation) {
      throw new Error(`${path} interfaces.web places unknown operation "${key}".`);
    }
    if (!web.pages?.[placement.page]) {
      throw new Error(
        `${path} interfaces.web places operation "${key}" on unknown page "${placement.page}".`,
      );
    }
    populatedPages.add(placement.page);
    if (!placement.landing) continue;
    const required = operation.input?.schema.required;
    if (operation.effects.data !== "read" || (Array.isArray(required) && required.length > 0)) {
      throw new Error(
        `${path} landing operation "${key}" must be a read operation without required input; ` +
          "it runs unprompted when its page opens.",
      );
    }
    const previous = landingByPage.get(placement.page);
    if (previous) {
      throw new Error(
        `${path} page "${placement.page}" has two landing operations ("${previous}" and "${key}"); ` +
          "only one operation can run on page open.",
      );
    }
    landingByPage.set(placement.page, key);
  }
  for (const page of Object.keys(web.pages ?? {})) {
    if (!populatedPages.has(page)) {
      throw new Error(`${path} interfaces.web page "${page}" has no operations.`);
    }
  }
  const entityOperations = new Map<string, string>();
  for (const [entityName, entity] of Object.entries(web.entities ?? {})) {
    if (!entity.fields.includes(entity.idField) || !entity.fields.includes(entity.displayField)) {
      throw new Error(`${path} interfaces.web entity "${entityName}" must include idField and displayField in fields.`);
    }
    for (const column of entity.columns) {
      if (!entity.fields.includes(column)) {
        throw new Error(`${path} interfaces.web entity "${entityName}" column "${column}" is not in fields.`);
      }
    }
    const placements = [
      entity.operations.list.operation,
      ...(entity.operations.get ? [entity.operations.get.operation] : []),
        ...(entity.operations.create ? [entity.operations.create.operation] : []),
      ...(entity.operations.collectionActions ?? []),
      ...(entity.operations.recordActions ?? []).map((action) =>
        typeof action === "string" ? action : action.operation
      ),
    ];
    for (const key of placements) {
      if (!catalog.operations[key]) {
        throw new Error(`${path} interfaces.web entity "${entityName}" references unknown operation "${key}".`);
      }
      const previous = entityOperations.get(key);
      if (previous && previous !== entityName) {
        throw new Error(`${path} interfaces.web operation "${key}" is placed on both entities "${previous}" and "${entityName}".`);
      }
      entityOperations.set(key, entityName);
    }
  }
}

type CatalogWebEntities = NonNullable<OperationCatalogWebInterface["entities"]>;
type CatalogWebEntity = CatalogWebEntities[string];

/** One operation catalog with the origin to name in a diagnostic. */
export type CatalogWebEntitySource = {
  /** Authored file path when loaded from disk, otherwise the owning plugin. */
  origin: string;
  document: OperationCatalogDefinition;
};

type CatalogWebEntityOwner = CatalogWebEntitySource & { name: string; entity: CatalogWebEntity };

/** The record route a catalog entity serves; `route/:idField` unless pinned. */
function catalogRecordRoute(entity: CatalogWebEntity): string {
  return entity.recordRoute ?? `${entity.route}/:${entity.idField}`;
}

/** Route parameters in authored order, e.g. `/tenants/:slug/members` -> `["slug"]`. */
function routeParameters(route: string): string[] {
  return [...route.matchAll(/:([A-Za-z0-9_]+)/g)].map(([, name]) => name!);
}

/**
 * Every operation-backed web entity by name, across all catalogs.
 *
 * Entity names are global — a route, a reference picker and a related link all
 * name one — so the same name from two catalogs is an authoring mistake
 * whichever plugins they belong to, not a last-one-wins merge.
 */
function indexCatalogWebEntities(
  sources: readonly CatalogWebEntitySource[],
): Map<string, CatalogWebEntityOwner> {
  const index = new Map<string, CatalogWebEntityOwner>();
  for (const source of sources) {
    for (const [name, entity] of Object.entries(source.document.interfaces.web?.entities ?? {})) {
      const owner = index.get(name);
      if (owner) {
        throw new Error(
          `Operation-backed web entity "${name}" is declared by both "${owner.origin}" and ` +
            `"${source.origin}"; entity names are global.`,
        );
      }
      index.set(name, { ...source, name, entity });
    }
  }
  return index;
}

/**
 * The authentication realms a browser can actually read in: it carries a
 * tenant session, a control-realm bearer, or nothing at all. `custom` and
 * `capability` are not among them for the reason `standaloneAuth` already
 * refuses to project them to a page at all — a page holds neither a plugin's
 * own API key nor a recipient's record-bound grant token — so a related link
 * between two such reads has no realm to be the same in.
 */
const WEB_READ_MODES = new Set(["session", "control", "public"]);

/**
 * The realm one end of a related link is read in: the declared `auth.mode` of
 * the ONE Operation that runs that end's read.
 *
 * There is no realm to fall back to when a read declares none. The authoring
 * schema requires `auth` of every module Operation (`entityOperationV2`, the
 * `implementation.type: plugin` branch), and the authoring TYPE carries it as
 * optional only because it is shared with entity CRUD, where declaring one is
 * forbidden; nothing defaults it anywhere. The check below is exported and
 * takes documents typed that way, so it states the requirement itself rather
 * than inheriting it — two Operations that declare no mode are two unstated
 * realms, never a match.
 */
function webReadRealm(owner: CatalogWebEntityOwner, operationKey: string, read: string): string {
  const mode = owner.document.operations[operationKey]?.auth?.mode;
  if (mode !== undefined && WEB_READ_MODES.has(mode)) return mode;
  throw new Error(
    `${owner.origin} interfaces.web entity "${owner.name}" is ${read} by Operation "${operationKey}", ` +
      (mode === undefined
        ? "which declares no auth mode; a related link is resolvable only between reads that state their " +
          "authentication realm."
        : `which is read with ${mode} auth; a browser carries a tenant session, a control-realm bearer or ` +
          "nothing, so there is no realm a related link could share with it."),
  );
}

/**
 * Resolve every `related` link against ALL catalogs rather than the file it is
 * authored in. A relationship crosses owners whenever the two entities do: the
 * integration that holds a named record action is provisioned by one plugin
 * and the assignments it holds are served by another, and neither may claim
 * the other's Operations. Only the destination's NAME travels; its Operations,
 * roles and bindings stay with the catalog that authored them, so this adds no
 * authority and the destination enforces its own on arrival.
 *
 * What it does establish is that the composed route is real: the destination
 * exists and is unambiguous, the link names the route that destination is
 * actually served at, every parameter of that route is already bound by the
 * record the link is shown on, and the two reads the link joins run in the
 * same authentication realm. Anything less would emit a manifest tab that
 * cannot resolve, so it fails here instead of in a host that can only guess.
 *
 * "Already bound" is what the host actually substitutes from: the parameters of
 * the record route the link is shown on, plus the fields that record projects.
 * Both are named by the source entity itself — the authored `fields` list is
 * checked against the read Operation's own result schema where the manifest is
 * built — so nothing here reaches arbitrary or privileged data; a name the
 * source neither routes nor projects stays unbound.
 *
 * The two reads the link joins are the ones the host runs, not the pair that
 * is easiest to reach: the tab is shown on the source's RECORD page, so the
 * source's end is its `get` Operation — a catalog entity has a record view
 * only when it declares one — and the destination's end is the `list`
 * Operation that serves the collection the tab opens. Those two may declare
 * different realms from the same entity's `list`, so neither is substituted
 * for the other.
 */
export function assertRelatedWebEntitiesResolve(sources: readonly CatalogWebEntitySource[]): void {
  const index = indexCatalogWebEntities(sources);
  for (const { origin, document } of sources) {
    for (const [entityName, entity] of Object.entries(document.interfaces.web?.entities ?? {})) {
      const source: CatalogWebEntityOwner = { origin, document, name: entityName, entity };
      const recordRoute = catalogRecordRoute(entity);
      // The record page substitutes a destination parameter from its own route
      // or from the record it already read, whichever carries the name. A
      // parameter the route does not carry is ordinary: a child collection is
      // often reached by a foreign key the parent only holds as a field.
      const routeBound = new Set(routeParameters(recordRoute));
      const fieldBound = new Set(entity.fields);
      for (const related of entity.related ?? []) {
        const target = index.get(related.entity);
        if (!target) {
          throw new Error(`${origin} interfaces.web entity "${entityName}" relates to unknown entity "${related.entity}".`);
        }
        if (related.route !== target.entity.route) {
          throw new Error(
            `${origin} interfaces.web entity "${entityName}" relates to "${related.entity}" at route ` +
              `"${related.route}", but "${related.entity}" is served at "${target.entity.route}" ` +
              `(${target.origin}); a related link names the destination's own collection route.`,
          );
        }
        const unbound = routeParameters(target.entity.route)
          .filter((parameter) => !routeBound.has(parameter) && !fieldBound.has(parameter));
        if (unbound.length > 0) {
          throw new Error(
            `${origin} interfaces.web entity "${entityName}" relates to "${related.entity}" at route ` +
              `"${related.route}", whose parameter(s) ${unbound.map((parameter) => `":${parameter}"`).join(", ")} ` +
              `are bound by neither the record route "${recordRoute}" the link is shown on nor a field ` +
              `"${entityName}" projects.`,
          );
        }
        // The link is a tab on the record page, which exists only for an
        // entity that declares the read behind it. Without one there is no
        // page to show the tab on, whatever the collection beside it allows.
        const recordRead = entity.operations.get;
        if (!recordRead) {
          throw new Error(
            `${origin} interfaces.web entity "${entityName}" relates to "${related.entity}" but declares no ` +
              "get Operation; a related link is a tab on the record page, which a catalog entity has only " +
              "when it declares the read behind it.",
          );
        }
        const sourceMode = webReadRealm(source, recordRead.operation, "read as a record");
        const targetMode = webReadRealm(target, target.entity.operations.list.operation, "listed");
        if (sourceMode !== targetMode) {
          throw new Error(
            `${origin} interfaces.web entity "${entityName}" is read as a record with ${sourceMode} auth and ` +
              `relates to "${related.entity}" (${target.origin}), whose collection is listed with ` +
              `${targetMode} auth; a related link cannot cross authentication realms.`,
          );
        }
      }
    }
  }
}

/**
 * Validated catalogs by path, keyed on the raw source so an edited file is
 * revalidated and an unchanged one is not: the osf-type catalog derives from
 * these on every `loadOsfTypes`, which the compiler calls hundreds of times
 * per build, and ajv validation is the expensive part.
 */
const validatedCatalogs = new Map<string, { source: string; document: OperationCatalogDefinition }>();

export function loadOperationCatalogs(authoringDir: string): LoadedOperationCatalog[] {
  const root = join(authoringDir, "operations");
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) paths.push(path);
    }
  };
  walk(root);
  const loaded = paths.sort().map((path) => {
    const source = readFileSync(path, "utf-8");
    const cached = validatedCatalogs.get(path);
    if (cached && cached.source === source) return { path, document: structuredClone(cached.document) };
    const { document } = authoringValidator().validateFile(path, path);
    const catalog = document as OperationCatalogDefinition;
    for (const [key, operation] of Object.entries(catalog.operations)) {
      if (operation.implementation.type !== "plugin") {
        throw new Error(`${path} operation "${key}" must use implementation.type plugin.`);
      }
      if (operation.implementation.plugin !== catalog.plugin) {
        throw new Error(
          `${path} operation "${key}" implementation plugin ` +
            `"${operation.implementation.plugin}" must match catalog plugin "${catalog.plugin}".`,
        );
      }
      if (operation.implementation.action) {
        throw new Error(
          `${path} module operation "${key}" cannot claim entity CRUD action ` +
            `"${operation.implementation.action}".`,
        );
      }
      if (operation.target) {
        throw new Error(`${path} module operation "${key}" cannot declare an entity target.`);
      }
      if (operation.auth?.mode === "session" && operation.auth.recordPermission) {
        throw new Error(
          `${path} module operation "${key}" cannot declare recordPermission without an entity record target.`,
        );
      }
      if (operation.auth?.mode === "session" && operation.auth.recordAction) {
        throw new Error(
          `${path} module operation "${key}" cannot declare recordAction without an entity record target.`,
        );
      }
      if (operation.concurrency || operation.confirmation.mode === "challenge") {
        throw new Error(
          `${path} module operation "${key}" cannot declare record concurrency or a target-bound challenge.`,
        );
      }
      // A control-realm operator has no tenant; a tenancy that asks for one
      // would make the operation unreachable rather than wrong.
      if (operation.auth?.mode === "control" && operation.tenancy?.mode !== "none") {
        throw new Error(
          `${path} module operation "${key}" uses control auth and so must declare tenancy mode none.`,
        );
      }
    }
    assertWebInterface(path, catalog);
    validatedCatalogs.set(path, { source, document: structuredClone(catalog) });
    return { path, document: catalog };
  });
  // Cross-catalog, so it runs on every load even when every file came from the
  // per-file cache: a related link is invalidated by an edit to the OTHER
  // catalog, which leaves this one's source untouched.
  assertRelatedWebEntitiesResolve(loaded.map(({ path, document }) => ({ origin: path, document })));
  return loaded;
}
