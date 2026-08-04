// SPDX-License-Identifier: BUSL-1.1
/**
 * Turns an edge route — a list of points — into the things a renderer needs:
 * a rounded SVG path, a midpoint for the label, and a projection used to pin a
 * hovering label onto the line.
 *
 * Pure geometry, deliberately. It has no consumer in this repository yet: the
 * canvas draws stock step edges, and a routed edge only becomes possible once
 * something computes route points. It is kept and tested here because the
 * geometry is the hard part and it is the same geometry either way.
 */
import type { EdgeRoutePoint } from "./edge-route-types";

/**
 * Inserts an axis-aligned bridge point between any two consecutive points that
 * share neither an x nor a y coordinate. Without this, a diagonal creeps into
 * an otherwise orthogonal route wherever a router's port position and a
 * measured handle position disagree by a pixel.
 */
function enforceOrthogonal(points: EdgeRoutePoint[]): EdgeRoutePoint[] {
  const first = points[0];
  if (!first || points.length < 2) return points;

  const result: EdgeRoutePoint[] = [first];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;

    if (previous.x !== current.x && previous.y !== current.y) {
      result.push({ x: previous.x, y: current.y });
    }
    result.push(current);
  }

  return result;
}

/**
 * Makes a route drawable: orthogonal, without repeated points, and without
 * collinear midpoints that would render as a corner with no turn in it.
 */
export function normalizeRoutePoints(points: EdgeRoutePoint[]): EdgeRoutePoint[] {
  const orthogonal = enforceOrthogonal(points);
  const deduped = orthogonal.filter((point, index) => {
    const previous = orthogonal[index - 1];
    return !previous || previous.x !== point.x || previous.y !== point.y;
  });

  return deduped.filter((point, index) => {
    if (index === 0 || index === deduped.length - 1) {
      return true;
    }

    const previous = deduped[index - 1];
    const next = deduped[index + 1];
    if (!previous || !next) {
      return true;
    }

    return !(
      (previous.x === point.x && point.x === next.x) ||
      (previous.y === point.y && point.y === next.y)
    );
  });
}

/** Steps `distance` from `from` along the axis that separates it from `to`. */
function movePointToward(
  from: EdgeRoutePoint,
  to: EdgeRoutePoint,
  distance: number,
): EdgeRoutePoint {
  if (from.x === to.x) {
    return {
      x: from.x,
      y: from.y + Math.sign(to.y - from.y) * distance,
    };
  }

  return {
    x: from.x + Math.sign(to.x - from.x) * distance,
    y: from.y,
  };
}

/** Manhattan length, which is the true length of an axis-aligned segment. */
function getRouteSegmentLength(start: EdgeRoutePoint, end: EdgeRoutePoint): number {
  return Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
}

/** The point halfway along the route, measured by arc length rather than index. */
export function getRouteLabelPoint(points: EdgeRoutePoint[]): EdgeRoutePoint {
  let totalLength = 0;
  const segmentLengths: number[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentLength = start && end ? getRouteSegmentLength(start, end) : 0;
    segmentLengths.push(segmentLength);
    totalLength += segmentLength;
  }

  if (totalLength <= 0) {
    return points[0] ?? { x: 0, y: 0 };
  }

  const halfway = totalLength / 2;
  let traversed = 0;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentLength = segmentLengths[index - 1] ?? 0;

    if (!start || !end || segmentLength <= 0) {
      continue;
    }

    if (traversed + segmentLength >= halfway) {
      return movePointToward(start, end, halfway - traversed);
    }

    traversed += segmentLength;
  }

  return points[points.length - 1] ?? { x: 0, y: 0 };
}

/**
 * Pulls the first and last runs of inner points onto the real handle x, so a
 * route computed against estimated port positions still leaves and enters its
 * handles dead straight.
 */
