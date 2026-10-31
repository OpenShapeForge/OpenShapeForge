// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { validateTemporalThreshold, type TemporalField } from "./temporal-threshold.js";

describe("temporal threshold authoring", () => {
  const root: TemporalField[] = [{ key: "stage", osfType: "Stage", persisted: {} }];
  const related = (entity: string): TemporalField[] | undefined => entity === "Stage"
    ? [{ key: "limit", osfType: "integer", persisted: {} }]
    : undefined;
  const valid = { kind: "temporalThreshold" as const, field: "stage", thresholdDays: "stage.limit" };

  test("validates a persisted relationship and its numeric threshold", () => {
    expect(() => validateTemporalThreshold(valid, root, related)).not.toThrow();
  });
  test("refuses arbitrary paths and missing or nonnumeric thresholds", () => {
    for (const thresholdDays of ["limit", "other.limit", "stage.missing", "stage.limit.extra"]) {
      expect(() => validateTemporalThreshold({ ...valid, thresholdDays }, root, related)).toThrow();
    }
    expect(() => validateTemporalThreshold(valid, root, () => [{ key: "limit", osfType: "string", persisted: {} }])).toThrow();
  });
  test("refuses collections, computed fields and unknown relationships", () => {
    expect(() => validateTemporalThreshold(valid, [{ ...root[0]!, cardinality: "collection" }], related)).toThrow();
    expect(() => validateTemporalThreshold(valid, [{ ...root[0]!, computed: {} }], related)).toThrow();
    expect(() => validateTemporalThreshold(valid, root, () => undefined)).toThrow();
  });
});
