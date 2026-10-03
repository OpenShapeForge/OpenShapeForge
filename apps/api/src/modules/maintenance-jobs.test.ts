// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { maintenanceJob, drainMaintenanceJobs, acknowledgeMaintenanceFailure } from "./maintenance-jobs.js";
test("discarded and caught failures fail the owner, successful discarded work drains", async () => {
  const discarded = maintenanceJob(Promise.reject(new Error("discarded")));
  await expect(drainMaintenanceJobs([discarded])).rejects.toThrow("discarded");
  const handled = maintenanceJob(Promise.reject(new Error("handled")));
  try {
    await handled.promise;
    throw new Error("expected refusal");
  } catch (error) {
    expect((error as Error).message).toBe("handled");
  }
  await expect(drainMaintenanceJobs([handled])).rejects.toThrow("handled");
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
});

test("a chained catch cannot report a failed seed as successful", async () => {
  const job = maintenanceJob(Promise.reject(new Error("chain refusal")));
  const recovered = await job.promise
    .then(() => "success")
    .catch((error) => {
      expect(error.message).toBe("chain refusal");
      return "reconciled";
    });
  expect(recovered).toBe("reconciled");
  await expect(drainMaintenanceJobs([job])).rejects.toThrow("chain refusal");
});

test("allSettled inspection cannot hide a failed seed", async () => {
  const job = maintenanceJob(Promise.reject(new Error("settled failure")));
  expect((await Promise.allSettled([job.promise]))[0]?.status).toBe("rejected");
  await expect(drainMaintenanceJobs([job])).rejects.toThrow("settled failure");
});

test("acknowledgment is explicit and limited to owned completed failures", async () => {
  const succeeded = maintenanceJob(Promise.resolve("done"));
  await succeeded.promise;
  expect(() => succeeded.acknowledge()).toThrow("completed failed");
  const failed = maintenanceJob(Promise.reject(new Error("reconciled")));
  await Promise.allSettled([failed.promise]);
  expect(() => acknowledgeMaintenanceFailure([failed], Promise.resolve())).toThrow("another owner");
  acknowledgeMaintenanceFailure([failed], failed.promise);
  await expect(drainMaintenanceJobs([failed])).resolves.toBeUndefined();
});
