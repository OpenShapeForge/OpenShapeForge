// SPDX-License-Identifier: BUSL-1.1
/**
 * The address half of outbound policy, shared by every path that leaves the
 * process. An allow-list names hosts, and a name is not a destination: DNS for
 * an allow-listed name can answer with a loopback, link-local or private
 * address. Core therefore resolves the name itself, refuses any non-public
 * answer, and hands the checked addresses to whoever dials.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const NON_PUBLIC_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const;
// Inside global unicast, but reserved or a tunnel to an embedded IPv4 address.
const NON_PUBLIC_V6 = [["2001::", 23], ["2001:db8::", 32], ["2002::", 16]] as const;

function ipv4Bits(address: string): bigint {
  return address.split(".").reduce((bits, octet) => (bits << 8n) | BigInt(octet), 0n);
}

/** Expects a validated address without a zone or an embedded dotted quad. */
function ipv6Bits(address: string): bigint {
  const [head, tail] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const elided = new Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...elided, ...right].reduce(
    (bits, group) => (bits << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function inNetwork(bits: bigint, network: bigint, prefix: number, width: 32 | 128): boolean {
  const host = BigInt(width - prefix);
  return bits >> host === network >> host;
}

/**
 * IPv6 is an allow-list on purpose: loopback, link-local, unique-local,
 * multicast, NAT64 and every IPv4-mapped form sit outside 2000::/3. Anything
 * that does not parse as a plain address is not public.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bits = ipv4Bits(address);
    return !NON_PUBLIC_V4.some(([network, prefix]) => inNetwork(bits, ipv4Bits(network), prefix, 32));
  }
  if (family !== 6 || /[.%]/.test(address)) return false;
  const bits = ipv6Bits(address);
  return inNetwork(bits, ipv6Bits("2000::"), 3, 128) &&
    !NON_PUBLIC_V6.some(([network, prefix]) => inNetwork(bits, ipv6Bits(network), prefix, 128));
}

export async function resolveAddresses(hostname: string): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

export type AddressResolver = (hostname: string) => Promise<readonly string[]>;

/** Why a host has no address core is willing to hand to a dialer. */
export class OutboundAddressError extends Error {
  constructor(readonly reason: "unresolvable" | "non_public") {
    super(reason === "non_public"
      ? "The outbound host does not resolve to a public address."
      : "The outbound host could not be resolved.");
    this.name = "OutboundAddressError";
  }
}

/**
 * Every address a host answers with, all of them public. One non-public answer
 * refuses the host: a client may dial any of them. IP literals skip the lookup.
 */
export async function verifiedPublicAddresses(
  hostname: string,
  resolve: AddressResolver = resolveAddresses,
): Promise<readonly string[]> {
  const literal = hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly string[];
  if (isIP(literal) !== 0) {
    addresses = [literal];
  } else {
    try {
      addresses = await resolve(literal);
    } catch {
      throw new OutboundAddressError("unresolvable");
    }
    if (addresses.length === 0) throw new OutboundAddressError("unresolvable");
  }
  if (!addresses.every(isPublicAddress)) throw new OutboundAddressError("non_public");
  return [...new Set(addresses)];
}
