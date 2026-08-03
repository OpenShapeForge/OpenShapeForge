// SPDX-License-Identifier: BUSL-1.1
/**
 * The timer node's deadline arithmetic, without a database.
 *
 * `computeTimerDeadline` is pure precisely so weekend arithmetic and the
 * config-validation gaps below can be pinned here rather than proved through a
 * parked instance and a sweep. The integration side — that a parked run resumes
 * once and does not recompute its deadline — is covered separately.
 *
 * Run (repo root):
 *   set -o pipefail; bun test examples/plugins/workflow/runtime/__tests__/timer-deadline.unit.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { computeTimerDeadline } from "../timer-bridge.js";

/** A Wednesday, so a +2 day step lands inside the week and +4 crosses a weekend. */
const WEDNESDAY = new Date("2026-03-04T09:00:00.000Z");
/** A Thursday, so +2 working days must skip Saturday and Sunday to reach Monday. */
const THURSDAY = new Date("2026-03-05T09:00:00.000Z");

describe("computeTimerDeadline", () => {
  test("defaults to one day when nothing is configured", () => {
    // Every field is nullish at runtime — `flow/timer.yaml` declares no
    // `runtime.required` — so an empty config is a shape this must handle.
    expect(computeTimerDeadline({}, WEDNESDAY).toISOString()).toBe("2026-03-05T09:00:00.000Z");
  });

  test("counts minutes, hours and days", () => {
    expect(
      computeTimerDeadline(
        { mode: "duration", durationAmount: 90, durationUnit: "minutes" },
        WEDNESDAY,
      ).toISOString(),
    ).toBe("2026-03-04T10:30:00.000Z");

    expect(
      computeTimerDeadline(
        { mode: "duration", durationAmount: 6, durationUnit: "hours" },
        WEDNESDAY,
      ).toISOString(),
    ).toBe("2026-03-04T15:00:00.000Z");

    expect(
      computeTimerDeadline(
        { mode: "duration", durationAmount: 2, durationUnit: "days" },
        WEDNESDAY,
      ).toISOString(),
    ).toBe("2026-03-06T09:00:00.000Z");
  });

  test("skipWeekends extends a span that crosses a weekend rather than absorbing it", () => {
    // Thursday + 2 working days. Friday is the first; Saturday and Sunday are
    // skipped; Monday is the second. A multiply-then-adjust implementation
    // would land on Saturday and then only nudge to Monday, which happens to
    // agree here — so the Friday case below is the one that separates them.
    expect(
      computeTimerDeadline(
        { mode: "duration", durationAmount: 2, durationUnit: "days", skipWeekends: true },
        THURSDAY,
      ).toISOString(),
    ).toBe("2026-03-09T09:00:00.000Z");

    // One working day from Friday is Monday, not Saturday.
    const friday = new Date("2026-03-06T09:00:00.000Z");
    expect(
      computeTimerDeadline(
        { mode: "duration", durationAmount: 1, durationUnit: "days", skipWeekends: true },
        friday,
      ).toISOString(),
    ).toBe("2026-03-09T09:00:00.000Z");

    // Time of day survives the skipping.
    expect(
      computeTimerDeadline(
        { mode: "duration", durationAmount: 1, durationUnit: "days", skipWeekends: true },
        new Date("2026-03-06T23:45:00.000Z"),
      ).toISOString(),
    ).toBe("2026-03-09T23:45:00.000Z");
  });

  test("skipWeekends is ignored unless the unit is days", () => {
    // The authored field is only visible for days; a definition saved before
    // the unit changed can still carry it, and hours must not be reinterpreted.
    expect(
      computeTimerDeadline(
        { mode: "duration", durationAmount: 48, durationUnit: "hours", skipWeekends: true },
        new Date("2026-03-06T09:00:00.000Z"),
      ).toISOString(),
    ).toBe("2026-03-08T09:00:00.000Z");
  });

  test("until mode takes the configured moment, including one already past", () => {
    expect(
      computeTimerDeadline(
        { mode: "until", untilAt: "2026-04-01T12:00:00.000Z" },
        WEDNESDAY,
      ).toISOString(),
    ).toBe("2026-04-01T12:00:00.000Z");

    // Not an error: "wait until a moment that has passed" is satisfied at once,
    // and the bridge claims it in the same transaction rather than parking.
    expect(
      computeTimerDeadline(
        { mode: "until", untilAt: "2020-01-01T00:00:00.000Z" },
        WEDNESDAY,
      ).toISOString(),
    ).toBe("2020-01-01T00:00:00.000Z");
  });

  test("a zero duration is due immediately rather than silently becoming the default", () => {
    // The authored `min: 1` is an object rather than a scalar, so the runtime
    // schema builder never enforces it and 0 arrives here. Substituting the
    // default would invent a day-long wait nobody asked for.
    expect(
      computeTimerDeadline(
        { mode: "duration", durationAmount: 0, durationUnit: "days" },
        WEDNESDAY,
      ).toISOString(),
    ).toBe(WEDNESDAY.toISOString());
  });

  test("refuses config it cannot act on", () => {
    expect(() => computeTimerDeadline({ mode: "until" }, WEDNESDAY)).toThrow(/no untilAt/);
    expect(() =>
      computeTimerDeadline({ mode: "until", untilAt: "not a date" }, WEDNESDAY),
    ).toThrow(/unparseable untilAt/);
    expect(() => computeTimerDeadline({ mode: "sideways" }, WEDNESDAY)).toThrow(/unknown mode/);
    expect(() =>
      computeTimerDeadline(
        { mode: "duration", durationAmount: 1, durationUnit: "fortnights" },
        WEDNESDAY,
      ),
    ).toThrow(/unknown durationUnit/);
    expect(() =>
      computeTimerDeadline(
        { mode: "duration", durationAmount: -3, durationUnit: "days" },
        WEDNESDAY,
      ),
    ).toThrow(/invalid durationAmount/);
  });
});
