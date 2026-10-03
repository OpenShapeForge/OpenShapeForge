// SPDX-License-Identifier: BUSL-1.1
/** Drain registered seed work; failures require explicit owner acknowledgment. */
export function maintenanceJob<T>(work: Promise<T>) {
  let failed = false;
  let acknowledged = false;
  // Suppress noise until owner drainage; promise handlers never acknowledge failure.
  void work.catch(() => { failed = true; });
  return {
    promise: work, work,
    acknowledge() {
      if (!failed) throw new Error("Only a completed failed maintenance run can be acknowledged.");
      acknowledged = true;
    },
    acknowledged: () => acknowledged,
  };
}
export function acknowledgeMaintenanceFailure(jobs: ReturnType<typeof maintenanceJob>[], promise: Promise<unknown>): void {
  const job = jobs.find((entry) => entry.promise === promise);
  if (!job) throw new Error("Maintenance failure belongs to another owner.");
  job.acknowledge();
}
export async function drainMaintenanceJobs(
  jobs: ReturnType<typeof maintenanceJob>[],
): Promise<void> {
  const results = await Promise.allSettled(jobs.map((job) => job.work));
  const failed = results.find((result, index) => result.status === "rejected" && !jobs[index]!.acknowledged());
  if (failed?.status === "rejected") throw failed.reason;
}
