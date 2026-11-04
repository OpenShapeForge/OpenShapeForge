// SPDX-License-Identifier: BUSL-1.1
/**
 * Whether one entity is authorized more narrowly than another, from the
 * compiled contract alone (`extensionRegistry.readAccess`): the part of the
 * proof of a lookup or rollup that holds for every tenant. The save-time
 * proof adds the field and the tenant's profiles to it (linked.ts); the
 * worker's grants are limited by it, so the worker can reach exactly the
 * entities a proven lookup or rollup can read (db/migrations/worker-role.ts).
 * Types only: the migration chain loads it.
 */
import type { RuntimeExtensionReadAccess } from "@openshapeforge/plugin-runtime";

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
