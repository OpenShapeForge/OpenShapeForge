// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { ModuleSocketGrant } from "../contract.js";
import {
  connectSocket,
  mintSocketGrant,
  type SocketEgressDependencies,
} from "../socket-egress.js";

type Dial = { host?: string; port?: number; servername?: string; rejectUnauthorized?: boolean };

function grant(allowlist: string[]): ModuleSocketGrant {
  return mintSocketGrant({
    allowlist,
    adapterKey: "mailbox",
    adapterName: "mailbox",
    tenantId: "11111111-1111-4111-8111-111111111111",
  });
}

/** A dialer that records where it was sent and connects (or fails) at once. */
function recorder(failing: readonly string[] = []) {
  const dials: Dial[] = [];
  const dial = (options: Dial, ready: () => void) => {
    dials.push(options);
    const socket = Object.assign(new EventEmitter(), {
      setTimeout: () => socket,
      destroy: () => socket,
    });
    queueMicrotask(() => {
      if (failing.includes(String(options.host))) socket.emit("error", new Error("refused"));
      else ready();
    });
    return socket;
  };
  const dependencies: SocketEgressDependencies = {
    dialPlain: dial as never,
    dialTls: dial as never,
  };
  return { dials, dependencies };
}

const resolvesTo = (...addresses: string[]) => async () => addresses;

describe("socket egress address pinning", () => {
  it("dials the verified address, not the name, and keeps the name for TLS", async () => {
    const { dials, dependencies } = recorder();
    await connectSocket(
      grant(["mail.example.com:993"]),
      { host: "mail.example.com", port: 993, tls: true },
      { ...dependencies, resolve: resolvesTo("93.184.216.34") },
    );
    expect(dials).toEqual([
      { host: "93.184.216.34", port: 993, servername: "mail.example.com", rejectUnauthorized: true },
    ]);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["cloud metadata", "169.254.169.254"],
    ["private", "10.0.0.8"],
    ["IPv6 loopback", "::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
  ])("refuses an allow-listed name that resolves to a %s address", async (_label, address) => {
    const { dials, dependencies } = recorder();
    await expect(
      connectSocket(
        grant(["mail.example.com:993"]),
        { host: "mail.example.com", port: 993, tls: false },
        { ...dependencies, resolve: resolvesTo(address) },
      ),
    ).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(dials).toEqual([]);
  });

  it("refuses when any one answer is non-public", async () => {
    const { dials, dependencies } = recorder();
    await expect(
      connectSocket(
        grant(["mail.example.com:993"]),
        { host: "mail.example.com", port: 993, tls: false },
        { ...dependencies, resolve: resolvesTo("93.184.216.34", "10.0.0.8") },
      ),
    ).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(dials).toEqual([]);
  });

  it("refuses an allow-listed non-public IP literal without a lookup", async () => {
    const { dials, dependencies } = recorder();
    let lookups = 0;
    await expect(
      connectSocket(
        grant(["169.254.169.254:80"]),
        { host: "169.254.169.254", port: 80, tls: false },
        { ...dependencies, resolve: async () => (lookups++, ["93.184.216.34"]) },
      ),
    ).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(lookups).toBe(0);
    expect(dials).toEqual([]);
  });

  it("tries the next verified address when one is unreachable", async () => {
    const { dials, dependencies } = recorder(["93.184.216.34"]);
    await connectSocket(
      grant(["mail.example.com:993"]),
      { host: "mail.example.com", port: 993, tls: false },
      { ...dependencies, resolve: resolvesTo("93.184.216.34", "93.184.216.35") },
    );
    expect(dials.map((dial) => dial.host)).toEqual(["93.184.216.34", "93.184.216.35"]);
  });

  it("reports an unresolvable name as unavailable, not denied", async () => {
    const { dependencies } = recorder();
    await expect(
      connectSocket(
        grant(["mail.example.com:993"]),
        { host: "mail.example.com", port: 993, tls: false },
        { ...dependencies, resolve: async () => { throw new Error("ENOTFOUND"); } },
      ),
    ).rejects.toMatchObject({ code: "EGRESS_UNAVAILABLE" });
  });

  it("still refuses a target the Adapter does not grant before any lookup", async () => {
    const { dependencies } = recorder();
    let lookups = 0;
    await expect(
      connectSocket(
        grant(["mail.example.com:993"]),
        { host: "other.example.com", port: 993, tls: false },
        { ...dependencies, resolve: async () => (lookups++, ["93.184.216.34"]) },
      ),
    ).rejects.toMatchObject({ code: "EGRESS_DENIED" });
    expect(lookups).toBe(0);
  });
});

describe("socket egress TLS verification", () => {
  const request = {
    host: "mail.example.com",
    port: 993,
    tls: true,
    rejectUnauthorized: false,
  } as const;

  it("ignores a module's request to skip verification by default", async () => {
    const { dials, dependencies } = recorder();
    await connectSocket(grant(["mail.example.com:993"]), request, {
      ...dependencies,
      resolve: resolvesTo("93.184.216.34"),
      allowInsecureTls: false,
    });
    expect(dials[0]?.rejectUnauthorized).toBe(true);
  });

  it("honours it only when the deployment opted in", async () => {
    const { dials, dependencies } = recorder();
    await connectSocket(grant(["mail.example.com:993"]), request, {
      ...dependencies,
      resolve: resolvesTo("93.184.216.34"),
      allowInsecureTls: true,
    });
    expect(dials[0]?.rejectUnauthorized).toBe(false);
  });

  it("keeps verification on when the deployment opted in but the module did not ask", async () => {
    const { dials, dependencies } = recorder();
    await connectSocket(
      grant(["mail.example.com:993"]),
      { host: "mail.example.com", port: 993, tls: true },
      { ...dependencies, resolve: resolvesTo("93.184.216.34"), allowInsecureTls: true },
    );
    expect(dials[0]?.rejectUnauthorized).toBe(true);
  });

  it("reads the deployment opt-in from the environment", async () => {
    const name = "OSF_SOCKET_EGRESS_ALLOW_INSECURE_TLS";
    const previous = process.env[name];
    try {
      for (const [value, expected] of [[undefined, true], ["true", true], ["1", false]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
        const { dials, dependencies } = recorder();
        await connectSocket(grant(["mail.example.com:993"]), request, {
          ...dependencies,
          resolve: resolvesTo("93.184.216.34"),
        });
        expect(dials[0]?.rejectUnauthorized).toBe(expected);
      }
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
});
