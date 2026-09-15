// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeModule } from "@openshapeforge/plugin-runtime";
import { createDocument, createDocumentVersion } from "./commands.js";
import { composeTemplate, materializeFields, materializeTemplate } from "./content-runtime.js";
import { createDocumentFromTemplate } from "./template-document.js";
import { renderSnapshot } from "./render-runtime.js";

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
  },
} satisfies RuntimeModule;

export default module;
export { createDocument, createDocumentVersion } from "./commands.js";
export { createDocumentFromTemplate, type TemplateDocumentResult } from "./template-document.js";
