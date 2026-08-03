// SPDX-License-Identifier: BUSL-1.1
/**
 * One entry point, several roles. `OPENSHAPEFORGE_ROLE` picks which; `api` is
 * the default, so an existing deployment keeps starting the server it always
 * did without setting anything.
 *
 * Any other value is looked up among the worker roles the loaded runtime
 * modules contribute (see `roles/worker.ts`). `apps/api` deliberately names
 * none of them: the workflow plugin contributes `workflow-worker`, and a repo
 * that drops the plugin loses the role with it rather than keeping a dangling
 * import here.
 */
import { startApiRole } from "./roles/api.js";
import { runWorkerRole } from "./roles/worker.js";

const role = process.env.OPENSHAPEFORGE_ROLE?.trim() || "api";

if (role === "api") {
  await startApiRole();
} else {
  await runWorkerRole(role);
}
