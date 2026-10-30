// SPDX-License-Identifier: BUSL-1.1
/**
 * The job kind an admitted inbound delivery is dispatched under.
 *
 * Its own module so the store (which enqueues) and the handler (which runs)
 * can share the literal without importing each other.
 */
export const INBOUND_DISPATCH_KIND = "osf-inbound.dispatch";
