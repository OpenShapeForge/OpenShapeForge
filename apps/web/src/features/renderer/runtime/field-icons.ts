// SPDX-License-Identifier: BUSL-1.1
/**
 * Field-icon resolution for the renderer.
 *
 * Resolves a lucide-react icon name for a given canonical {@link Field}.
 * Resolution order:
 *
 *   1. `field.semanticType` → `SemanticTypeDefinition.icon` (compiler-owned, set
 *      in `packages/compiler/config/authoring/**\/semantic-types.yaml`).
 *   2. `field.valueType` / `field.cardinality` → `FIELD_TYPE_ICONS` map below.
 *   3. `null` — caller renders no icon.
 *
 * The returned string is a lucide-react component name like `"AtSign"`. Use
 * the {@link FieldIcon} component to render it.
 */
import type { Field } from "@/generated/compiler/field-contract";
import { COMPILER_SEMANTIC_TYPES } from "@/generated/compiler/semantic-types";
import { fieldRuntimeKind, type FieldRuntimeKind } from "@/lib/field-contract/field-v2";

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
  valueType?: Field["valueType"];
  cardinality?: Field["cardinality"];
  validation?: Field["validation"];
  semanticType?: string;
}): string | null {
  const semanticTypeKey =
    typeof field.semanticType === "string" && field.semanticType.trim().length > 0
      ? field.semanticType.trim()
      : null;

  if (semanticTypeKey) {
    const def = (COMPILER_SEMANTIC_TYPES as Record<string, { icon?: string }>)[
      semanticTypeKey
    ];
    if (def?.icon) {
      return def.icon;
    }
  }

  if (field.valueType) {
    return FIELD_TYPE_ICONS[fieldRuntimeKind(field as Field)];
  }

  return null;
}
