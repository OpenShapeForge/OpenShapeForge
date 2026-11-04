// SPDX-License-Identifier: BUSL-1.1
/**
 * Whether one entity is authorized more narrowly than another, from the
 * compiled contract alone (`extensionRegistry.readAccess`): the part of the
 * proof of a lookup or rollup that holds for every tenant. The save-time
 * proof adds the field and the tenant's profiles to it (linked.ts); the
 * worker's grants are limited by it, link by link, so the worker can reach exactly the
 * entities a proven lookup or rollup can read (db/migrations/worker-role.ts).
 * Types only: the migration chain loads it.
 */
import type { RuntimeExtensionReadAccess, RuntimeExtensionRegistry, RuntimeExtensionRelation } from "@openshapeforge/plugin-runtime";

/** The entities whose writes change what a lookup's proof reads: the authorization profile model. */
export const AUTHORIZATION_MODEL: readonly string[] = [
  "AuthorizationOperationPolicy", "AuthorizationProfile", "AuthorizationProfileAssignment", "AuthorizationProfilePolicy", "AuthorizationProfileVersion",
];

const EVERY_CLASS = ["person", "application", "service", "unknown"];
const classes = (access: RuntimeExtensionReadAccess) => access.principalClasses ?? EVERY_CLASS;

/**
 * Why `target` is authorized more narrowly than `source`, or undefined. With
 * `owned`, a collection whose children are authorized through their owner,
 * the owner's readers are the child's.
 */
export function narrowerReadAccess(
  source: string,
  target: string,
  from: RuntimeExtensionReadAccess | undefined,
  to: RuntimeExtensionReadAccess | undefined,
  owned = false,
): string | undefined {
  if (!from || !to) return `${!from ? source : target} is outside the compiled authorization contract tenant fields may reach.`;
  if (!owned) {
    const missing = from.roles.filter((role) => !to.roles.includes(role));
    if (missing.length) {
      return `${target} is readable for ${to.roles.join(", ") || "no role"}, ${source} also for ${missing.join(", ")}; ` +
        `${missing.length === 1 ? "that role" : "those roles"} would see ${target} values ${missing.length === 1 ? "it" : "they"} may not read.`;
    }
    const outside = classes(from).filter((kind) => !classes(to).includes(kind));
    if (outside.length) return `${target} is readable for fewer principal classes than ${source} (not for ${outside.join(", ")}).`;
  }
  if (to.rowPolicy) return `the rows of ${target} are narrowed by ${to.rowPolicy}, so a reader of ${source} would see values of ${target} records hidden from them.`;
  return undefined;
}

/** What is known of a column here: enough to tell whether a value may travel along it. */
type RelationColumn = { readonly name: string; readonly classification?: unknown; readonly fieldPolicy?: unknown };

/** Whether a computed value may travel along this foreign key: what it points at would show through the value. */
export function readableForeignKey(columns: readonly RelationColumn[] | undefined, name: string): boolean {
  const column = columns?.find((candidate) => candidate.name === name);
  return column !== undefined && !column.classification && !column.fieldPolicy;
}

/** The single relations `rollup.of` may follow from a child: an extensible child's own, or those the registry keeps for it. */
export function stepRelations(registry: Pick<RuntimeExtensionRegistry, "entity" | "childRelations">, child: string): readonly RuntimeExtensionRelation[] {
  return registry.entity(child)?.relations.filter((relation) => relation.kind === "belongsTo") ?? registry.childRelations(child);
}

/** The foreign keys a lookup of an extensible entity may follow: readable, and to a target not authorized more narrowly. */
export function lookupForeignKeys(
  registry: Pick<RuntimeExtensionRegistry, "entity" | "readAccess">,
  entity: string,
  columns: readonly RelationColumn[] | undefined,
): string[] {
  return (registry.entity(entity)?.relations ?? [])
    .filter((relation) => relation.kind === "belongsTo" && readableForeignKey(columns, relation.foreignKey) &&
      !narrowerReadAccess(entity, relation.entity, registry.readAccess(entity), registry.readAccess(relation.entity)))
    .map((relation) => relation.foreignKey);
}
