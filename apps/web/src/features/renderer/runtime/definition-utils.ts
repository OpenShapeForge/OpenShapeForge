// SPDX-License-Identifier: BUSL-1.1
/**
 * Definition traversal utilities — walks a RendererFormDefinition's field tree
 * and collects entries matching specific criteria.
 *
 * Provides collectors for:
 * - Leaf fields (scalar fields, skipping collections and object wrappers)
 * - Collection fields (repeatable row containers)
 * - Computed fields (fields with template expressions)
 *
 * Each collector returns a flat list of {@link RendererFieldEntry} with the
 * resolved path and stringified key, ready for use by form state initialization,
 * validation config building, and structured value construction.
 */
import type { Field } from "@/generated/compiler/field-contract";
import type { RendererFieldConfig } from "@/features/renderer/form-definition";
import {
  getRendererFieldPath,
} from "./field-utils";
import {
  stringifyRendererPath,
  type RendererPathPart,
} from "./path-utils";
import { isFieldCollection, isFieldObject } from "@/lib/field-contract/field-v2";

export type RendererFieldEntry = {
  field: Field;
  path: RendererPathPart[];
  key: string;
};

export function collectRendererLeafFields(
  fields: readonly Field[],
  fieldConfig: Readonly<Record<string, RendererFieldConfig>> = {},
  parentPath: readonly RendererPathPart[] = [],
): RendererFieldEntry[] {
  const entries: RendererFieldEntry[] = [];

  for (const field of fields) {
    const path = getRendererFieldPath(field, parentPath, fieldConfig[field.key]);

    if (isFieldCollection(field)) {
      continue;
    }

    if (isFieldObject(field) && field.children?.length) {
      entries.push(...collectRendererLeafFields(
        field.children,
        fieldConfig,
        path,
      ));
      continue;
    }

    entries.push({
      field,
      path,
      key: stringifyRendererPath(path),
    });
  }

  return entries;
}

export function collectRendererCollectionFields(
  fields: readonly Field[],
  fieldConfig: Readonly<Record<string, RendererFieldConfig>> = {},
  parentPath: readonly RendererPathPart[] = [],
): RendererFieldEntry[] {
  const entries: RendererFieldEntry[] = [];

  for (const field of fields) {
    const path = getRendererFieldPath(field, parentPath, fieldConfig[field.key]);

    if (isFieldCollection(field)) {
      entries.push({
        field,
        path,
        key: stringifyRendererPath(path),
      });
      continue;
    }

    if (isFieldObject(field) && field.children?.length) {
      entries.push(...collectRendererCollectionFields(
        field.children,
        fieldConfig,
        path,
      ));
    }
  }

  return entries;
}

export function collectRendererComputedFields(
  fields: readonly Field[],
  fieldConfig: Readonly<Record<string, RendererFieldConfig>> = {},
  parentPath: readonly RendererPathPart[] = [],
): RendererFieldEntry[] {
  const entries: RendererFieldEntry[] = [];

  for (const field of fields) {
    const path = getRendererFieldPath(field, parentPath, fieldConfig[field.key]);

    if (isFieldObject(field) && field.children?.length) {
      entries.push(...collectRendererComputedFields(
        field.children,
        fieldConfig,
        path,
      ));
      continue;
    }

    if (field.computed) {
      entries.push({
        field,
        path,
        key: stringifyRendererPath(path),
      });
    }
  }

  return entries;
}
