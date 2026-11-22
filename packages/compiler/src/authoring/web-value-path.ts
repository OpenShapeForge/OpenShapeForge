// SPDX-License-Identifier: BUSL-1.1
/** Resolve canonical entity and field paths used by web projections. */
import type { CompiledEntityContract, CompiledViewContext } from "./types.js";
import type {
  WebCollectionView,
  WebCustomOperationRef,
  WebOperationIntent,
  WebOperationRef,
  WebValuePath,
} from "@openshapeforge/interface-web";

export type ProjectableEntity = {
  slug: string;
  contract: CompiledEntityContract;
  view?: CompiledViewContext;
  route: string;
  routeLocale: "en" | "nl";
  operations: Partial<Record<WebOperationIntent, WebOperationRef>>;
  customOperations: Record<string, WebCustomOperationRef>;
  collection: WebCollectionView;
};

/** Resolve canonical relationship steps once for every web presentation that uses a path. */
export function compileRelationshipPath(
  entityName: string,
  source: ProjectableEntity,
  all: ReadonlyMap<string, ProjectableEntity>,
  keys: readonly string[],
  kind = "context record",
): { path: Array<{ entityId: string; relationshipId: string }>; target: ProjectableEntity; many: boolean } {
  if (!keys.length || keys.length > 4) throw new Error(`${entityName}: ${kind} path requires one to four relationships.`);
  let owner = source;
  let many = false;
  const path = keys.map(key => {
    const relation = owner.contract.model.relationships.find(item => item.key === key);
    const target = relation && all.get(relation.target);
    if (!relation || !target || !target.operations[relation.kind === "hasMany" ? "list" : "get"]) {
      throw new Error(`${entityName}: ${kind} path ${key} requires a canonical readable relationship.`);
    }
    const step = { entityId: owner.contract.entity.name, relationshipId: `${owner.contract.entity.name}.${key}` };
    many ||= relation.kind === "hasMany";
    owner = target;
    return step;
  });
  return { path, target: owner, many };
}

export function compileWebValuePath(source: ProjectableEntity, all: ReadonlyMap<string, ProjectableEntity>, expression: string, kind = "value"): WebValuePath {
  const entityName = source.contract.entity.name;
      const parts = expression.split(".");
      if (parts.length > 5 || parts.some(part => !part)) throw new Error(`${entityName}: invalid ${kind} path ${expression}.`);
      let owner = source;
      let many = false;
      const path: WebValuePath["path"] = [];
      for (let i = 0; i < parts.length; i++) {
        const key = parts[i]!;
        const relation = owner.contract.model.relationships.find(item => item.key === key);
        if (relation) {
          if (path.length >= 4) throw new Error(`${entityName}: ${kind} path ${expression} requires at most four relationships.`);
          const resolved = compileRelationshipPath(entityName, owner, all, [key], "value");
          if (!resolved.target.operations.list) throw new Error(`${entityName}: ${kind} path ${expression} requires a readable collection.`);
          path.push(...resolved.path);
          many ||= resolved.many;
          owner = resolved.target;
          if (i === parts.length - 1) return { path, targetEntityId: owner.contract.entity.name, osfType: owner.contract.entity.name, cardinality: many ? "many" : "one" };
        } else {
          const field = owner.contract.model.fields.find(item => item.key === key);
          const providerField = owner.contract.model.relationships.some(item => item.provider && item.fieldKey === key);
          if (!field || field.baseType === "object" || field.relationship?.target || providerField || i !== parts.length - 1) throw new Error(`${entityName}: invalid ${kind} path ${expression}.`);
          return { path, targetEntityId: owner.contract.entity.name, field: key, osfType: field.osfType, cardinality: many || field.cardinality === "collection" ? "many" : "one" };
        }
      }
      throw new Error(`${entityName}: invalid ${kind} path ${expression}.`);
}
