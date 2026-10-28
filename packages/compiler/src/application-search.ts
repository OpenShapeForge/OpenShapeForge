// SPDX-License-Identifier: BUSL-1.1
import { moduleOperationId } from './authoring/operation-catalog.js';
import type { LocalizedText } from './authoring/types/common.js';
import type { OperationCatalogDefinition } from './authoring/types.js';
import type { CompiledEntityInfo, PluginOperationContract } from './plugins.js';

/**
 * Every role that may reach application search: the read roles of the core
 * entities it covers, plus the roles the catalog-backed collection pages are
 * listed with (`catalogApplicationSearchSources`).
 *
 * The list is any-of, so a session holding only a catalog's role has to be
 * admitted to call search at all. Admission is not disclosure: the handler
 * enumerates per session (`platform.operations.list`) and a page whose own
 * list Operation that session may not invoke is dropped before it is matched.
 */
export function applicationSearchDefinition(entities: readonly Pick<CompiledEntityInfo,'contract'>[], catalogRoles: readonly string[] = []): PluginOperationContract {
  return {
    key:'application.search', title:'Search application', description:'Find readable application entities and records by names and descriptions in every authored language.',
    handler:'searchApplication', auth:{mode:'session',roles:[...new Set([...entities.flatMap(({contract})=>contract.authorization.roles.read),...catalogRoles])].sort()},
    tenancy:{mode:'required'}, idempotency:{mode:'none'}, effects:{data:'read',external:'none'},
    inputSchema:{type:'object',additionalProperties:false,properties:{query:{type:'string',maxLength:200},locale:{type:'string',enum:['en','nl']},
      entity:{type:'string',maxLength:200},after:{type:'string',maxLength:4096},first:{type:'integer',minimum:1,maximum:20}}},
    outputSchema:{type:'object',required:['entities','groups','incomplete'],properties:{
      entities:{type:'array',items:{type:'object'}}, groups:{type:'array',items:{type:'object'}},incomplete:{type:'boolean'}
    }},errors:[],transports:{rest:{method:'POST',path:'/api/core/application/search',response:{kind:'json'}},
      mcp:{enabled:true,name:'application_search'},typescript:{enabled:true,functionName:'applicationSearch'},graphql:{enabled:false,reason:'Use the canonical REST or MCP search Operation.'}}
  };
}
export function applicationSearchSources(entities: readonly Pick<CompiledEntityInfo,'contract'>[]) {
  return entities.flatMap(({contract:c})=>{
    const list=c.entityOperations?.list?.id ?? c.pluginOperations?.find(op=>op.key==='list')?.id;
    const get=c.entityOperations?.get?.id ?? c.pluginOperations?.find(op=>op.key==='get')?.id;
    if(!list)return [];
    const field=c.entity.filterField ?? c.entity.displayTemplate?.match(/^\{\{\s*(\w+)\s*\}\}$/)?.[1]
      ?? ['name','title','label','displayName','key'].find(key=>c.model.fields.some(f=>f.key===key&&f.baseType==='string'));
    const description=c.model.fields.find(f=>f.key==='description'&&f.baseType==='string'&&f.cardinality!=='collection');
    const viewTitle=Object.values(c.views??{}).find(view=>view.list?.title)?.list?.title;
    const labels=typeof viewTitle==='object'?viewTitle:c.entity.labels??{en:c.entity.title,nl:c.entity.title};
    return [{entity:c.entity.name,labels:{...labels},description:typeof c.entity.description==='object'?{...c.entity.description}:c.entity.description??'',
      list,...(get?{get}:{}),...(field?{field}:{}),...(description?{descriptionField:description.key}:{})}];
  });
}
/** Authored text as the search sources carry it: present languages only. */
function localizedRecord(value: LocalizedText | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(value ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
function searchableText(value: LocalizedText | string | undefined): Record<string, string> | string {
  return typeof value === 'string' ? value : localizedRecord(value);
}

/** Route parameters, e.g. `/integrations/:integrationId/record-actions` -> `["integrationId"]`. */
function routeParameters(route: string): string[] {
  return [...route.matchAll(/:([A-Za-z0-9_]+)/g)].map(([, name]) => name!);
}

/**
 * The catalog-backed collection PAGES a tenant session can discover, and the
 * roles they are listed with.
 *
 * An operation catalog's `interfaces.web.entities` project the same collection
 * view a core entity does, but only compiled core entities reached the search
 * sources, so a page an Operation catalog serves could not be found from
 * search-only navigation at all. These sources close that gap with the page and
 * nothing else: each is emitted without `field` and without `get`, which is
 * exactly what the handler requires before it reads a record, so a catalog
 * entity contributes a page to match and never a record read. A catalog list
 * Operation states its own query shape and no filter may be assumed of it.
 *
 * What a source carries is already-authored, non-privileged text — the entity's
 * own title in every authored language and the description of the Operation
 * that serves its collection — and it is matched only after the handler has
 * dropped every page whose list Operation the live session may not invoke.
 *
 * Fails closed on every collection a tenant search cannot honestly offer:
 *
 * - one listed in another realm than search itself runs in, or without a
 *   required tenant. A `control` collection belongs to a platform operator who
 *   has no tenant, and `public`, `capability` and `custom` reads are not a
 *   tenant session's either; offering any of them here would put a page from
 *   outside the caller's tenant in a tenant's search results.
 * - one whose read is not a read. A collection served by a write would run that
 *   write to populate a search result.
 * - one whose route carries a parameter. A search result is navigated to with
 *   nothing but itself, and the parameter's value belongs to the record page
 *   the collection hangs under (`assertRelatedWebEntitiesResolve`), not to a
 *   query box, so there is no honest page to offer.
 * - one whose name a core entity already owns. That entity owns the name in the
 *   web manifest as well, and its own source carries record search too.
 *
 * A collection listed with `anyAuthenticatedSession` contributes no role, so it
 * is discoverable to every session that may call search at all and widens
 * nothing.
 */
export function catalogApplicationSearchSources(
  catalogs: readonly OperationCatalogDefinition[],
  coreEntities: ReadonlySet<string> = new Set(),
) {
  const roles = new Set<string>();
  const sources = catalogs.flatMap((catalog) =>
    Object.entries(catalog.interfaces.web?.entities ?? {}).flatMap(([name, entity]) => {
      const key = entity.operations.list.operation;
      const definition = catalog.operations[key];
      // Already refused where the catalog is validated; stated again because
      // this reads the authored document rather than the compiled contract.
      if (!definition) return [];
      const auth = definition.auth;
      if (auth?.mode !== 'session' || definition.tenancy?.mode !== 'required' || definition.effects.data !== 'read') return [];
      if (routeParameters(entity.route).length > 0 || coreEntities.has(name)) return [];
      for (const role of [...(auth.roles ?? []), ...(auth.roleGroups ?? []).flat()]) roles.add(role);
      return [{
        entity: name,
        labels: localizedRecord(entity.title),
        description: searchableText(definition.description),
        list: moduleOperationId(catalog, key, definition),
      }];
    })
  );
  // Sorted by name: the sources reach a generated artifact, which has to be
  // identical for the same catalogs however they were loaded.
  return { sources: sources.sort((left, right) => left.entity < right.entity ? -1 : left.entity > right.entity ? 1 : 0), roles: [...roles].sort() };
}
