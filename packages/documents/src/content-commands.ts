// SPDX-License-Identifier: BUSL-1.1
/** Document content commands, the follow-template rule and the inclusion write boundary (docs/document-content.md). */
export { applyTemplateVersion, planFollow, type ApplyContext, type FollowBlock, type FollowPlan, type FollowTemplateBlock } from "./document-follow.js";
export { linkTemplate, projectDocument } from "./document-link.js";
export { assertBlockInclusionRemoval, prepareBlockInclusionWrite, retainedInclusionProvenance, type InclusionActor, type InclusionWriteOptions, type RetainedInclusionProvenance } from "./inclusion-write.js";
