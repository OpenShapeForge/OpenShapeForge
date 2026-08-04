// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  buildRoundedRoutePath,
  getRouteInnerPointsSnappedToHandles,
  getRouteLabelPoint,
  normalizeRoutePoints,
  projectPointOntoPolyline,
} from "../edge-route-path.js";

describe("normalizeRoutePoints", () => {
  test("returns short routes untouched", () => {
    expect(normalizeRoutePoints([])).toEqual([]);
    expect(normalizeRoutePoints([{ x: 3, y: 4 }])).toEqual([{ x: 3, y: 4 }]);
  });

  test("bridges a diagonal with an axis-aligned corner", () => {
    expect(
      normalizeRoutePoints([
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 20 },
      { x: 10, y: 20 },
    ]);
  });

  test("drops repeated points", () => {
    expect(
      normalizeRoutePoints([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 0, y: 10 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]);
  });

  test("drops collinear midpoints on both axes", () => {
    expect(
      normalizeRoutePoints([
        { x: 0, y: 0 },
        { x: 0, y: 5 },
        { x: 0, y: 10 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ]);

    expect(
      normalizeRoutePoints([
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  test("keeps a real corner", () => {
    const corner = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ];
    expect(normalizeRoutePoints(corner)).toEqual(corner);
  });
});

describe("getRouteLabelPoint", () => {
  test("falls back to the origin for an empty route", () => {
    expect(getRouteLabelPoint([])).toEqual({ x: 0, y: 0 });
  });

  test("returns the only point when the route has no length", () => {
    expect(
      getRouteLabelPoint([
        { x: 7, y: 9 },
        { x: 7, y: 9 },
      ]),
    ).toEqual({ x: 7, y: 9 });
  });

  test("halves a single segment", () => {
    expect(
      getRouteLabelPoint([
        { x: 0, y: 0 },
        { x: 0, y: 100 },
      ]),
    ).toEqual({ x: 0, y: 50 });
  });

  test("measures by arc length, not by segment index", () => {
    // Two segments: 10 down, then 90 across. Halfway (50) lands on the second.
    expect(
      getRouteLabelPoint([
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 90, y: 10 },
      ]),
    ).toEqual({ x: 40, y: 10 });
  });
});

describe("getRouteInnerPointsSnappedToHandles", () => {
  const source = { x: 100, y: 0 };
  const target = { x: 200, y: 300 };

  test("has nothing to snap when there are no inner points", () => {
    expect(
      getRouteInnerPointsSnappedToHandles(
        [
          { x: 0, y: 0 },
          { x: 0, y: 10 },
        ],
        source,
        target,
      ),
    ).toEqual([]);
  });

  test("pulls the leading and trailing runs onto the handle x", () => {
    const points = [
      { x: 10, y: 0 },
      { x: 10, y: 50 },
      { x: 60, y: 50 },
      { x: 60, y: 300 },
    ];

    expect(getRouteInnerPointsSnappedToHandles(points, source, target)).toEqual([
      { x: 100, y: 50 },
      { x: 200, y: 50 },
    ]);
  });

  test("does not mutate the input route", () => {
    const points = [
      { x: 10, y: 0 },
      { x: 10, y: 50 },
      { x: 10, y: 100 },
    ];
    const before = structuredClone(points);
    getRouteInnerPointsSnappedToHandles(points, source, target);
    expect(points).toEqual(before);
  });
});

describe("projectPointOntoPolyline", () => {
  const polyline = [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
  ];

  test("needs at least one segment", () => {
    expect(projectPointOntoPolyline({ x: 0, y: 0 }, [{ x: 0, y: 0 }])).toBeNull();
  });

  test("clamps to the nearest point on the nearest segment", () => {
    expect(projectPointOntoPolyline({ x: 40, y: 30 }, polyline)).toEqual({
      x: 0,
      y: 30,
    });
    expect(projectPointOntoPolyline({ x: 60, y: 130 }, polyline)).toEqual({
      x: 60,
      y: 100,
    });
  });

  test("clamps past the end of a segment rather than extrapolating", () => {
    expect(projectPointOntoPolyline({ x: -50, y: -50 }, polyline)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("buildRoundedRoutePath", () => {
  test("is empty for an empty route", () => {
    expect(buildRoundedRoutePath([], 8)).toBe("");
  });

  test("is a bare move for a single point", () => {
    expect(buildRoundedRoutePath([{ x: 5, y: 6 }], 8)).toBe("M5 6");
  });

  test("draws a straight segment", () => {
    expect(
      buildRoundedRoutePath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 40 },
        ],
        8,
      ),
    ).toBe("M0 0L0 40");
  });

  test("rounds every corner with a quadratic", () => {
    expect(
      buildRoundedRoutePath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 100 },
          { x: 100, y: 100 },
          { x: 100, y: 50 },
        ],
        10,
      ),
    ).toBe("M0 0L0 90Q0 100 10 100L90 100Q100 100 100 90L100 50");
  });

  test("clamps the radius to half the shorter leg", () => {
    expect(
      buildRoundedRoutePath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 4 },
          { x: 40, y: 4 },
        ],
        10,
      ),
    ).toBe("M0 0L0 2Q0 4 2 4L40 4");
  });

  test("keeps the final downward approach square", () => {
    // Last turn before arriving from above: a rounded corner there reads as a
    // kink under the arrowhead, so it stays a hard corner.
    expect(
      buildRoundedRoutePath(
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
        ],
        10,
      ),
    ).toBe("M0 0L100 0L100 100");
  });

  test("normalizes before drawing", () => {
    expect(
      buildRoundedRoutePath(
        [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
          { x: 0, y: 20 },
          { x: 0, y: 40 },
        ],
        10,
      ),
    ).toBe("M0 0L0 40");
  });
});
