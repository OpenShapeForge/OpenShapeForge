// SPDX-License-Identifier: BUSL-1.1
import "server-only";

import { cache } from "react";
import { auth } from "@/lib/auth";

/**
 * Deduplicate session resolution during a single server render pass.
 *
 * The gated layout, the page it wraps, and any server helper below them all
 * want the same session. Wrapping auth() in React.cache() keeps that to one
 * Redis lookup per request instead of one per caller.
 */
export const getCachedSession = cache(async () => auth());
