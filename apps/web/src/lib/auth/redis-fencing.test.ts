// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import {
  SESSION_ATOMIC_COMMAND_KEY_COUNT as adminKeyCount,
  SESSION_COMPARE_AND_SET_SCRIPT as adminCompareAndSet,
  SESSION_GET_AND_DELETE_SCRIPT as adminGetAndDelete,
} from "../../../../admin/src/lib/auth/redis";
import {
  SESSION_ATOMIC_COMMAND_KEY_COUNT as webKeyCount,
  SESSION_COMPARE_AND_SET_SCRIPT as webCompareAndSet,
  SESSION_GET_AND_DELETE_SCRIPT as webGetAndDelete,
} from "./redis";

test("session fencing commands remain single-key Redis Cluster operations", () => {
  for (const command of [
    { keyCount: webKeyCount, script: webCompareAndSet },
    { keyCount: webKeyCount, script: webGetAndDelete },
    { keyCount: adminKeyCount, script: adminCompareAndSet },
    { keyCount: adminKeyCount, script: adminGetAndDelete },
  ]) {
    expect(command.keyCount).toBe(1);
    expect(command.script).toContain("KEYS[1]");
    expect(command.script).not.toContain("KEYS[2]");
  }

  expect(webCompareAndSet).toContain("redis.call('get'");
  expect(webCompareAndSet).toContain("redis.call('set'");
  expect(webGetAndDelete).toContain("redis.call('del'");
  expect(adminCompareAndSet).toBe(webCompareAndSet);
  expect(adminGetAndDelete).toBe(webGetAndDelete);
});
