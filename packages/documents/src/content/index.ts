// SPDX-License-Identifier: BUSL-1.1
export * from "./errors.js";
export { canonicalJson, CONTENT_LIMITS, hashCanonicalJson } from "./json.js";
export type { JsonObject, JsonPrimitive, JsonValue } from "./json.js";
export { materializeTemplateContent, materializeDocumentContent } from "./materialize.js";
export type * from "./types.js";
export {
  contentLanguage,
  defineContentTemplateVersion,
  resolveTemplateParameters,
  selectContentTemplateVariant,
  validateContentRegistry,
  validateContentValue,
} from "./validation.js";

export { captureInclusionContent, captureTemplateBlocks } from "./capture.js";
export type { CaptureHost, CaptureInclusionInput, CapturedInclusion, CaptureTemplateBlocksInput } from "./capture.js";
export {
  blockHash,
  holdsProtectedContent,
  inclusionCopyContent,
  isInclusionCopy,
  mergeInclusionCopy,
  normalizeLocalDraft,
  OBSOLETE_INCLUSION,
  readInclusionCopy,
  templateComposition,
} from "./inclusion-copy.js";
export type { CompositionOf, CopySourceEntry, InclusionCopy, InclusionMerge, LocalDraftOptions } from "./inclusion-copy.js";
