// @ts-nocheck
/**
 * Barrel re-export for app-level generators — layout and view-driven page generation.
 *
 * Preserves the original import path (`./app.js`) used by `generators/index.ts` and
 * other consumers. The actual implementations live in `layout.ts` and `pages.ts`.
 */
export { GENERATED_ROUTE_GROUP, generateLayout } from "./layout.js";
export { generateViewPages } from "./pages.js";
export type { ViewPagesResult, EntityPageConfigBundle } from "./pages.js";
export { generateDynamicRoutes } from "./manifest.js";
export type { EntityManifestEntryData } from "./manifest.js";
