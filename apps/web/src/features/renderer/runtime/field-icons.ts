// SPDX-License-Identifier: BUSL-1.1
/**
 * Field-icon resolution for the renderer.
 *
 * Resolves a lucide-react icon name for a given canonical {@link Field}.
 * Resolution order:
 *
 *   1. `field.osfType` → `OsfTypeDefinition.icon` (compiler-owned, set
 *      in `packages/compiler/config/authoring/**\/osf-types.yaml`).
 *   2. `fieldValueType(field)` / `field.cardinality` → `FIELD_TYPE_ICONS` map below.
 *   3. `null` — caller renders no icon.
 *
 * The returned string is a lucide-react component name like `"AtSign"`. Use
 * the {@link FieldIcon} component to render it.
 */
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_OSF_TYPES } from "@/generated/compiler/osf-types";
import { fieldRuntimeKind, type FieldRuntimeKind, fieldValueType } from "@/lib/field-contract/field-v2";

const FIELD_TYPE_ICONS: Record<FieldRuntimeKind, string> = {
  uuid: "Fingerprint",
  string: "Type",
  integer: "Hash",
  number: "Hash",
  boolean: "ToggleLeft",
  date: "Calendar",
  datetime: "CalendarClock",
  object: "Layers",
  array: "List",
  fieldArray: "ListChecks",
};

/**
 * Resolve the lucide-react icon name for a field, or `null` if no icon
 * should be rendered.
 */
export function resolveFieldIcon(field: {
  osfType: string;
  baseType?: Field["baseType"];
  cardinality?: Field["cardinality"];
  validation?: Field["validation"];
}): string | null {
  const osfTypeKey =
    typeof field.osfType === "string" && field.osfType.trim().length > 0
      ? field.osfType.trim()
      : null;

  if (osfTypeKey) {
    const def = (COMPILER_OSF_TYPES as Record<string, { icon?: string }>)[
      osfTypeKey
    ];
    if (def?.icon) {
      return def.icon;
    }
  }

  return FIELD_TYPE_ICONS[fieldRuntimeKind({ key: "", ...field })] ?? null;
}
