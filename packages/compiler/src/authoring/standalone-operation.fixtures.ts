// SPDX-License-Identifier: BUSL-1.1
import { fileURLToPath } from "node:url";
import { collectAuthoredModulePluginOperations } from "../generate-operations.js";
import { loadOperationCatalogs } from "./operation-catalog.js";
import { withRecordActionGrants } from "../record-action-grants.js";

/** Compose provider projections alongside entity contracts in focused compiler tests. */
export function standaloneOperationFixture(authoringDir = fileURLToPath(new URL("../../config/authoring/", import.meta.url))) {
  // No entity contracts here, so no entity declares the record-action axis:
  // the generated first-grant form is pruned, exactly as it is in a published
  // base build (record-action-grants.ts).
  const catalogs = withRecordActionGrants(
    loadOperationCatalogs(authoringDir).map(({ document }) => document), [],
  );
  return { catalogs, operations: collectAuthoredModulePluginOperations(catalogs, { repoRoot: authoringDir, authoringDir, webPresent: true }) };
}
