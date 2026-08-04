// SPDX-License-Identifier: BUSL-1.1
/**
 * Geometry vocabulary for a routed workflow edge.
 *
 * A "route" is an axis-aligned polyline through which an edge is drawn: the
 * points an auto-router produces, plus the bits of presentation an edge needs
 * to place its label on that polyline. Nothing here knows about React Flow, a
 * DOM, or a workflow — it is coordinates.
 */

/** Options for the rounded orthogonal path builder. */
export type SmoothStepPathOptions = {
  /** Corner radius, in flow units. Clamped per-corner to half the shorter leg. */
  borderRadius?: number;
  /** Reserved for callers that need to inset the route from its endpoints. */
  offset?: number;
};

/** A single point on an edge route, in flow coordinates. */
export type EdgeRoutePoint = {
  x: number;
  y: number;
};

/**
 * The presentation payload an edge carries when a router has computed its
 * route. Absent `routePoints`, a renderer falls back to the stock step path;
 * that fallback is what this repository draws today, because no router is
 * wired up yet.
 */
export type EdgeRouteData = {
  routePoints?: EdgeRoutePoint[];
  labelX?: number;
  labelY?: number;
  labelOffsetY?: number;
  labelZIndex?: number;
  alwaysShowLabel?: boolean;
};
