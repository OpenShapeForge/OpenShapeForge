// SPDX-License-Identifier: BUSL-1.1
import { fileURLToPath } from "node:url";
import { collectAuthoredModulePluginOperations } from "../generate-operations.js";
import { loadOperationCatalogs } from "./operation-catalog.js";

/** Compose provider projections alongside entity contracts in focused compiler tests. */
export function standaloneOperationFixture(authoringDir = fileURLToPath(new URL("../../config/authoring/", import.meta.url))) {
  const catalogs = loadOperationCatalogs(authoringDir).map(({ document }) => document);
  return { catalogs, operations: collectAuthoredModulePluginOperations(catalogs, { repoRoot: authoringDir, authoringDir, webPresent: true }) };
}
