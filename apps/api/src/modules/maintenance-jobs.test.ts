// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { maintenanceJob, drainMaintenanceJobs } from "./maintenance-jobs.js";
test("discarded failure surfaces, awaited failure can reconcile, successful discarded work drains", async () => {
  const discarded = maintenanceJob(Promise.reject(new Error("discarded")));
  await expect(drainMaintenanceJobs([discarded])).rejects.toThrow("discarded");
  const handled = maintenanceJob(Promise.reject(new Error("handled")));
  try {
    await handled.promise;
    throw new Error("expected refusal");
  } catch (error) {
    expect((error as Error).message).toBe("handled");
  }
  await expect(drainMaintenanceJobs([handled])).resolves.toBeUndefined();
  let done = false;
  const pending = maintenanceJob(
    new Promise<void>((resolve) =>
      setTimeout(() => {
        done = true;
        resolve();
      }, 5),
    ),
  );
  await drainMaintenanceJobs([pending]);
  expect(done).toBe(true);
});
