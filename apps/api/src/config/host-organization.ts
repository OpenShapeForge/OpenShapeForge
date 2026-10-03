// SPDX-License-Identifier: BUSL-1.1
/** Read per call so test environments and independently composed hosts cannot cache mode. */
export function usesHostOrganizationContext(): boolean {
  return process.env.OPENSHAPEFORGE_ORGANIZATION_CONTEXT === "host";
}

export function hostMcpResource(): string {
  const value = process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN;
  if (!value) throw new Error("Host organization mode requires OPENSHAPEFORGE_PUBLIC_ORIGIN");
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error("Host organization mode requires a canonical public origin");
  }
  return `${url.origin}/api/mcp`;
}
