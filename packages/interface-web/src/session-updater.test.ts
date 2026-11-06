// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { createWebSessionUpdater } from "./session-updater.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function fixture() {
  const states: Array<string | undefined> = [];
  const pending: Array<ReturnType<typeof deferred<string>>> = [];
  const updater = createWebSessionUpdater<{ login?: string }, string>({
    sessionKey: user => user.login,
    resolve: () => { const next = deferred<string>(); pending.push(next); return next.promise; },
    update: value => states.push(value),
  });
  return { updater, states, pending };
}
test("same verified login and scope remain mounted until replacement admission", async () => {
  const f = fixture();
  const first = f.updater.set({ login: "one" }, "tenant-a");
  f.pending[0]!.resolve("old-token"); await first;
  const renewed = f.updater.set({ login: "one" }, "tenant-a");
  expect(f.states).toEqual([undefined, "old-token"]);
  f.pending[1]!.resolve("new-token"); await renewed;
  expect(f.states).toEqual([undefined, "old-token", "new-token"]);
});
test("logout, changed login, absent login binding and tenant change clear immediately", async () => {
  for (const [user, scope] of [[undefined, "tenant-a"], [{ login: "two" }, "tenant-a"], [{}, "tenant-a"], [{ login: "one" }, "tenant-b"]] as const) {
    const f = fixture(); const first = f.updater.set({ login: "one" }, "tenant-a");
    f.pending[0]!.resolve("old"); await first;
    const changed = f.updater.set(user, scope);
    expect(f.states.at(-1)).toBeUndefined();
    f.pending[1]?.resolve("replacement"); await changed;
  }
});
test("stale successes and failures cannot replace or reject a newer login", async () => {
  for (const reject of [false, true]) {
    const f = fixture();
    const first = f.updater.set({ login: "old" });
    const second = f.updater.set({ login: "new" });
    f.pending[1]!.resolve("new"); await second;
    if (reject) f.pending[0]!.reject(Error("stale login rejected")); else f.pending[0]!.resolve("old");
    await first;
    expect(f.states.at(-1)).toBe("new");
  }
});
test("current rejection reaches the host; closing prevents all later updates", async () => {
  const f = fixture(); const rejected = f.updater.set({ login: "one" });
  f.pending[0]!.reject(Error("current login rejected"));
  await expect(rejected).rejects.toThrow("current login rejected");
  const closing = f.updater.set({ login: "two" }); f.updater.close();
  const count = f.states.length; f.pending[1]!.resolve("late"); await closing;
  await f.updater.set({ login: "three" });
  expect(f.states).toHaveLength(count); expect(f.pending).toHaveLength(2);
});
