// SPDX-License-Identifier: BUSL-1.1
/**
 * Egress policy for connections that are not requests.
 *
 * Everything outbound in this platform was modelled on `fetch`: an Adapter
 * grants HOSTNAMES (`egressHosts`), and `fetchValidatedOutbound` checks the
 * protocol and the hostname of a URL. A raw socket has neither a URL nor a
 * redirect chain, so a module that dialled IMAP, SMTP, LDAP or a database
 * travelled under no policy at all — the traffic left the process and nothing
 * decided whether it was allowed to. That is the gap this closes.
 *
 * The grant is deliberately a DIFFERENT shape from the HTTP one rather than a
 * looser reading of the same list:
 *
 *   "mail.example.com"        grants HTTPS to that host. It grants no socket.
 *   "mail.example.com:993"    grants a socket to that host on that port only.
 *                             It grants no HTTP, because `hostAllowed` compares
 *                             whole hostnames and a hostname never has a colon.
 *
 * So the two policies cannot leak into each other in either direction, and no
 * existing Adapter silently gains the right to open sockets. A port must be
 * named: "any port on this host" is not expressible, because the one thing a
 * reviewer should be able to read off an Adapter is exactly where it may
 * connect.
 *
 * `*.` and `**.` on the host half mean what they mean for HTTP.
 *
 * The dial itself lives here too. A module never calls `net.connect`: it asks
 * core, with a grant core minted for it, and core decides and then dials. That
 * ordering is the whole point — a check a module could skip is not a policy.
 */
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { isPublicAddress, resolveAddresses } from "./outbound-addresses.js";
import { hostAllowed } from "./egress.js";
import type { ModuleSocketGrant, ModuleSocketRequest } from "./contract.js";

/**
 * What a grant actually stands for. Kept off the grant object itself, so a
 * module holding one cannot read its allow-list, widen it, or forge another.
 */
type GrantState = {
  allowlist: readonly string[];
  adapterKey: string;
  adapterName: string;
  tenantId: string | null;
  /**
   * What ties a grant to the resolution that minted it. Only the HTTP path
   * reads this; the socket path stays bound by its caller's live session.
   */
  binding?: {
    session: TrustedSessionContext;
    connectionId: string;
    connectionTable: string;
    ownerUserId: string | null;
    expiresAtMs: number;
    /** Protected OAuth resource, when this Connection is resource-bound. */
    resource?: string;
  };
};

const grants = new WeakMap<ModuleSocketGrant, GrantState>();

/** Core-only. Mints the opaque grant handed out with a resolved Connection. */
export function mintSocketGrant(state: GrantState): ModuleSocketGrant {
  const grant = Object.freeze({}) as ModuleSocketGrant;
  grants.set(grant, {
    ...state,
    allowlist: Object.freeze([...state.allowlist]),
  });
  return grant;
}

/** Core-only. The policy behind a grant, for the host's own HTTP path. */
export function socketGrantState(grant: ModuleSocketGrant): Readonly<GrantState> | undefined {
  return grants.get(grant);
}

export class SocketEgressDenied extends Error {
  readonly code = "EGRESS_DENIED" as const;

  constructor(message: string) {
    super(message);
    this.name = "SocketEgressDenied";
  }
}

export class SocketUnavailable extends Error {
  readonly code = "EGRESS_UNAVAILABLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "SocketUnavailable";
  }
}

const PORT = /^(\d{1,5})$/;

/** Split "host:port" — and only that; a bare host grants no socket. */
function parseEntry(entry: string): { host: string; port: number } | undefined {
  const colon = entry.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const host = entry.slice(0, colon).trim().toLowerCase();
  const port = entry.slice(colon + 1).trim();
  if (!host || !PORT.test(port)) return undefined;
  const value = Number(port);
  if (value < 1 || value > 65535) return undefined;
  return { host, port: value };
}

/**
 * Whether an allow-list grants a socket to this host and port. Only entries
 * that NAME a port participate; a bare hostname is an HTTP grant and is
 * ignored here on purpose.
 */
export function socketAllowed(
  host: string,
  port: number,
  allowlist: readonly string[],
): boolean {
  const candidate = host.trim().toLowerCase();
  if (!candidate) return false;
  return allowlist.some((entry) => {
    const parsed = parseEntry(entry);
    if (!parsed || parsed.port !== port) return false;
    return hostAllowed(candidate, [parsed.host]);
  });
}

