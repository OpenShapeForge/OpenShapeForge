// SPDX-License-Identifier: BUSL-1.1

import type { CompilerPlugin } from "../../packages/compiler/src/plugins.js";
import { SESSION_OPERATION_CONTRACTS } from "./operations.js";

const plugin = {
  name: "session",
  operations: SESSION_OPERATION_CONTRACTS,
} satisfies CompilerPlugin;

export default plugin;
