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

test("a discarded success-only chain cannot hide its failed job", async () => {
  const job = maintenanceJob(Promise.reject(new Error("success-only failure")));
  const logging = job.promise.then(() => "only success is logged");
  // Test owner suppresses noise without pretending a caller handled the refusal.
  void Promise.prototype.then.call(logging, undefined, () => undefined);
  await expect(drainMaintenanceJobs([job])).rejects.toThrow(
    "success-only failure",
  );
  expect(job.observed()).toBe(false);
});

test("a chained catch can reconcile the original failed job", async () => {
  const job = maintenanceJob(Promise.reject(new Error("chain refusal")));
  const recovered = await job.promise
    .then(() => "success")
    .catch((error) => {
      expect(error.message).toBe("chain refusal");
      return "reconciled";
    });
  expect(recovered).toBe("reconciled");
  expect(job.observed()).toBe(true);
  await expect(drainMaintenanceJobs([job])).resolves.toBeUndefined();
});
