// SPDX-License-Identifier: BUSL-1.1
/** A read-time assessment of how long a field has held its present value. */
export type TemporalThresholdResult = {
  status: "within" | "exceeded" | "unknown" | "notApplicable";
  since: string | null;
  thresholdDays: number | null;
};

/**
 * Days are exact 24-hour intervals. The boundary itself is still within the
 * threshold: the value exceeds it only after the entire interval has passed.
 * Missing coverage and inaccessible inputs must be represented as unknown by
 * the caller, never as a fabricated timestamp or a negative answer.
 */
export function evaluateTemporalThreshold(input: {
  applicable: boolean;
  since: Date | null;
  thresholdDays: number | null;
  now: Date;
}): TemporalThresholdResult {
  if (!input.applicable || input.thresholdDays === null) {
    return { status: "notApplicable", since: null, thresholdDays: input.thresholdDays };
  }
  const timestamp = input.since?.getTime();
  const now = input.now.getTime();
  if (timestamp === undefined || !Number.isFinite(timestamp) || !Number.isFinite(now) ||
      !Number.isFinite(input.thresholdDays) || input.thresholdDays < 0 || timestamp > now) {
    return { status: "unknown", since: null, thresholdDays: input.thresholdDays };
  }
  return {
    status: now - timestamp > input.thresholdDays * 86_400_000 ? "exceeded" : "within",
    since: input.since!.toISOString(),
    thresholdDays: input.thresholdDays,
  };
}
