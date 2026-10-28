// SPDX-License-Identifier: BUSL-1.1
import { collectAuthoredModulePluginOperations } from "../generate-operations.js";
import { loadOperationCatalogs } from "./operation-catalog.js";
import { withRecordActionGrants } from "../record-action-grants.js";

/** Real corpus projections include provider entities authored in module catalogs. */
export function corpusWebOperations(authoringDir: string) {
  // Catalogs only, with no entity contracts to derive the record-action
  // registry from: the generated first-grant form is pruned the same way a
  // published base build prunes it (record-action-grants.ts).
  const catalogs = withRecordActionGrants(
    loadOperationCatalogs(authoringDir).map(({ document }) => document), [],
  );
  return {
    catalogs,
    operations: collectAuthoredModulePluginOperations(catalogs, {
      repoRoot: authoringDir,
      authoringDir,
      webPresent: true,
    }),
  };
}
