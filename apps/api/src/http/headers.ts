// SPDX-License-Identifier: BUSL-1.1
/**
 * Converts Fastify's raw header record into a WHATWG Headers instance so
 * fetch-oriented consumers (GraphQL Yoga, resolveSessionContext) can read
 * them uniformly. Shared by the GraphQL route and the generated REST routes.
 */
export function headersFromFastify(
  headers: Record<string, string | string[] | undefined>,
) {
  const result = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
      continue;
    }
    if (value !== undefined) {
      result.set(key, value);
    }
  }

  return result;
}
