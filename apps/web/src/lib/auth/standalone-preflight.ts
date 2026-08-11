// SPDX-License-Identifier: BUSL-1.1
import { validateProductionEnv } from "./validate-env";

Object.assign(process.env, {
  NODE_ENV: "production",
  NEXT_PHASE: "phase-production-server",
});
if (
  process.env.OPENSHAPEFORGE_LOCAL_PRODUCTION_PREVIEW === "true"
  && !process.env.HOSTNAME?.trim()
) {
  process.env.HOSTNAME = "127.0.0.1";
}
validateProductionEnv(process.env);
