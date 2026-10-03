// SPDX-License-Identifier: BUSL-1.1
import { HttpError } from "../rest/http-error.js";

type Rec = Record<string, unknown>;
export type AllPagesPlan = { cursorPath: string; maxPages: number; maxRecords: number };
const fail = (message: string) => new HttpError(502, "PAGINATION_INCOMPLETE", message);

/** Opt-in: existing single-page cursor capabilities retain their behavior. */
export function allPagesPlan(pagination: unknown, kind: unknown, transport: unknown, method: unknown): AllPagesPlan | null {
  const config = (pagination ?? {}) as Rec;
  if (config.mode !== "all") return null;
  if (config.style !== "nextLink" || kind !== "query" || transport !== "rest" || String(method).toUpperCase() !== "GET") {
    throw new HttpError(400, "OPERATION_MISCONFIGURED", "All-page collection requires a read-only REST GET with nextLink pagination.");
  }
  if (typeof config.cursorPath !== "string" || !/^(\$\.)?[\w]+(?:\.[\w]+)*$/.test(config.cursorPath)) {
    throw new HttpError(400, "OPERATION_MISCONFIGURED", "All-page collection needs a next-link response path.");
  }
  const maxPages = config.maxPages ?? 100, maxRecords = config.maxRecords ?? 10000;
  if (!Number.isInteger(maxPages) || Number(maxPages) < 1 || Number(maxPages) > 100 ||
      !Number.isInteger(maxRecords) || Number(maxRecords) < 1 || Number(maxRecords) > 10000) {
    throw new HttpError(400, "OPERATION_MISCONFIGURED", "Pagination limits must be 1–100 pages and 1–10000 records.");
  }
  return { cursorPath: config.cursorPath, maxPages: Number(maxPages), maxRecords: Number(maxRecords) };
}

/** No partial result escapes: failed or truncated reads never reach a writer. */
export async function collectMappedPages(input: {
  firstUrl: URL;
  plan: AllPagesPlan;
  signal?: AbortSignal | undefined;
  fetchPage: (url: URL) => Promise<{ mapped: Rec; nextLink: unknown; bytes: number }>;
}): Promise<Rec> {
  let url = input.firstUrl, count = 0, bytes = 0;
  const visited = new Set<string>(), result: Rec = Object.create(null);
  for (let page = 0; page < input.plan.maxPages; page++) {
    input.signal?.throwIfAborted();
    if (visited.has(url.href)) throw fail("The provider repeated a pagination link.");
    visited.add(url.href);
    const response = await input.fetchPage(url);
    input.signal?.throwIfAborted();
    bytes += response.bytes;
    if (bytes > 20 * 1024 * 1024) throw fail("Paginated response exceeds 20 MiB.");
    for (const [key, value] of Object.entries(response.mapped)) {
      if (!Array.isArray(value)) throw fail("All-page outputs must be collections.");
      count += value.length;
      if (count > input.plan.maxRecords) throw fail("Paginated response exceeds its record limit.");
      result[key] = [...((result[key] ?? []) as unknown[]), ...value];
    }
    if (response.nextLink === undefined || response.nextLink === null || response.nextLink === "") return result;
    if (typeof response.nextLink !== "string") throw fail("Provider returned an invalid pagination link.");
    let next: URL;
    try { next = new URL(response.nextLink, url); } catch { throw fail("Provider returned an invalid pagination link."); }
    // A cursor cannot redirect credentials, change administration/endpoint or downgrade TLS.
    if (next.origin !== input.firstUrl.origin || next.pathname !== input.firstUrl.pathname || next.username || next.password || next.hash) {
      throw new HttpError(403, "EGRESS_DENIED", "Pagination must remain on the original origin and endpoint.");
    }
    url = next;
  }
  throw fail("Provider returned more pages than the configured limit.");
}
