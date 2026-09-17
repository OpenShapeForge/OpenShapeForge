// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeModule } from "@openshapeforge/plugin-runtime";
import { createDocument, createDocumentVersion } from "./commands.js";
import { composeTemplate, materializeFields, materializeTemplate } from "./content-runtime.js";
import { createDocumentFromTemplate } from "./template-document.js";
import { renderSnapshot } from "./render-runtime.js";
import { registerPublishFollower } from "@openshapeforge/versioning/followers";
import { followTemplatePublish } from "./revision-follow.js";
import { publishRevision } from "./revision-publish.js";
import { startRevision } from "./revision-start.js";

// Draft revisions move to a republished template inside the publish transaction.
registerPublishFollower("Template", followTemplatePublish);

const module = {
  name: "documents",
  operationHandlers: {
    createDocument,
    createDocumentVersion,
    composeTemplate,
    materializeFields,
    materializeTemplate,
    createDocumentFromTemplate,
    renderSnapshot,
    startRevision,
    publishRevision,
  },
} satisfies RuntimeModule;

export default module;
export { createDocument, createDocumentVersion } from "./commands.js";
export { createDocumentFromTemplate, type TemplateDocumentResult } from "./template-document.js";
