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
    getUser: async () => ({ id_token: "test-id-token" }),
    removeUser: async () => { actions.push("remove"); },
    signoutRedirect: async args => { callbackState = args.state; actions.push(["logout", args.state.returnTo]); },
    signoutRedirectCallback: async () => { actions.push("validated-callback"); return { state: "opaque-id", userState: callbackState }; },
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

test("failed, missing and foreign callback data cannot choose the return route or create a loop", async () => {
  for (const callback of [async () => { throw new Error("state rejected"); }, async () => ({ state: "opaque-id" }),
    async () => ({ state: "opaque-id", userState: { kind: "rejected-web-session", returnTo: "https://evil.invalid" } })]) {
    const { manager, store, actions } = fixture();
    await restartRejectedWebSession(manager, "/relations", store);
    manager.signoutRedirectCallback = callback;
    expect(await completeRejectedWebSessionLogout(manager, "https://app.invalid/?state=forged", store,
      path => { actions.push(["replace", path]); })).toBe(true);
    expect(actions).toEqual([["logout", "/relations"], "remove", ["replace", "/relations"], ["login", "/relations"]]);
    expect(await restartRejectedWebSession(manager, "/relations", store)).toBe(false);
  }
});

test("an absent ID token restarts login without a provider logout confirmation", async () => {
  const { manager, store, actions } = fixture(); manager.getUser = async () => null;
  expect(await restartRejectedWebSession(manager, "/relations", store)).toBe(true);
  expect(actions).toEqual(["remove", ["login", "/relations"]]);
});

test("a corrupt local marker is discarded without trapping application startup", async () => {
  const { manager, store } = fixture(); store.setItem("osf.web-session-recovery.v1", "broken");
  expect(await completeRejectedWebSessionLogout(manager, "https://app.invalid/?state=x", store)).toBe(false);
  expect(store.getItem("osf.web-session-recovery.v1")).toBeNull();
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
