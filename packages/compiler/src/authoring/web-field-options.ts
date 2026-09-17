// SPDX-License-Identifier: BUSL-1.1
/**
 * The one place a web field's option source comes from.
 *
 * `field.options` is already the resolution of the field's osf type: the
 * model compiler takes authored options first and the semantic-type catalog
 * entry's options otherwise, so a referentiedata-backed type (`osfType:
 * countryCode`) and an entity-backed option list (`options.type: entity`)
 * arrive here through the same property and leave through the same
 * projection.
 */
import type { WebFieldOptionSource } from "@openshapeforge/interface-web";
import type { CompiledField } from "./types.js";

export function fieldOptionSource(field: Pick<CompiledField, "options">): WebFieldOptionSource | undefined {
  const options = field.options;
  if (!options) return undefined;
  if (options.type === "referentiedata" && options.referentieGroep) {
    return { type: "referentiedata", group: options.referentieGroep };
  }
  if (options.type === "entity" && options.source) {
    return { type: "entity", source: options.source, valueField: options.valueField ?? "id" };
  }
  if ((options.type === "remote" || options.type === "dynamic") && (options.remoteUrl || options.source)) {
    return { type: options.type, source: options.remoteUrl ?? options.source! };
  }
  return undefined;
}
