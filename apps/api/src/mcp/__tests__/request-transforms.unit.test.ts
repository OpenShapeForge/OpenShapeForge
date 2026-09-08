// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { applyRequestTransforms } from "../request-transforms.js";

const recurrenceStep = {
  op: "ical-recurrence",
  from: "repeat",
  to: "recurrence",
  timeZoneTo: ["startTimeZone", "endTimeZone"],
  fields: {
    frequency: "frequency",
    interval: "interval",
    weekdays: "weekdays",
    end: "end",
    timeZone: "timeZone",
    endMode: "mode",
    endDate: "date",
    endCount: "count",
  },
  values: {
    frequencies: { weekly: "WEEKLY" },
    weekdays: { friday: "FR" },
    endModes: { never: "NEVER", on_date: "UNTIL", after_count: "COUNT" },
  },
};

describe("applyRequestTransforms", () => {
  it("moves nested values without leaving the wrapper in the provider body", () => {
    expect(
      applyRequestTransforms(
        { changes: { title: "New", time: { start: "2026-09-11T14:00:00+02:00" } } },
        [
          { op: "move", from: "changes.title", to: "title" },
          { op: "move", from: "changes.time.start", to: "start" },
        ],
      ),
    ).toEqual({ title: "New", start: "2026-09-11T14:00:00+02:00" });
  });

  it("builds one weekly iCalendar rule and carries its IANA zone", () => {
    expect(
      applyRequestTransforms(
        {
          start: "2026-09-11T14:00:00+02:00",
          end: "2026-09-11T15:00:00+02:00",
          repeat: {
            frequency: "weekly",
            interval: 1,
            weekdays: ["friday"],
            end: { mode: "never" },
            timeZone: "Europe/Amsterdam",
          },
        },
        [recurrenceStep],
      ),
    ).toEqual({
      start: "2026-09-11T14:00:00+02:00",
      end: "2026-09-11T15:00:00+02:00",
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=FR"],
      startTimeZone: "Europe/Amsterdam",
      endTimeZone: "Europe/Amsterdam",
    });
  });

  it("renders an inclusive local end date as a UTC UNTIL instant", () => {
    const result = applyRequestTransforms(
      {
        start: "2026-09-11T14:00:00+02:00",
        end: "2026-09-11T15:00:00+02:00",
        repeat: {
          frequency: "weekly",
          weekdays: ["friday"],
          end: { mode: "on_date", date: "2026-10-30" },
          timeZone: "Europe/Amsterdam",
        },
      },
      [recurrenceStep],
    );
    expect(result.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261030T225959Z"]);
  });

  it("rejects malformed weekly and counted recurrence input", () => {
    expect(() =>
      applyRequestTransforms(
        {
          repeat: {
            frequency: "weekly",
            end: { mode: "after_count", count: 0 },
            timeZone: "Europe/Amsterdam",
          },
        },
        [recurrenceStep],
      ),
    ).toThrow("weekly recurrence needs at least one weekday");
    expect(() =>
      applyRequestTransforms(
        {
          repeat: {
            frequency: "weekly",
            weekdays: ["friday"],
            end: { mode: "on_date", date: "2026-02-30" },
            timeZone: "Europe/Amsterdam",
          },
        },
        [recurrenceStep],
      ),
    ).toThrow("real calendar date");
  });

  it("moves only a coherent time range and rejects a mismatched zone offset", () => {
    const step = {
      op: "time-range",
      from: "changes.time",
      startTo: "start",
      endTo: "end",
      timeZoneTo: ["startZone", "endZone"],
    };
    expect(
      applyRequestTransforms(
        {
          changes: {
            time: {
              start: "2026-09-11T14:00:00+02:00",
              end: "2026-09-11T15:00:00+02:00",
              timeZone: "Europe/Amsterdam",
            },
          },
        },
        [step],
      ),
    ).toEqual({
      start: "2026-09-11T14:00:00+02:00",
      end: "2026-09-11T15:00:00+02:00",
      startZone: "Europe/Amsterdam",
      endZone: "Europe/Amsterdam",
    });
    expect(() =>
      applyRequestTransforms(
        {
          changes: {
            time: {
              start: "2026-09-11T14:00:00Z",
              end: "2026-09-11T15:00:00Z",
              timeZone: "Europe/Amsterdam",
            },
          },
        },
        [step],
      ),
    ).toThrow("offsets must agree");
  });
});
