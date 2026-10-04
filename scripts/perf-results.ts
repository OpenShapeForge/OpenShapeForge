// SPDX-License-Identifier: BUSL-1.1
export type PerfMetric = {
  count?: number; value?: number; thresholds?: Record<string, boolean>;
  [key: string]: number | Record<string, boolean> | undefined;
};
export type PerfSummary = { metrics: Record<string, PerfMetric> };
export const PERF_OPERATIONS = ["create", "get", "list", "update", "delete"] as const;

/** Legacy k6 summary booleans are breaches: true means a failed threshold. */
export function performanceVerdict(summary: PerfSummary | null, slugs: readonly string[], exitCode: number) {
  const breaches = Object.entries(summary?.metrics ?? {}).flatMap(([metric, stats]) =>
    Object.entries(stats.thresholds ?? {}).filter(([, breached]) => breached).map(([threshold]) => ({ metric, threshold })),
  );
  const missingCoverage = slugs.flatMap(entity => PERF_OPERATIONS.filter(op =>
    !((summary?.metrics[`operation_success{entity:${entity},op:${op}}`]?.count ?? 0) > 0),
  ).map(op => ({ entity, op })));
  const missingLifecycles = slugs.filter(entity => !((summary?.metrics[`lifecycle_completed{entity:${entity}}`]?.count ?? 0) > 0));
  return { passed: exitCode === 0 && summary !== null && breaches.length === 0 && missingCoverage.length === 0 && missingLifecycles.length === 0,
    thresholdBreaches: breaches, missingCoverage, missingLifecycles };
}
