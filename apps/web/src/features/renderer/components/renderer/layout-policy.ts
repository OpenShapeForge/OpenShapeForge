// SPDX-License-Identifier: BUSL-1.1
import type { Field } from "@/generated/compiler/field-contract";

export function clampRendererColumns(columns: number | undefined): 1 | 2 | 3 | 4 {
  if (columns === 1 || columns === 3 || columns === 4) {
    return columns;
  }

  return 2;
}

export function getRendererGridColumnsClass(columns: number | undefined) {
  switch (clampRendererColumns(columns)) {
    case 1:
      return "grid-cols-1 md:grid-cols-1";
    case 3:
      return "grid-cols-1 md:grid-cols-3";
    case 4:
      return "grid-cols-1 md:grid-cols-4";
    case 2:
    default:
      return "grid-cols-1 md:grid-cols-2";
  }
}

export function getRendererFieldSpan(
  field: Field,
  columns: number | undefined,
) {
  const resolvedColumns = clampRendererColumns(columns);
  const fraction = field.layoutFraction;

  if (fraction === undefined || !Number.isFinite(fraction) || fraction <= 0) {
    return 1;
  }

  if (fraction >= 1) {
    return resolvedColumns;
  }

  return Math.max(
    1,
    Math.min(resolvedColumns, Math.round(resolvedColumns * fraction)),
  );
}

export function getRendererFieldSpanClass(
  field: Field,
  columns: number | undefined,
) {
  const resolvedColumns = clampRendererColumns(columns);
  const span = getRendererFieldSpan(field, resolvedColumns);

  if (resolvedColumns === 1 || span <= 1) {
    return undefined;
  }

  switch (span) {
    case 4:
      return "md:col-span-4";
    case 3:
      return "md:col-span-3";
    case 2:
      return "md:col-span-2";
    default:
      return undefined;
  }
}

export function getRendererFullWidthSpanClass(columns: number | undefined) {
  return getRendererFieldSpanClass(
    { key: "__layout__", valueType: "string", layoutFraction: 1 },
    columns,
  );
}
