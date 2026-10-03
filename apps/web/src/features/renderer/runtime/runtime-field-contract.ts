// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { tryFieldValueType } from "@/lib/field-contract/field-v2";

export type PreparedRuntimeFields = Readonly<{
  fields: readonly Field[];
  unsupported: ReadonlyMap<Field, string>;
}>;

/**
 * Keep strict contract semantics at runtime while isolating stale fields from
 * form state and submission. Valid siblings remain available; invalid nodes
 * stay in the presentation tree through `unsupported` and render read-only.
 */
export function prepareRuntimeFields(fields: readonly Field[]): PreparedRuntimeFields {
  const unsupported = new Map<Field, string>();

  const prepare = (field: Field): Field | null => {
    const resolution = tryFieldValueType(field);
    if (!resolution.ok) {
      unsupported.set(field, resolution.message);
      return null;
    }
    const children = field.children?.flatMap((child) => {
      const prepared = prepare(child);
      return prepared ? [prepared] : [];
    });
    const authoredShape = (field as Field & { shape?: readonly Field[] }).shape;
    const shape = authoredShape?.flatMap((child) => {
      const prepared = prepare(child);
      return prepared ? [prepared] : [];
    });
    const item = field.item ? prepare(field.item) : undefined;
    return {
      ...field,
      ...(children ? { children } : {}),
      ...(shape ? { shape } : {}),
      ...(field.item ? { item: item ?? undefined } : {}),
    } as Field;
  };

  return {
    fields: fields.flatMap((field) => {
      const prepared = prepare(field);
      return prepared ? [prepared] : [];
    }),
    unsupported,
  };
}
