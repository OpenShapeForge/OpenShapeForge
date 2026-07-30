// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";
import { coerceRendererValue } from "@/features/renderer/components/renderer/state";
import {
  setValueAtPath,
  stringifyRendererPath,
  type RendererPathPart,
} from "@/features/renderer/runtime/path-utils";

export function buildNextCollectionPathValues(
  collectionValues: Record<string, unknown>,
  collectionPath: readonly RendererPathPart[],
  targetPath: readonly RendererPathPart[],
  field: Field,
  rawValue: unknown,
) {
  const collectionKey = stringifyRendererPath(collectionPath);
  const relativePath = targetPath.slice(collectionPath.length);
  const currentCollection = Array.isArray(collectionValues[collectionKey])
    ? collectionValues[collectionKey] as unknown[]
    : [];
  const nextCollection = setValueAtPath(
    currentCollection,
    relativePath,
    coerceRendererValue(field, rawValue),
  ) as unknown[];

  return {
    collectionKey,
    nextCollection,
    targetPathKey: stringifyRendererPath(targetPath),
  };
}
