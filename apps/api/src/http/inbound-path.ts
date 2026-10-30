// SPDX-License-Identifier: BUSL-1.1
/**
 * Where an inbound registration is reachable.
 *
 * Its own module so the registration service (which PUBLISHES the path to a
 * plugin) and the route (which SERVES it) can share one spelling without the
 * registration service importing route code — and so a test can assert the two
 * agree.
 */
export const INBOUND_MOUNT_PATH = "/api/inbound";

export function inboundEndpointPath(endpointKey: string, endpointId: string): string {
  return `${INBOUND_MOUNT_PATH}/${encodeURIComponent(endpointKey)}/${encodeURIComponent(endpointId)}`;
}
