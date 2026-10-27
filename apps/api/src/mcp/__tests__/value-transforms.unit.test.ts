// SPDX-License-Identifier: BUSL-1.1
/**
 * The single-value transforms. `source-version` turns a provider's change
 * marker into a sourceVersion whose text order is its change order — that is
 * what lets "highest sourceVersion per source" serve as the incremental-import
 * watermark. `date`, `sign`, `abs`, `number`, `prefix` and `lookup` turn
 * provider values into reference-data codes, numbers and plain dates without
 * provider knowledge.
 */
import { describe, expect, it } from "bun:test";
import { applyResponseTransforms } from "../response-transforms.js";
import { absolute, asNumber, asText, calendarDate, sign, sourceVersion } from "../value-transforms.js";
import { HttpError } from "../../rest/http-error.js";

describe("sourceVersion", () => {
  it("zero-pads integers so text order is numeric order", () => {
    const versions = [9, 10, 123456789012, "99", "000100"].map(sourceVersion);
    expect(versions[0]).toBe("00000000000000000009");
    expect(versions[4]).toBe("00000000000000000100");
    expect([...versions].sort()).toEqual(
      [9, 10, 99, 100, 123456789012].map((n) => String(n).padStart(20, "0")),
    );
  });

  it("normalises times to ISO UTC with milliseconds", () => {
    expect(sourceVersion("/Date(1600000000000)/")).toBe("2020-09-13T12:26:40.000Z");
    expect(sourceVersion("2020-09-13T14:26:40+02:00")).toBe("2020-09-13T12:26:40.000Z");
    expect(sourceVersion("2020-09-13T12:26:40.5Z")).toBe("2020-09-13T12:26:40.500Z");
  });

  it("yields null rather than a value that could sort wrongly", () => {
    for (const value of [null, undefined, -1, 1.5, "", "abc", "2020-09-13T12:26:40", "1".repeat(21), {}]) {
      expect(sourceVersion(value)).toBeNull();
    }
  });

  it("runs as a transform step, per item inside map", () => {
    const out = applyResponseTransforms(
      { lines: [{ Timestamp: 42 }, { Timestamp: "7" }] },
      [{ op: "map", from: "lines", steps: [{ op: "source-version", from: "Timestamp", to: "sourceVersion" }] }],
    );
    expect(out.lines).toEqual([
      { Timestamp: 42, sourceVersion: "00000000000000000042" },
      { Timestamp: "7", sourceVersion: "00000000000000000007" },
    ]);
  });
});

describe("date, sign, abs", () => {
  it("reads calendar dates from OData, zoned ISO and plain ISO dates", () => {
    expect(calendarDate("/Date(1600000000000)/")).toBe("2020-09-13");
    expect(calendarDate("2020-09-13T23:30:00-02:00")).toBe("2020-09-14");
    expect(calendarDate("2020-09-13")).toBe("2020-09-13");
    expect(calendarDate("13-09-2020")).toBeNull();
  });

  it("reads a zoneless local timestamp as its own date part", () => {
    expect(calendarDate("2026-01-13T00:00:00")).toBe("2026-01-13");
    expect(calendarDate("2026-01-13T23:59:59.997")).toBe("2026-01-13");
    // The zone rule for change markers is unchanged: no zone, no instant.
    expect(sourceVersion("2026-01-13T00:00:00")).toBeNull();
  });

  it("splits a signed amount into a side and a magnitude", () => {
    expect([-12.5, 0, 3, "-4", "x", null].map(sign)).toEqual(["negative", "zero", "positive", "negative", null, null]);
    expect([-12.5, "4", "", null].map(absolute)).toEqual([12.5, 4, null, null]);
  });

  it("reads a number from text, nothing else", () => {
    expect(["55", "-217.80", 3, "", "x", null].map(asNumber)).toEqual([55, -217.8, 3, null, null, null]);
  });

  it("reads a scalar as text, nothing else", () => {
    expect([1042, "abc", true, null, {}, Number.NaN].map(asText)).toEqual(["1042", "abc", "true", null, null, null]);
  });
});

describe("lookup", () => {
  const run = (value: unknown, step: Record<string, unknown>) =>
    applyResponseTransforms({ value }, [{ op: "lookup", from: "value", to: "out", ...step }]).out;

  it("translates codes as text, falling back to default, else null", () => {
    const values = { "20": "draft", "50": "posted" };
    expect(run(20, { values })).toBe("draft");
    expect(run("50", { values })).toBe("posted");
    expect(run(99, { values, default: "posted" })).toBe("posted");
    expect(run(99, { values })).toBeNull();
    expect(run(null, { values, default: "draft" })).toBe("draft");
  });

  it("never resolves a code through the object prototype", () => {
    expect(run("constructor", { values: {} })).toBeNull();
  });

  it("fails as SERVICE_MISCONFIGURED without a values table, or for a prototype op name", () => {
    for (const steps of [[{ op: "lookup", from: "value" }], [{ op: "constructor", from: "value" }]]) {
      try {
        applyResponseTransforms({ value: 1 }, steps);
        throw new Error("expected a failure");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).code).toBe("SERVICE_MISCONFIGURED");
      }
    }
  });
});

describe("prefix", () => {
  const run = (value: unknown, length: unknown) =>
    applyResponseTransforms({ value }, [{ op: "prefix", from: "value", to: "out", length }]).out;

  it("keeps the leading characters of text, null otherwise", () => {
    expect(run("BEivGokAndGok", 4)).toBe("BEiv");
    expect(run("WOm", 4)).toBe("WOm");
    expect(run(1042, 2)).toBeNull();
  });

  it("fails as SERVICE_MISCONFIGURED without a usable length", () => {
    for (const length of [undefined, 0, 1.5, 65, "4"]) {
      try {
        run("BEiv", length);
        throw new Error("expected a failure");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        expect((error as HttpError).code).toBe("SERVICE_MISCONFIGURED");
      }
    }
  });
});
