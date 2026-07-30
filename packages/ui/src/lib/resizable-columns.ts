// SPDX-License-Identifier: BUSL-1.1
export interface ResizableColumnSizing {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  weight?: number;
}

const DEFAULT_MIN_WIDTH = 220;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundWidth(value: number): number {
  return Number(value.toFixed(2));
}

function getColumnMinWidth(column: ResizableColumnSizing): number {
  if (column.minWidth !== undefined) {
    return column.minWidth;
  }

  if (column.defaultWidth !== undefined) {
    return Math.min(column.defaultWidth, DEFAULT_MIN_WIDTH);
  }

  return DEFAULT_MIN_WIDTH;
}

function getColumnMaxWidth(column: ResizableColumnSizing): number {
  return column.maxWidth ?? Number.POSITIVE_INFINITY;
}

function getGrowthWeight(column: ResizableColumnSizing): number {
  if (column.weight !== undefined) {
    return column.weight;
  }

  return column.defaultWidth === undefined ? 1 : 0;
}

function getAvailableWidth(
  containerWidth: number,
  columnCount: number,
  gutterWidth: number,
): number {
  return Math.max(containerWidth - Math.max(columnCount - 1, 0) * gutterWidth, 0);
}

export function fitResizableColumnWidths(
  requestedWidths: number[],
  columns: ResizableColumnSizing[],
  availableWidth: number,
): number[] {
  if (columns.length === 0) {
    return [];
  }

  const widths = requestedWidths.map((requestedWidth, index) =>
    clamp(
      requestedWidth,
      getColumnMinWidth(columns[index]),
      getColumnMaxWidth(columns[index]),
    ),
  );

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const totalWidth = widths.reduce((sum, width) => sum + width, 0);
    const diff = availableWidth - totalWidth;

    if (Math.abs(diff) < 0.5) {
      break;
    }

    if (diff > 0) {
      let candidates = widths
        .map((width, index) => ({
          index,
          capacity: getColumnMaxWidth(columns[index]) - width,
          weight: getGrowthWeight(columns[index]),
        }))
        .filter((candidate) => candidate.capacity > 0.5 && candidate.weight > 0);

      if (candidates.length === 0) {
        candidates = widths
          .map((width, index) => ({
            index,
            capacity: getColumnMaxWidth(columns[index]) - width,
            weight: 1,
          }))
          .filter((candidate) => candidate.capacity > 0.5);
      }

      if (candidates.length === 0) {
        break;
      }

      const totalWeight = candidates.reduce(
        (sum, candidate) => sum + candidate.weight,
        0,
      );
      let remaining = diff;

      for (const candidate of candidates) {
        const proportionalShare = diff * (candidate.weight / totalWeight);
        const change = Math.min(candidate.capacity, proportionalShare);
        widths[candidate.index] += change;
        remaining -= change;
      }

      if (remaining > 0.5) {
        for (const candidate of candidates) {
          const extraCapacity =
            getColumnMaxWidth(columns[candidate.index]) - widths[candidate.index];
          if (extraCapacity <= 0.5) {
            continue;
          }

          const change = Math.min(extraCapacity, remaining);
          widths[candidate.index] += change;
          remaining -= change;

          if (remaining <= 0.5) {
            break;
          }
        }
      }

      continue;
    }

    const shortage = Math.abs(diff);
    const candidates = widths
      .map((width, index) => ({
        index,
        capacity: width - getColumnMinWidth(columns[index]),
      }))
      .filter((candidate) => candidate.capacity > 0.5);

    if (candidates.length === 0) {
      break;
    }

    const totalCapacity = candidates.reduce(
      (sum, candidate) => sum + candidate.capacity,
      0,
    );
    let remaining = shortage;

    for (const candidate of candidates) {
      const proportionalShare = shortage * (candidate.capacity / totalCapacity);
      const change = Math.min(candidate.capacity, proportionalShare);
      widths[candidate.index] -= change;
      remaining -= change;
    }

    if (remaining > 0.5) {
      for (const candidate of candidates) {
        const extraCapacity =
          widths[candidate.index] - getColumnMinWidth(columns[candidate.index]);
        if (extraCapacity <= 0.5) {
          continue;
        }

        const change = Math.min(extraCapacity, remaining);
        widths[candidate.index] -= change;
        remaining -= change;

        if (remaining <= 0.5) {
          break;
        }
      }
    }
  }

  return widths.map(roundWidth);
}

