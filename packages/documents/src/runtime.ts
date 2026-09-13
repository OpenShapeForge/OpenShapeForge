// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeModule } from "@openshapeforge/plugin-runtime";
import { createDocument, createDocumentVersion } from "./commands.js";

const module = {
  name: "documents",
  operationHandlers: {
    createDocument,
    createDocumentVersion,
  },
} satisfies RuntimeModule;

export default module;
export { createDocument, createDocumentVersion } from "./commands.js";
