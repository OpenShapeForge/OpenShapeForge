// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, mock, test } from "bun:test";
import type { NextAuthConfig, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import type { StoredSession } from "./store.js";

// Exercise the real callbacks and Redis store while controlling command
// completion. The stand-in applies each command before releasing its reply.
const records = new Map<string, string>();
const commands: Array<{ key: string; args: Array<string | number> }> = [];
let readGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let readStarted: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let writeGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let writeStarted: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let config: NextAuthConfig;
class RedisFixture {
  on() {}
  disconnect() {}
  async set(key: string, value: string, ...args: Array<string | number>) {
    commands.push({ key, args });
    if (args.includes("XX") && !records.has(key)) return null;
    if (args.includes("NX") && records.has(key)) return null;
    records.set(key, value);
    if (writeGate && key.includes(":session:")) {
      const gate = writeGate; writeGate = undefined;
      writeStarted?.resolve(); await gate.promise;
    }
    return "OK";
  }
  async get(key: string) {
    const value = records.get(key) ?? null;
    if (readGate) {
      const gate = readGate; readGate = undefined;
      readStarted?.resolve(); await gate.promise;
    }
    return value;
  }
  async del(key: string) { return records.delete(key) ? 1 : 0; }
  async eval(_script: string, _count: number, key: string, owner: string) {
    return records.get(key) === owner ? this.del(key) : 0;
  }
}
mock.module("ioredis", () => ({ Redis: RedisFixture, Cluster: RedisFixture }));
mock.module("next-auth", () => ({ default: (value: NextAuthConfig) => {
  config = value;
  return { handlers: {}, signIn: async () => {}, signOut: async () => {}, auth: async () => null };
} }));
const { createSessionStore } = await import("./store.js");
const { createSessionAuth } = await import("./next-auth.js");
const { createLogoutHandler } = await import("./logout.js");

afterEach(() => {
  records.clear(); commands.length = 0;
  readGate = undefined; readStarted = undefined;
  writeGate = undefined; writeStarted = undefined;
});
const now = () => Math.floor(Date.now() / 1000);
const jwt = (claims: object) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
const sessionKey = "logout-race:session:s1";
const stored = (): StoredSession => ({
  sub: "person", accessToken: jwt({ sub: "person", name: "Hydrated Person", exp: now() + 300 }),
  expiresAt: now() + 300, refreshExpiresAt: now() + 3600, roles: ["reader"],
});
function harness() {
  const store = createSessionStore({ keyPrefix: "logout-race", logTag: "test" });
  createSessionAuth({
    logTag: "test", cookiePrefix: "test", store,
    keycloak: {
      issuer: "https://identity.example.test/realms/app", issuerInternal: "https://identity.example.test/realms/app",
      clientId: "app", clientSecret: "synthetic", authSecret: "synthetic", providers: [],
      logoutUrl: "https://identity.example.test/realms/app/protocol/openid-connect/logout",
    },
    admit: () => true, initialFields: () => ({}), sessionFields: () => ({}),
    refreshInvariant: () => undefined, refreshedFields: () => ({}),
  });
  const callbacks = config.callbacks!;
  let signedOut = false;
  const logout = createLogoutHandler({
    logTag: "test", keycloak: { logoutUrl: "https://identity.example.test/logout", clientId: "app" },
    auth: async () => ({ sessionId: "s1", expires: "2099-01-01", sub: "person", accessToken: "", idToken: "", roles: [] }),
    deleteSession: store.deleteSession, signOut: async () => { signedOut = true; },
  });
  const hydrate = () => callbacks.session!({
    session: { user: {}, expires: "2099-01-01", sub: "", accessToken: "", idToken: "", roles: [] }, token: { sessionId: "s1" },
  } as unknown as Parameters<NonNullable<NonNullable<NextAuthConfig["callbacks"]>["session"]>>[0]) as Promise<Session>;
  return { store, logout, hydrate, signedOut: () => signedOut };
}

test("profile hydration read before logout cannot restore the session or project its authority", async () => {
  const h = harness(); records.set(sessionKey, JSON.stringify(stored()));
  readGate = Promise.withResolvers<void>(); readStarted = Promise.withResolvers<void>();
  const release = readGate;
  const pending = h.hydrate(); await readStarted.promise;
  expect((await h.logout()).status).toBe(303);
  expect(h.signedOut()).toBe(true); expect(records.has(sessionKey)).toBe(false);
  release.resolve();
  const session = await pending;
  expect(session.error).toBe("RefreshTokenError");
  expect(Boolean(session.accessToken)).toBe(false);
  expect(records.has(sessionKey)).toBe(false);
  expect(await h.store.getSession("s1")).toBeNull();
});

test("a write applied before logout but acknowledged afterward cannot restore session authority", async () => {
  const h = harness(); records.set(sessionKey, JSON.stringify(stored()));
  writeGate = Promise.withResolvers<void>(); writeStarted = Promise.withResolvers<void>();
  const release = writeGate;
  const pending = h.hydrate(); await writeStarted.promise;
  expect((await h.logout()).status).toBe(303);
  expect(records.has(sessionKey)).toBe(false);
  release.resolve(); await pending;
  expect(records.has(sessionKey)).toBe(false);
  expect(await h.store.getSession("s1")).toBeNull();
});

test("logout in another store instance immediately invalidates a cached authenticated session", async () => {
  const proxy = harness();
  const route = harness();
  await proxy.store.setSession("s1", { ...stored(), name: "Hydrated Person" });
  expect((await proxy.hydrate()).accessToken.length > 0).toBe(true);
  expect((await route.logout()).status).toBe(303);
  expect(records.has(sessionKey)).toBe(false);
  const session = await proxy.hydrate();
  expect(session.error).toBe("RefreshTokenError");
  expect(Boolean(session.accessToken)).toBe(false);
});

test("initial sign-in creation remains separate from ordinary existing-session updates", async () => {
  const h = harness();
  const token = await config.callbacks!.jwt!({ token: { sub: "person" },
    account: { provider: "keycloak", type: "oidc", providerAccountId: "person", access_token: stored().accessToken,
      expires_at: now() + 300, refresh_token: "synthetic" },
    profile: { sub: "person", name: "Initial Person" },
  } as Parameters<NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>>[0]) as JWT;
  expect(typeof token.sessionId).toBe("string");
  expect(await h.store.getSession(token.sessionId as string)).not.toBeNull();
  expect(commands.at(-1)?.args).toEqual(["EX", 1800]);
  records.set(sessionKey, JSON.stringify(stored()));
  const hydrated = await h.hydrate();
  expect(hydrated.error).toBeUndefined(); expect(hydrated.user?.name).toBe("Hydrated Person");
  expect(commands.at(-1)?.args[0]).toBe("EX");
  expect(commands.at(-1)?.args[1]).toBeGreaterThan(3598);
  expect(commands.at(-1)?.args[1]).toBeLessThanOrEqual(3600);
  expect(commands.at(-1)?.args[2]).toBe("XX");
});

test("conditional update refuses a removed sid and keeps the normal TTL policy", async () => {
  const h = harness();
  expect(await h.store.updateSession("s1", stored())).toBe(false);
  expect(await h.store.getSession("s1")).toBeNull();
  await h.store.setSession("s1", { sub: "person", refreshExpiresAt: now() - 1 });
  expect(await h.store.updateSession("s1", { sub: "person", refreshExpiresAt: now() - 1 })).toBe(true);
  expect(commands.at(-1)?.args).toEqual(["EX", 60, "XX"]);
  expect(await h.store.updateSession("s1", { sub: "person" })).toBe(true);
  expect(commands.at(-1)?.args).toEqual(["EX", 1800, "XX"]);
});
