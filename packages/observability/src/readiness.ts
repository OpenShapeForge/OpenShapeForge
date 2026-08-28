// SPDX-License-Identifier: BUSL-1.1

export type ReadinessCheck = {
  name: string;
  check(): Promise<void> | void;
};

export type ReadinessCheckResult = {
  name: string;
  status: "ready" | "not_ready";
  error?: unknown;
};

export type ReadinessResult = {
  ready: boolean;
  checks: ReadinessCheckResult[];
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Readiness check timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
/** Run every dependency check so one outage does not hide another. */
export async function runReadinessChecks(
  checks: readonly ReadinessCheck[],
  timeoutMs = 5_000,
): Promise<ReadinessResult> {
  const results = await Promise.all(
    checks.map(async (entry): Promise<ReadinessCheckResult> => {
      try {
        await withTimeout(Promise.resolve(entry.check()), timeoutMs);
        return { name: entry.name, status: "ready" };
      } catch (error) {
        return { name: entry.name, status: "not_ready", error };
      }
    }),
  );
  return {
    ready: results.every((entry) => entry.status === "ready"),
    checks: results,
  };
}

/** Only names and statuses cross the health boundary; diagnostics stay local. */
export function publicReadinessBody(result: ReadinessResult) {
  return {
    status: result.ready ? "ready" : "not_ready",
    checks: Object.fromEntries(
      result.checks.map((entry) => [entry.name, entry.status]),
    ),
  };
}
