// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeModule } from "@openshapeforge/plugin-runtime";
import { registerPublishFollower } from "@openshapeforge/versioning/followers";
import { createDocument, createDocumentVersion } from "./commands.js";
import { composeTemplate, materializeFields, materializeTemplate } from "./content-runtime.js";
import { createDocumentFromTemplate } from "./template-document.js";
import { renderSnapshot } from "./render-runtime.js";
import { followTemplatePublish } from "./document-follow.js";
import { linkTemplate } from "./document-link.js";
import { materializeDocument } from "./document-materialize.js";

let unregisterFollower: (() => void) | undefined;

/**
 * Documents move to a republished template inside the publish transaction.
 * The follower registry is process-global, so registration is an explicit
 * lifecycle step here rather than an import side effect, and it is idempotent
 * for hosts that initialise the module more than once.
 */
export function registerDocumentFollowers(): void {
  unregisterFollower ??= registerPublishFollower("Template", followTemplatePublish);
}

const module = {
  name: "documents",
  async init() { registerDocumentFollowers(); },
  async close() { unregisterFollower?.(); unregisterFollower = undefined; },
  operationHandlers: {
    createDocument,
    createDocumentVersion,
    composeTemplate,
    materializeFields,
    materializeTemplate,
    createDocumentFromTemplate,
    renderSnapshot,
    linkTemplate,
    materializeDocument,
  },
} satisfies RuntimeModule;

export default module;
export { appendDocumentVersion, createDocument, createDocumentVersion } from "./commands.js";
export { createDocumentFromTemplate, type TemplateDocumentResult } from "./template-document.js";
