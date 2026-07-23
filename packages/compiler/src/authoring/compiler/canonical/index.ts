// @ts-nocheck
export * from "./types.js";
export { parseCanonicalPath, createCanonicalPath } from "./path.js";
export {
  normalizeCanonicalField,
  normalizeCanonicalFieldReference,
  normalizeCanonicalCondition,
  normalizeCanonicalActions,
  normalizeCanonicalPresentation,
  normalizeLegacyVisibilityConfig,
} from "./normalization.js";
export { buildCanonicalCompilerKernel } from "./bridge.js";
