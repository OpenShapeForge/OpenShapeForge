// SPDX-License-Identifier: BUSL-1.1
import { runMaintenanceCommand } from "../modules/maintenance.js";
if (import.meta.main) {
  const value = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
  const contribution = value("--contribution"); const tenantSlug = value("--tenant"); const action = value("--action");
  if (!contribution || !tenantSlug || !action) throw new Error("Maintenance requires --contribution, --tenant and --action.");
  console.log(JSON.stringify(await runMaintenanceCommand({ contribution, tenantSlug, input: { action, ...(value("--date") ? { snapshotDate: value("--date") } : {}) }, appliedBy: "cli", confirmed: process.argv.includes("--confirm-seed") }), null, 2));
}
