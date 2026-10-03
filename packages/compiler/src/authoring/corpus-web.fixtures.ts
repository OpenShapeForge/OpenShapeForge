// SPDX-License-Identifier: BUSL-1.1
import { collectAuthoredModulePluginOperations } from "../generate-operations.js";
import { loadOperationCatalogs } from "./operation-catalog.js";

/** Real corpus projections include provider entities authored in module catalogs. */
export function corpusWebOperations(authoringDir: string) {
  const catalogs = loadOperationCatalogs(authoringDir).map(({ document }) => document);
  return {
    catalogs,
    operations: collectAuthoredModulePluginOperations(catalogs, {
      repoRoot: authoringDir,
      authoringDir,
      webPresent: true,
    }),
  };
}