export function getRouteInnerPointsSnappedToHandles(
  points: EdgeRoutePoint[],
  sourcePoint: EdgeRoutePoint,
  targetPoint: EdgeRoutePoint,
): EdgeRoutePoint[] {
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  if (points.length <= 2 || !firstPoint || !lastPoint) {
    return [];
  }

  const innerPoints = points.slice(1, -1).map((point) => ({ ...point }));

  for (let index = 0; index < innerPoints.length; index += 1) {
    const point = innerPoints[index];
    if (!point || point.x !== firstPoint.x) {
      break;
    }
    point.x = sourcePoint.x;
  }

  for (let index = innerPoints.length - 1; index >= 0; index -= 1) {
    const point = innerPoints[index];
    if (!point || point.x !== lastPoint.x) {
      break;
    }
    point.x = targetPoint.x;
  }

  return innerPoints;
}

/**
 * Projects a flow-coordinate point onto the closest point of an axis-aligned
 * polyline. Used to anchor a label to the edge while it follows the cursor.
 */
export function projectPointOntoPolyline(
  target: EdgeRoutePoint,
  points: EdgeRoutePoint[],
): EdgeRoutePoint | null {
  if (points.length < 2) return null;

  let best: { point: EdgeRoutePoint; distance: number } | null = null;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) continue;

    let candidate: EdgeRoutePoint;
    if (start.x === end.x) {
      const minY = Math.min(start.y, end.y);
      const maxY = Math.max(start.y, end.y);
      candidate = { x: start.x, y: Math.max(minY, Math.min(maxY, target.y)) };
    } else if (start.y === end.y) {
      const minX = Math.min(start.x, end.x);
      const maxX = Math.max(start.x, end.x);
      candidate = { x: Math.max(minX, Math.min(maxX, target.x)), y: start.y };
    } else {
      // normalizeRoutePoints makes this unreachable for a normalized route;
      // an un-normalized caller gets the segment midpoint rather than nothing.
      candidate = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    }

    const dx = candidate.x - target.x;
    const dy = candidate.y - target.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (best === null || distance < best.distance) {
      best = { point: candidate, distance };
    }
  }

  return best?.point ?? null;
}

/** Renders a route as an SVG path, rounding each corner it can afford to. */
export function buildRoundedRoutePath(
  points: EdgeRoutePoint[],
  borderRadius: number,
): string {
  const normalizedPoints = normalizeRoutePoints(points);
  const startPoint = normalizedPoints[0];
  if (!startPoint) {
    return "";
  }

  if (normalizedPoints.length === 1) {
    return `M${startPoint.x} ${startPoint.y}`;
  }

  let path = `M${startPoint.x} ${startPoint.y}`;

  for (let index = 1; index < normalizedPoints.length - 1; index += 1) {
    const previous = normalizedPoints[index - 1];
    const current = normalizedPoints[index];
    const next = normalizedPoints[index + 1];
    if (!previous || !current || !next) continue;

    const previousLength = getRouteSegmentLength(previous, current);
    const nextLength = getRouteSegmentLength(current, next);
    const radius = Math.min(borderRadius, previousLength / 2, nextLength / 2);
    // The last turn before a downward arrival stays square: an arrowhead
    // pointing into a rounded corner reads as a kink rather than a corner.
    const isFinalDownwardTargetApproach =
      index === normalizedPoints.length - 2 &&
      previous.y === current.y &&
      current.x === next.x &&
      current.y < next.y;

    if (
      radius <= 0 ||
      isFinalDownwardTargetApproach ||
      (previous.x === current.x && current.x === next.x) ||
      (previous.y === current.y && current.y === next.y)
    ) {
      path += `L${current.x} ${current.y}`;
      continue;
    }

    const curveStart = movePointToward(current, previous, radius);
    const curveEnd = movePointToward(current, next, radius);
    path += `L${curveStart.x} ${curveStart.y}`;
    path += `Q${current.x} ${current.y} ${curveEnd.x} ${curveEnd.y}`;
  }

  const finalPoint = normalizedPoints[normalizedPoints.length - 1];
  if (finalPoint) {
    path += `L${finalPoint.x} ${finalPoint.y}`;
  }
  return path;
}
