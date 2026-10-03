// SPDX-License-Identifier: BUSL-1.1
/** Distinguish awaited/handled job refusals from discarded background failures. */
export function maintenanceJob<T>(work: Promise<T>) {
  let observed = false;
  class ObservedJob extends Promise<T> {
    static get [Symbol.species]() {
      return Promise;
    }
    override then<TResult1 = T, TResult2 = never>(
      fulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      observed = true;
      return super.then(fulfilled, rejected);
    }
  }
  const promise = new ObservedJob((resolve, reject) =>
    work.then(resolve, reject),
  );
  // Owner observation suppresses unhandled rejection noise but is not caller handling.
  void Promise.prototype.then.call(promise, undefined, () => undefined);
  return { promise, work, observed: () => observed };
}
export async function drainMaintenanceJobs(
  jobs: ReturnType<typeof maintenanceJob>[],
): Promise<void> {
  const results = await Promise.allSettled(jobs.map((job) => job.work));
  const discarded = results.find(
    (result, index) => result.status === "rejected" && !jobs[index]!.observed(),
  );
  if (discarded?.status === "rejected") throw discarded.reason;
}
