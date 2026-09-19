// SPDX-License-Identifier: BUSL-1.1
/**
 * Example compiler plugin: a versioned entity in a schema of its own.
 *
 * The plugin has no generators and no platform tables; what it ships is the
 * authoring layer beside it. `Notebook` declares `versioning:
 * publishedSnapshot` from module `notebook`, so its head and version tables
 * live in the `notebook` schema rather than in `erp`. That is the case the
 * generic publish runtime must handle without knowing the entity: the
 * compiler binds the exact storage into the manifest, and
 * `apps/api/src/graphql/__tests__/plugin-versioning.e2e.test.ts` publishes
 * through it and reads the version back.
 */
import type { CompilerPlugin } from "../../../packages/compiler/src/plugins.js";

const plugin: CompilerPlugin = { name: "notebook-example" };

export default plugin;