/** The socket grants an Adapter declares, for a refusal a person can act on. */
function grantedTargets(allowlist: readonly string[]): string[] {
  return allowlist
    .map(parseEntry)
    .filter((entry): entry is { host: string; port: number } => entry !== undefined)
    .map((entry) => `${entry.host}:${entry.port}`);
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The one deployment switch that lets a module's `rejectUnauthorized: false`
 * through. A module asking is not enough: the request is module code, and this
 * path exists to contain module mistakes.
 */
export const INSECURE_TLS_ENV = "OSF_SOCKET_EGRESS_ALLOW_INSECURE_TLS";

export type SocketEgressDependencies = {
  /** Injectable for tests; answers every address a name resolves to. */
  resolve?: (hostname: string) => Promise<readonly string[]>;
  /** Injectable for tests; defaults to the deployment's explicit opt-in. */
  allowInsecureTls?: boolean;
  /** Injectable for tests; the dial always receives a verified address. */
  dialPlain?: typeof netConnect;
  dialTls?: typeof tlsConnect;
};

/**
 * The allow-list names a host; the dial needs an address. Every answer must be
 * public, because the name is often tenant-influenced and DNS is not ours: an
 * allow-listed name that answers with a loopback, link-local or private address
 * would otherwise reach the deployment's own network. The verified answers are
 * what gets dialled, so a second lookup cannot answer differently.
 */
async function pinnedAddresses(
  host: string,
  port: number,
  resolve: NonNullable<SocketEgressDependencies["resolve"]>,
  deadlineMs: number,
): Promise<readonly string[]> {
  const literal = host.replace(/^\[|\]$/g, "");
  let addresses: readonly string[];
  if (isIP(literal) !== 0) {
    addresses = [literal];
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([
        resolve(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("name lookup timed out")), deadlineMs);
        }),
      ]);
    } catch (error) {
      throw new SocketUnavailable(
        `${host}:${port} could not be reached (${error instanceof Error ? error.message : "name lookup failed"}).`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (addresses.length === 0) {
      throw new SocketUnavailable(`${host}:${port} could not be reached (the name has no address).`);
    }
  }
  if (!addresses.every(isPublicAddress)) {
    throw new SocketEgressDenied(
      `Connecting to ${host}:${port} is not allowed: the host does not resolve to a public address.`,
    );
  }
  return [...new Set(addresses)];
}

/**
 * Decide, then dial. A refusal names the Adapter, the target, and what the
 * Adapter does grant — an administrator can fix the Adapter from the sentence
 * alone, which is the difference between this and a socket error.
 */
export async function connectSocket(
  grant: ModuleSocketGrant,
  request: ModuleSocketRequest,
  dependencies: SocketEgressDependencies = {},
): Promise<Socket | TLSSocket> {
  const state = grants.get(grant);
  if (!state) {
    throw new SocketEgressDenied(
      "This outbound connection carries no egress grant from the platform.",
    );
  }
  const host = String(request.host ?? "").trim();
  const port = Number(request.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SocketEgressDenied(
      "An outbound connection needs a host and a port between 1 and 65535.",
    );
  }
  if (!socketAllowed(host, port, state.allowlist)) {
    const granted = grantedTargets(state.allowlist);
    throw new SocketEgressDenied(
      `Connecting to ${host}:${port} is not allowed: the "${state.adapterKey}" Adapter ` +
        (granted.length > 0
          ? `may only connect to ${granted.join(", ")}. `
          : "grants no outbound connections at all. ") +
        `An administrator adds "${host}:${port}" to that Adapter's egress hosts if this is intended.`,
    );
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const addresses = await pinnedAddresses(
    host,
    port,
    dependencies.resolve ?? resolveAddresses,
    timeoutMs,
  );
  // Verification is on unless the deployment itself turned it off AND the
  // module asked. Either one alone leaves it on.
  const allowInsecureTls =
    dependencies.allowInsecureTls ?? process.env[INSECURE_TLS_ENV] === "1";
  const rejectUnauthorized = !(allowInsecureTls && request.rejectUnauthorized === false);
  // The certificate is checked against the name the module asked for, never
  // against the address we pinned. An IP literal has no SNI name.
  const servername = request.servername ?? (isIP(host.replace(/^\[|\]$/g, "")) === 0 ? host : undefined);
  const dialPlain = dependencies.dialPlain ?? netConnect;
  const dialTls = dependencies.dialTls ?? tlsConnect;

  const dial = (address: string, remainingMs: number) =>
    new Promise<Socket | TLSSocket>((resolve, reject) => {
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      const ready = () => {
        // Hand the socket over clean: the connect deadline and the failure
        // listener belong to the dial, not to the conversation that follows.
        socket.setTimeout(0);
        socket.off("error", fail);
        resolve(socket);
      };
      const socket: Socket | TLSSocket = request.tls
        ? dialTls(
            {
              host: address,
              port,
              ...(servername ? { servername } : {}),
              rejectUnauthorized,
            },
            ready,
          )
        : dialPlain({ host: address, port }, ready);
      socket.setTimeout(remainingMs, () => fail(new Error("connection timed out")));
      socket.once("error", fail);
    });

  // Any verified answer will do; the deadline covers the whole attempt.
  let last = new Error("connection timed out");
  for (const address of addresses) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      return await dial(address, remainingMs);
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new SocketUnavailable(`${host}:${port} could not be reached (${last.message}).`);
}