export function buildResizableColumnWidths(
  containerWidth: number,
  columns: ResizableColumnSizing[],
  gutterWidth: number,
): number[] {
  const availableWidth = getAvailableWidth(
    containerWidth,
    columns.length,
    gutterWidth,
  );

  if (columns.length === 0) {
    return [];
  }

  const fixedWidth = columns.reduce(
    (sum, column) => sum + (column.defaultWidth ?? 0),
    0,
  );
  const flexibleColumns = columns.filter(
    (column) => column.defaultWidth === undefined,
  );
  const totalWeight =
    flexibleColumns.reduce((sum, column) => sum + (column.weight ?? 1), 0) || 1;
  const remainingWidth = Math.max(availableWidth - fixedWidth, 0);

  const requestedWidths = columns.map((column) => {
    if (column.defaultWidth !== undefined) {
      return column.defaultWidth;
    }

    return remainingWidth * ((column.weight ?? 1) / totalWeight);
  });

  return fitResizableColumnWidths(requestedWidths, columns, availableWidth);
}

export function scaleResizableColumnWidths(
  widths: number[],
  containerWidth: number,
  columns: ResizableColumnSizing[],
  gutterWidth: number,
): number[] {
  const availableWidth = getAvailableWidth(
    containerWidth,
    columns.length,
    gutterWidth,
  );
  const currentTotal = widths.reduce((sum, width) => sum + width, 0);

  if (currentTotal <= 0) {
    return buildResizableColumnWidths(containerWidth, columns, gutterWidth);
  }

  const scaledWidths = widths.map(
    (width) => width * (availableWidth / currentTotal),
  );
  return fitResizableColumnWidths(scaledWidths, columns, availableWidth);
}

export function resizeResizableColumnWidths(
  widths: number[],
  columns: ResizableColumnSizing[],
  handleIndex: number,
  delta: number,
): number[] {
  const nextWidths = [...widths];
  const leftColumn = columns[handleIndex];
  const rightColumn = columns[handleIndex + 1];

  if (!leftColumn || !rightColumn) {
    return nextWidths;
  }

  const pairTotal = widths[handleIndex] + widths[handleIndex + 1];
  const nextLeftWidth = clamp(
    widths[handleIndex] + delta,
    getColumnMinWidth(leftColumn),
    getColumnMaxWidth(leftColumn),
  );

  let resolvedLeftWidth = nextLeftWidth;
  let resolvedRightWidth = pairTotal - resolvedLeftWidth;

  if (resolvedRightWidth < getColumnMinWidth(rightColumn)) {
    resolvedRightWidth = getColumnMinWidth(rightColumn);
    resolvedLeftWidth = pairTotal - resolvedRightWidth;
  }

  if (resolvedRightWidth > getColumnMaxWidth(rightColumn)) {
    resolvedRightWidth = getColumnMaxWidth(rightColumn);
    resolvedLeftWidth = pairTotal - resolvedRightWidth;
  }

  resolvedLeftWidth = clamp(
    resolvedLeftWidth,
    getColumnMinWidth(leftColumn),
    getColumnMaxWidth(leftColumn),
  );
  resolvedRightWidth = pairTotal - resolvedLeftWidth;

  nextWidths[handleIndex] = roundWidth(resolvedLeftWidth);
  nextWidths[handleIndex + 1] = roundWidth(resolvedRightWidth);
  return nextWidths;
}
