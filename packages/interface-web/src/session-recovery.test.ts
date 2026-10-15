// SPDX-License-Identifier: BUSL-1.1
import { test, expect } from "bun:test";
import { restartRejectedWebSession, completeRejectedWebSessionLogout, clearRejectedWebSessionRestart, type SessionRecoveryManager } from "./session-recovery.js";

function fixture() {
  const values = new Map<string, string>();
  const store = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  const actions: unknown[] = [];
  let callbackState: unknown;
  const manager: SessionRecoveryManager = {
    removeUser: async () => { actions.push("remove"); },
    signoutRedirect: async args => { callbackState = args.state; actions.push(["logout", args.state.returnTo]); },
    signoutRedirectCallback: async () => { actions.push("validated-callback"); return { state: callbackState }; },
    signinRedirect: async args => { actions.push(["login", args.state.returnTo]); },
  };
  return { store, manager, actions };
}

test("provider logout precedes fresh login, preserves the route and bounds retries", async () => {
  const { manager, store, actions } = fixture();
  expect(await restartRejectedWebSession(manager, "/relations?group=customers", store)).toBe(true);
  expect(actions).toEqual([["logout", "/relations?group=customers"]]);
  expect(await completeRejectedWebSessionLogout(manager, "https://app.invalid/?state=opaque", store,
    path => { actions.push(["replace", path]); })).toBe(true);
  expect(actions).toEqual([["logout", "/relations?group=customers"], "validated-callback",
    ["replace", "/relations?group=customers"], ["login", "/relations?group=customers"]]);
  expect(await restartRejectedWebSession(manager, "/relations?group=customers", store)).toBe(false);
  expect(actions.at(-1)).toBe("remove");
  clearRejectedWebSessionRestart(store);
  expect(await restartRejectedWebSession(manager, "/relations", store)).toBe(true);
});

test("invalid and foreign return routes never start logout", async () => {
  for (const path of ["https://evil.invalid", "//evil.invalid", "/\\evil.invalid", "/\n/evil.invalid", "relative"]) {
    const { manager, store, actions } = fixture();
    await expect(restartRejectedWebSession(manager, path, store)).rejects.toThrow("local application path");
    expect(actions).toEqual([]);
  }
});

test("a failed or mismatched logout callback never signs in", async () => {
  const { manager, store, actions } = fixture();
  await restartRejectedWebSession(manager, "/relations", store);
  manager.signoutRedirectCallback = async () => { throw new Error("state rejected"); };
  await expect(completeRejectedWebSessionLogout(manager, "https://app.invalid/?state=forged", store)).rejects.toThrow("state rejected");
  manager.signoutRedirectCallback = async () => ({ state: { kind: "rejected-web-session", returnTo: "/other" } });
  await expect(completeRejectedWebSessionLogout(manager, "https://app.invalid/?state=other", store)).rejects.toThrow("Unexpected logout");
  expect(actions).toEqual([["logout", "/relations"]]);
});

test("ordinary sign-in callbacks and logout outages never create redirect loops", async () => {
  const { manager, store, actions } = fixture();
  expect(await completeRejectedWebSessionLogout(manager, "https://app.invalid/?state=unrelated", store)).toBe(false);
  manager.signoutRedirect = async () => { throw new Error("provider unavailable"); };
  await expect(restartRejectedWebSession(manager, "/relations", store)).rejects.toThrow("provider unavailable");
  expect(await restartRejectedWebSession(manager, "/relations", store)).toBe(false);
  expect(await completeRejectedWebSessionLogout(manager, "https://app.invalid/signin-callback?state=x&code=y", store)).toBe(false);
  expect(actions).toEqual(["remove", "remove"]);
});
