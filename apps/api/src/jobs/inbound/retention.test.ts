// SPDX-License-Identifier: BUSL-1.1
/**
 * The payload retention configuration.
 *
 * The property that matters is that the OUTER bound cannot be configured away:
 * it bounds every SETTLED payload, and it is the age at which an unsettled one
 * is reported overdue. Which rows each window actually reaches is SQL and is
 * proved against a real database (db/__tests__/inbound-deliveries.test.ts).
 */
import { expect, test } from "bun:test";
import {
  DEFAULT_INBOUND_BODY_MAX_AGE_DAYS, DEFAULT_INBOUND_BODY_RETENTION_DAYS,
  inboundBodyRetention, MAX_INBOUND_BODY_MAX_AGE_DAYS,
} from "./retention.js";

test("the defaults bound a settled payload and flag an unsettled one", () => {
  expect(inboundBodyRetention({})).toEqual({
    retentionDays: DEFAULT_INBOUND_BODY_RETENTION_DAYS,
    maxAgeDays: DEFAULT_INBOUND_BODY_MAX_AGE_DAYS,
  });
});

test("both windows are configurable, and zero retention means at settlement", () => {
  expect(inboundBodyRetention({
    OPENSHAPEFORGE_INBOUND_BODY_RETENTION_DAYS: "0",
    OPENSHAPEFORGE_INBOUND_BODY_MAX_AGE_DAYS: "3",
  })).toEqual({ retentionDays: 0, maxAgeDays: 3 });
});

test("the outer bound cannot be switched off, only shortened or lengthened", () => {
  // `0` disables the job sweep; here it would mean "keep settled third-party
  // content until someone notices, and never say that work is stuck", so it is
  // read as the shortest real bound instead.
  expect(inboundBodyRetention({ OPENSHAPEFORGE_INBOUND_BODY_MAX_AGE_DAYS: "0" }).maxAgeDays).toBe(1);
  for (const raw of ["", "-1", "nonsense", "1e9", "Infinity"]) {
    const bounded = inboundBodyRetention({ OPENSHAPEFORGE_INBOUND_BODY_MAX_AGE_DAYS: raw });
    expect(bounded.maxAgeDays).toBeGreaterThanOrEqual(1);
    expect(bounded.maxAgeDays).toBeLessThanOrEqual(MAX_INBOUND_BODY_MAX_AGE_DAYS);
  }
  expect(inboundBodyRetention({ OPENSHAPEFORGE_INBOUND_BODY_MAX_AGE_DAYS: "100000" }).maxAgeDays)
    .toBe(MAX_INBOUND_BODY_MAX_AGE_DAYS);
});

test("retention never outlives the bound it sits inside", () => {
  // Otherwise a settled delivery would be governed by a window the outer bound
  // has already passed, and the two would disagree about what is still kept.
  expect(inboundBodyRetention({
    OPENSHAPEFORGE_INBOUND_BODY_RETENTION_DAYS: "90",
    OPENSHAPEFORGE_INBOUND_BODY_MAX_AGE_DAYS: "7",
  })).toEqual({ retentionDays: 7, maxAgeDays: 7 });
});
